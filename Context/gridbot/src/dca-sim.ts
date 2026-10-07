// DCA verifier: the shipped strategy (runner.ts DCA books) on M30 gold.
// First entries on ATR(14)x1.9 step-grid, adds every adverse step (max 6),
// basket exit at avg +/- 0.5 step, disaster 8 steps, escape re-anchor.
// Run: npx tsx src/dca-sim.ts — full + folds + test must stay green.
import { loadCsv, resample } from "./market.js";
import { atr as appAtr, isUpBar as appIsUpBar } from "../../../src/lib/bot/engine.js";

const GOLD = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };
const EQUITY = 10000;
const LOT_OZ = 2; // 0.02 lots/leg
const DIS = 8;
const MULT = 1.9;
const ATR_LEN = 14;
const ADDS = 6;
const BSK = 0.5;

interface Leg {
  side: "buy" | "sell";
  entry: number;
  qty: number;
}
interface Book {
  side: "buy" | "sell";
  legs: Leg[];
  anchor: number;
}

export function runDca(m: { o: number[]; h: number[]; l: number[]; c: number[] }) {
  const bars = m.c.map((c, i) => ({ time: i, open: m.o[i], high: m.h[i], low: m.l[i], close: c }));
  if (bars.length < 300) return null;
  const seed = bars.slice(0, 120);
  const a = appAtr(seed as never, ATR_LEN);
  const atrAt = a[a.length - 1];
  if (atrAt == null || !Number.isFinite(atrAt) || (atrAt as number) <= 0) return null;
  const step = (atrAt as number) * MULT;
  let base = seed[seed.length - 1].close;
  let quote = EQUITY;
  const books: Book[] = [];
  const trades: { pnl: number; win: boolean }[] = [];
  let escapes = 0;
  let barDir: "up" | "down" = appIsUpBar(seed[seed.length - 1]) ? "up" : "down";
  let prev: number | null = null;
  const adv = (GOLD.spreadBps / 2 + GOLD.slippageBps) / 10000;
  const cm = GOLD.commissionBps / 10000;
  const ePx = (p: number, s: string) => (s === "buy" ? p * (1 + adv) : p * (1 - adv));
  const avg = (b: Book) => b.legs.reduce((s, l) => s + l.entry * l.qty, 0) / b.legs.reduce((s, l) => s + l.qty, 0);
  const qty = (b: Book) => b.legs.reduce((s, l) => s + l.qty, 0);
  const openBook = (side: "buy" | "sell", lvl: number) => {
    if (books.some((b) => b.side === side && Math.abs(b.anchor - lvl) < step * 0.49)) return;
    if (books.filter((b) => b.side === side).length >= 3) return;
    const ep = ePx(lvl, side);
    const not = LOT_OZ * ep;
    quote -= not * cm + not * adv;
    books.push({ side, legs: [{ side, entry: ep, qty: LOT_OZ }], anchor: lvl });
  };
  for (let bi = 120; bi < bars.length; bi++) {
    const bar = bars[bi];
    barDir = appIsUpBar(bars[bi - 1]) ? "up" : "down";
    const path = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
    for (const px of path) {
      if (prev === null) {
        prev = px;
        continue;
      }
      for (let i = books.length - 1; i >= 0; i--) {
        const b = books[i];
        const av = avg(b);
        const q = qty(b);
        const target = b.side === "buy" ? av + BSK * step : av - BSK * step;
        const stop = b.side === "buy" ? b.anchor - DIS * step : b.anchor + DIS * step;
        let shut: number | null = null;
        if (b.side === "buy") {
          if (px >= target) shut = target;
          else if (px <= stop) shut = stop;
        } else {
          if (px <= target) shut = target;
          else if (px >= stop) shut = stop;
        }
        if (shut !== null) {
          const x = ePx(shut, b.side);
          const not = q * x;
          const fee = not * cm + not * adv;
          const net = (b.side === "buy" ? x - av : av - x) * q - fee;
          quote += net;
          trades.push({ pnl: net, win: net > 0 });
          books.splice(i, 1);
        }
      }
      if (px < base - (ADDS + 2) * step || px > base + (ADDS + 2) * step) {
        escapes++;
        for (const b of books) {
          const av = avg(b);
          const q = qty(b);
          const x = ePx(px, b.side);
          const not = q * x;
          const fee = not * cm + not * adv;
          const net = (b.side === "buy" ? x - av : av - x) * q - fee;
          quote += net;
          trades.push({ pnl: net, win: net > 0 });
        }
        books.length = 0;
        base = px;
        prev = px;
        continue;
      }
      const sides = (barDir === "up" ? ["buy"] : ["sell"]) as ("buy" | "sell")[];
      for (const side of sides) {
        const lo = Math.min(prev, px);
        const hi = Math.max(prev, px);
        const j0 = side === "buy" ? Math.ceil((base - hi) / step) : Math.ceil((lo - base) / step);
        const j1 = side === "buy" ? Math.floor((base - lo) / step) : Math.floor((hi - base) / step);
        for (let j = Math.max(1, j0); j <= j1; j++) {
          openBook(side, side === "buy" ? base - j * step : base + j * step);
        }
      }
      for (const b of books) {
        if (b.legs.length - 1 >= ADDS) continue;
        const av = avg(b);
        const nextAt = b.side === "buy" ? av - step : av + step;
        const hit = b.side === "buy" ? prev > nextAt && px <= nextAt : prev < nextAt && px >= nextAt;
        if (!hit) continue;
        const ep = ePx(nextAt, b.side);
        const not = LOT_OZ * ep;
        quote -= not * cm + not * adv;
        b.legs.push({ side: b.side, entry: ep, qty: LOT_OZ });
      }
      prev = px;
    }
  }
  const wins = trades.filter((t) => t.win).length;
  const gw = trades.filter((t) => t.win).reduce((s, t) => s + t.pnl, 0);
  const gl = -trades.filter((t) => !t.win).reduce((s, t) => s + t.pnl, 0);
  return {
    ret: ((quote - EQUITY) / EQUITY) * 100,
    rt: trades.length,
    win: trades.length ? (wins / trades.length) * 100 : 0,
    pf: gl === 0 ? (gw > 0 ? Infinity : 0) : gw / gl,
    escapes,
  };
}

async function main() {
  const m30 = resample(await loadCsv("data/GC-1m.csv"), 30);
  const S = (o: number[], h: number[], l: number[], c: number[]) => ({ o, h, l, c });
  const cut = Math.floor(m30.c.length * 0.7);
  const TR = S(m30.o.slice(0, cut), m30.h.slice(0, cut), m30.l.slice(0, cut), m30.c.slice(0, cut));
  const TE = S(m30.o.slice(cut), m30.h.slice(cut), m30.l.slice(cut), m30.c.slice(cut));
  const fl = Math.floor(TR.c.length / 3);
  const F = (k: number) => S(TR.o.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), TR.h.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), TR.l.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), TR.c.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl));
  const fmt = (r: NonNullable<ReturnType<typeof runDca>>) =>
    `ret=${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(2)}% RT=${r.rt} win=${r.win.toFixed(1)}% PF=${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "inf"} esc=${r.escapes}`;
  const fr = [0, 1, 2].map((k) => runDca(F(k))!);
  console.log(`DCA-M30 folds: ${fr.map(fmt).join(" | ")}`);
  console.log(`DCA-M30 test: ${fmt(runDca(TE)!)}`);
  console.log(`DCA-M30 full: ${fmt(runDca(S(m30.o, m30.h, m30.l, m30.c))!)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Drawdown stop comparison: does maxDrawdownPct help or hurt?
// Tests the winner config (stack-m5e50+vol) with different DD halt levels.
// Run: npx tsx src/dd-stop-comparison.ts   (from Context/gridbot)
import { loadCsv, resample } from "./market.js";
import { writeFileSync } from "node:fs";

const GOLD = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };
const EQUITY = 10000;
const LOT_OZ = 2;
const ATR_LEN = 14;
const MULT = 2.0;
const SEED = 3100;

function emaArr(v: number[], p: number): number[] {
  const out = new Array(v.length).fill(NaN);
  const k = 2 / (p + 1);
  let e = v[0];
  for (let i = 0; i < v.length; i++) {
    e = i === 0 ? v[0] : v[i] * k + e * (1 - k);
    if (i + 1 >= p) out[i] = e;
  }
  return out;
}
function atrArr(h: number[], l: number[], c: number[], p: number): number[] {
  const n = c.length;
  const out = new Array(n).fill(NaN);
  const tr = new Array(n);
  for (let i = 0; i < n; i++)
    tr[i] = i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  let a = 0;
  for (let i = 0; i < n; i++) {
    if (i < p - 1) continue;
    if (i === p - 1) a = tr.slice(0, p).reduce((s, x) => s + x, 0) / p;
    else a = (a * (p - 1) + tr[i]) / p;
    out[i] = a;
  }
  return out;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Ctx {
  m1: { o: number[]; h: number[]; l: number[]; c: number[] };
  m1atr: number[];
  trendM5: (string | null)[];
  volOk: boolean[];
}

function buildCtx(m1: { o: number[]; h: number[]; l: number[]; c: number[] }): Ctx {
  const n = m1.c.length;
  const m1atr = atrArr(m1.h, m1.l, m1.c, ATR_LEN);
  const volOk = new Array(n).fill(true);
  for (let i = 0; i < n; i++) {
    if (i < 115 || !Number.isFinite(m1atr[i - 1])) { volOk[i] = true; continue; }
    const win: number[] = [];
    for (let k = i - 101; k < i - 1; k++) if (Number.isFinite(m1atr[k])) win.push(m1atr[k]);
    volOk[i] = win.length >= 100 ? m1atr[i - 1] > median(win) : true;
  }
  const m5 = resample(m1, 5);
  const e = emaArr(m5.c, 50);
  const trendM5: (string | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const hk = Math.floor(i / 5) - 1;
    if (hk < 0 || hk >= m5.c.length || !Number.isFinite(e[hk])) continue;
    trendM5[i] = m5.c[hk] >= e[hk]! ? "buy" : "sell";
  }
  return { m1, m1atr, trendM5, volOk };
}

interface Res {
  ret: number; rt: number; win: number; pf: number; dd: number;
  halted: boolean; haltBar: number; tradesAfterHalt: number;
}

function run(ctx: Ctx, maxDdPct: number, from: number, to: number): Res | null {
  const { m1, m1atr } = ctx;
  const n = Math.min(to, m1.c.length);
  if (from + 200 >= n) return null;
  if (from < SEED) from = SEED;
  const ADDS = 6, BSK = 0.5, ESC = 8, LEVELS = 10, STACK_LEGS = 5;
  let a0 = m1atr[from - 1];
  if (!Number.isFinite(a0) || a0 <= 0) return null;
  let step = a0 * MULT;
  let base = m1.c[from - 1];
  let quote = EQUITY;
  let peak = EQUITY;
  let dd = 0;
  let halted = false;
  let haltBar = -1;
  let tradesAfterHalt = 0;
  const books: { side: "buy" | "sell"; legs: { side: "buy" | "sell"; entry: number; qty: number }[]; anchor: number }[] = [];
  const trades: { pnl: number; win: boolean }[] = [];
  let prev: number | null = null;
  let lastStack = -1e9;
  const adv = (GOLD.spreadBps / 2 + GOLD.slippageBps) / 10000;
  const cm = GOLD.commissionBps / 10000;
  const ePx = (p: number, s: string) => (s === "buy" ? p * (1 + adv) : p * (1 - adv));
  const avg = (b: typeof books[0]) => b.legs.reduce((s, l) => s + l.entry * l.qty, 0) / b.legs.reduce((s, l) => s + l.qty, 0);
  const qty = (b: typeof books[0]) => b.legs.reduce((s, l) => s + l.qty, 0);
  const mtm = (px: number) => {
    let v = quote;
    for (const b of books) { const av = avg(b); v += (b.side === "buy" ? px - av : av - px) * qty(b); }
    return v;
  };
  const openBook = (side: "buy" | "sell", lvl: number, refPx: number) => {
    if (books.some((b) => b.side === side && Math.abs(b.anchor - lvl) < step * 0.49)) return;
    if (books.filter((b) => b.side === side).length >= 3) return;
    const ep = ePx(refPx, side);
    const not = LOT_OZ * ep;
    quote -= not * cm + not * adv;
    books.push({ side, legs: [{ side, entry: ep, qty: LOT_OZ }], anchor: lvl });
  };
  const shutBook = (i: number, px: number) => {
    const b = books[i];
    const av = avg(b), q = qty(b);
    const x = ePx(px, b.side);
    const not = q * x;
    const net = (b.side === "buy" ? x - av : av - x) * q - (not * cm + not * adv);
    quote += net;
    trades.push({ pnl: net, win: net > 0 });
    if (halted) tradesAfterHalt++;
    books.splice(i, 1);
  };
  const shutLeg = (b: typeof books[0], li: number, px: number) => {
    const leg = b.legs[li];
    const x = ePx(px, leg.side);
    const not = leg.qty * x;
    const net = (leg.side === "buy" ? x - leg.entry : leg.entry - x) * leg.qty - (not * cm + not * adv);
    quote += net;
    trades.push({ pnl: net, win: net > 0 });
    if (halted) tradesAfterHalt++;
    b.legs.splice(li, 1);
  };
  for (let bi = from; bi < n; bi++) {
    // DD halt check at bar open
    if (!halted && maxDdPct > 0) {
      const eq = mtm(m1.c[bi]);
      const ddNow = (peak - eq) / peak;
      if (ddNow * 100 >= maxDdPct) {
        halted = true;
        haltBar = bi;
        for (let i = books.length - 1; i >= 0; i--) shutBook(i, m1.c[bi]);
      }
    }
    const o = m1.o[bi], hh = m1.h[bi], ll = m1.c[bi], cc = m1.c[bi];
    const upPrev = m1.c[bi - 1] >= m1.o[bi - 1];
    const path = cc >= o ? [o, ll, hh, cc] : [o, hh, ll, cc];
    for (const px of path) {
      if (prev === null) { prev = px; continue; }
      if (halted) { prev = px; continue; }
      if (px < base - ESC * step || px > base + ESC * step) {
        for (let i = books.length - 1; i >= 0; i--) shutBook(i, px);
        base = px;
        const na = m1atr[bi];
        if (Number.isFinite(na) && na > 0) step = na * MULT;
        prev = px;
        continue;
      }
      for (let i = books.length - 1; i >= 0; i--) {
        const b = books[i];
        for (let li = b.legs.length - 1; li >= 0; li--) {
          const leg = b.legs[li];
          const tp = leg.side === "buy" ? leg.entry + step : leg.entry - step;
          if (leg.side === "buy" ? px >= tp : px <= tp) shutLeg(b, li, tp);
        }
        if (b.legs.length === 0) books.splice(i, 1);
      }
      for (let i = books.length - 1; i >= 0; i--) {
        const b = books[i];
        const av = avg(b);
        const target = b.side === "buy" ? av + BSK * step : av - BSK * step;
        if (b.side === "buy" ? px >= target : px <= target) shutBook(i, target);
      }
      if (books.length === 0 && bi - lastStack > 30 && ctx.volOk[bi]) {
        const t = ctx.trendM5[bi];
        const side = (t ?? (upPrev ? "buy" : "sell")) as "buy" | "sell";
        for (let k = 0; k < STACK_LEGS; k++) {
          if (k === 0) openBook(side, base, px);
          else {
            const bk = books.find((b) => b.side === side);
            if (bk && bk.legs.length - 1 < ADDS) {
              const ep = ePx(px, side);
              const not = LOT_OZ * ep;
              quote -= not * cm + not * adv;
              bk.legs.push({ side, entry: ep, qty: LOT_OZ });
            }
          }
        }
        lastStack = bi;
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
      const eq = mtm(px);
      if (eq > peak) peak = eq;
      const d = (peak - eq) / peak;
      if (d > dd) dd = d;
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
    dd: dd * 100,
    halted,
    haltBar,
    tradesAfterHalt,
  };
}

async function main() {
  const m1 = await loadCsv("data/GC-1m.csv");
  const ctx = buildCtx(m1);
  const cut = Math.floor(m1.c.length * 0.7);
  const fl = Math.floor((cut - SEED) / 3);
  const F = (k: number): [number, number] =>
    k === 0 ? [SEED, SEED + fl] : k === 1 ? [SEED + fl, SEED + 2 * fl] : [SEED + 2 * fl, cut];

  const ddLevels = [0, 5, 10, 15, 20];
  console.log("=== Drawdown stop comparison (stack-m5e50+vol) ===\n");
  console.log("maxDD% | f0 | f1 | f2 | worst | green | train | test | halt? | DD% | trades/halt");
  console.log("------|----|----|----|-------|-------|-------|-------|-------|----|----");

  const rows: Record<string, string | number>[] = [];
  for (const ddPct of ddLevels) {
    const fr = [0, 1, 2].map((k) => { const [a, b] = F(k); return run(ctx, ddPct, a, b); });
    const tr = run(ctx, ddPct, SEED, cut);
    const te = run(ctx, ddPct, cut, m1.c.length);
    const worstFold = Math.min(...fr.map((r) => r?.ret ?? -999));
    const green = fr.filter((r) => r && r.ret > 0).length;
    const halted = tr?.halted || false;
    const tradesPerHalt = te ? (te.tradesAfterHalt > 0 ? (te.rt / (te.halted ? 1 : 1)).toFixed(0) : "0") : "n/a";
    const fmt = (r: Res | null) => r === null ? "n/a" : `${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(1)}`;
    console.log(
      `${ddPct.toString().padStart(6)} | ${fr.map(fmt).join(" | ")} | ${worstFold >= 0 ? "+" : ""}${worstFold.toFixed(1)}% | ${green}/3 | ${fmt(tr)} | ${fmt(te)} | ${halted ? "YES" : "no"} | ${te?.dd.toFixed(1)}% | ${tradesPerHalt}`,
    );
    rows.push({
      maxDdPct: ddPct,
      f0: fr[0]?.ret.toFixed(1) ?? "n/a",
      f1: fr[1]?.ret.toFixed(1) ?? "n/a",
      f2: fr[2]?.ret.toFixed(1) ?? "n/a",
      worstFold: +worstFold.toFixed(1),
      greenFolds: green,
      train: tr?.ret.toFixed(1) ?? "n/a",
      test: te?.ret.toFixed(1) ?? "n/a",
      halted: halted ? "YES" : "no",
      testDD: te?.dd.toFixed(1) ?? "n/a",
      testPF: te && Number.isFinite(te.pf) ? +te.pf.toFixed(2) : -1,
      testWin: te ? +te.win.toFixed(1) : -1,
      testRT: te?.rt ?? -1,
    });
  }
  console.log("\nhalted = DD halt triggered on full train. trades/halt = total trades in test.");
  writeFileSync("dd-stop-results.json", JSON.stringify(rows, null, 2));
  console.log("wrote dd-stop-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

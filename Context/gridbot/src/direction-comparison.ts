// Counter-trend vs with-trend grid comparison.
// Tests: fade the move (buy dips / sell rallies) vs follow it (buy breakouts / sell breakdowns)
// plus the winner (bounce + M5 trend) as control.
// Run: npx tsx src/direction-comparison.ts   (from Context/gridbot)
import { loadCsv, resample } from "./market.js";
import { writeFileSync } from "node:fs";

const GOLD = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };
const EQUITY = 10000;
const LOT_OZ = 2;
const ATR_LEN = 14;
const MULT = 2.0;
const LEVELS = 10;
const ADDS = 6;
const BSK = 0.5;
const ESC_STEPS = ADDS + 2;
const LEG_TP = 1.0;
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

type EntryMode =
  | "bounce"      // longs on up-bars, shorts on down-bars (runner parity)
  | "antiBounce"  // REVERSED: longs on down-bars, shorts on up-bars (fade the move)
  | "both"        // both sides every bar (no bar filter)
  | "momentum";   // follow the move: longs on up-bars AND above M5 trend, shorts on down-bars AND below

interface Cfg { name: string; mode: EntryMode; useTrend: boolean; useVol: boolean }

const SWEEP: Cfg[] = [
  { name: "WINNER-bounce+m5+vol", mode: "bounce", useTrend: true, useVol: true },
  { name: "REVERSED-antiBounce+m5+vol", mode: "antiBounce", useTrend: true, useVol: true },
  { name: "antiBounce-nofilter", mode: "antiBounce", useTrend: false, useVol: false },
  { name: "bounce-nofilter", mode: "bounce", useTrend: false, useVol: false },
  { name: "both-nofilter", mode: "both", useTrend: false, useVol: false },
  { name: "momentum+m5+vol", mode: "momentum", useTrend: true, useVol: true },
];

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

interface Res { ret: number; rt: number; win: number; pf: number; dd: number; esc: number }

function run(ctx: Ctx, f: Cfg, from: number, to: number): Res | null {
  const { m1, m1atr } = ctx;
  const n = Math.min(to, m1.c.length);
  if (from + 200 >= n) return null;
  if (from < SEED) from = SEED;
  let a0 = m1atr[from - 1];
  if (!Number.isFinite(a0) || a0 <= 0) return null;
  let step = a0 * MULT;
  let base = m1.c[from - 1];
  let quote = EQUITY;
  let peak = EQUITY;
  let dd = 0;
  let escapes = 0;
  const books: { side: "buy" | "sell"; legs: { side: "buy" | "sell"; entry: number; qty: number }[]; anchor: number }[] = [];
  const trades: { pnl: number; win: boolean }[] = [];
  let prev: number | null = null;
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
    books.splice(i, 1);
  };
  const shutLeg = (b: typeof books[0], li: number, px: number) => {
    const leg = b.legs[li];
    const x = ePx(px, leg.side);
    const not = leg.qty * x;
    const net = (leg.side === "buy" ? x - leg.entry : leg.entry - x) * leg.qty - (not * cm + not * adv);
    quote += net;
    trades.push({ pnl: net, win: net > 0 });
    b.legs.splice(li, 1);
  };
  const sidesFor = (bi: number): ("buy" | "sell")[] => {
    const upPrev = m1.c[bi - 1] >= m1.o[bi - 1];
    let sides: ("buy" | "sell")[];
    if (f.mode === "bounce") sides = upPrev ? ["buy"] : ["sell"];
    else if (f.mode === "antiBounce") sides = upPrev ? ["sell"] : ["buy"];
    else sides = ["buy", "sell"];
    if (f.useTrend) {
      const t = ctx.trendM5[bi];
      if (t !== null) sides = sides.filter((s) => s === t);
    }
    if (f.mode === "momentum" && f.useTrend) {
      // momentum = only enter WITH the bar AND the trend (both must agree)
      const t = ctx.trendM5[bi];
      if (t === null) return [];
      const barSide = upPrev ? "buy" : "sell";
      if (barSide !== t) return [];
      sides = [t as "buy" | "sell"];
    }
    return sides;
  };
  for (let bi = from; bi < n; bi++) {
    const o = m1.o[bi], hh = m1.h[bi], ll = m1.c[bi], cc = m1.c[bi];
    const path = cc >= o ? [o, ll, hh, cc] : [o, hh, ll, cc];
    for (const px of path) {
      if (prev === null) { prev = px; continue; }
      if (px < base - ESC_STEPS * step || px > base + ESC_STEPS * step) {
        escapes++;
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
          const tp = leg.side === "buy" ? leg.entry + LEG_TP * step : leg.entry - LEG_TP * step;
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
      if (!f.useVol || ctx.volOk[bi]) {
        for (const side of sidesFor(bi)) {
          const lo = Math.min(prev, px), hi = Math.max(prev, px);
          const j0 = side === "buy" ? Math.ceil((base - hi) / step) : Math.ceil((lo - base) / step);
          const j1 = side === "buy" ? Math.floor((base - lo) / step) : Math.floor((hi - base) / step);
          for (let j = Math.max(1, j0); j <= Math.min(LEVELS, j1); j++)
            openBook(side, side === "buy" ? base - j * step : base + j * step, side === "buy" ? base - j * step : base + j * step);
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
    esc: escapes,
  };
}

async function main() {
  const m1 = await loadCsv("data/GC-1m.csv");
  console.log(`M1 bars=${m1.c.length}`);
  const ctx = buildCtx(m1);
  const cut = Math.floor(m1.c.length * 0.7);
  const fl = Math.floor((cut - SEED) / 3);
  const F = (k: number): [number, number] =>
    k === 0 ? [SEED, SEED + fl] : k === 1 ? [SEED + fl, SEED + 2 * fl] : [SEED + 2 * fl, cut];
  const fmt = (r: Res | null) =>
    r === null ? "n/a" : `ret=${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(1)}% RT=${r.rt} win=${r.win.toFixed(0)}% PF=${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "inf"} DD=${r.dd.toFixed(1)}% esc=${r.esc}`;
  const rows: Record<string, string | number>[] = [];
  for (const f of SWEEP) {
    const fr = [0, 1, 2].map((k) => { const [a, b] = F(k); return run(ctx, f, a, b); });
    const tr = run(ctx, f, SEED, cut);
    const te = run(ctx, f, cut, m1.c.length);
    const worstFold = Math.min(...fr.map((r) => r?.ret ?? -999));
    const green = fr.filter((r) => r && r.ret > 0).length;
    console.log(`\n[${f.name}] folds: ${fr.map(fmt).join(" | ")}`);
    console.log(`[${f.name}] TRAIN ${fmt(tr)} | TEST ${fmt(te)} | worst=${worstFold.toFixed(1)} green=${green}/3`);
    rows.push({
      config: f.name,
      f0: fr[0]?.ret.toFixed(1) ?? "n/a", f1: fr[1]?.ret.toFixed(1) ?? "n/a", f2: fr[2]?.ret.toFixed(1) ?? "n/a",
      worstFold: +worstFold.toFixed(1), greenFolds: green,
      train: tr?.ret.toFixed(1) ?? "n/a", test: te?.ret.toFixed(1) ?? "n/a",
      testPF: te && Number.isFinite(te.pf) ? +te.pf.toFixed(2) : -1,
      testWin: te ? +te.win.toFixed(1) : -1, testDD: te ? +te.dd.toFixed(1) : -1,
      testRT: te?.rt ?? -1,
    });
  }
  rows.sort((a, b) => (b.worstFold as number) - (a.worstFold as number));
  console.log("\n=== RANKED by worst-fold (maximin) ===");
  console.table(rows);
  writeFileSync("direction-comparison-results.json", JSON.stringify(rows, null, 2));
  console.log("wrote direction-comparison-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

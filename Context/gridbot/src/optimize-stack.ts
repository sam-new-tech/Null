// Coordinate-descent optimizer for the live stack config.
// Optimizes one parameter at a time (2 rounds), maximin selection on 3 train
// folds. Test set is held out until final validation. A param only changes
// if the new value is green on 3/3 folds AND beats the incumbent worst-fold.
// Run: npx tsx src/optimize-stack.ts   (from Context/gridbot)
import { loadCsv, resample } from "./market.js";
import { writeFileSync } from "node:fs";

const GOLD = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };
const EQUITY = 10000;
const LOT_OZ = 2;
const ATR_LEN = 14;
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

interface Params {
  mult: number; adds: number; basket: number; stackLegs: number;
  legTP: number; volLook: number; trendLen: number; escSteps: number;
}
const START: Params = { mult: 2.0, adds: 6, basket: 0.5, stackLegs: 5, legTP: 1.0, volLook: 100, trendLen: 50, escSteps: 8 };

interface Ctx {
  m1: { o: number[]; h: number[]; l: number[]; c: number[] };
  m1atr: number[];
  volOkCache: Map<number, boolean[]>;
  trendCache: Map<number, (string | null)[]>;
}
function buildCtx(m1: { o: number[]; h: number[]; l: number[]; c: number[] }): Ctx {
  const n = m1.c.length;
  return { m1, m1atr: atrArr(m1.h, m1.l, m1.c, ATR_LEN), volOkCache: new Map(), trendCache: new Map() };
}
function volOkFor(ctx: Ctx, look: number): boolean[] {
  const hit = ctx.volOkCache.get(look);
  if (hit) return hit;
  const { m1atr } = ctx;
  const n = m1atr.length;
  const out = new Array(n).fill(true);
  for (let i = 0; i < n; i++) {
    if (i < look + 15 || !Number.isFinite(m1atr[i - 1])) { out[i] = true; continue; }
    const win: number[] = [];
    for (let k = i - look - 1; k < i - 1; k++) if (Number.isFinite(m1atr[k])) win.push(m1atr[k]);
    out[i] = win.length >= look ? m1atr[i - 1] > median(win) : true;
  }
  ctx.volOkCache.set(look, out);
  return out;
}
function trendFor(ctx: Ctx, len: number): (string | null)[] {
  const hit = ctx.trendCache.get(len);
  if (hit) return hit;
  const { m1 } = ctx;
  const n = m1.c.length;
  const m5 = resample(m1, 5);
  const e = emaArr(m5.c, len);
  const out: (string | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const hk = Math.floor(i / 5) - 1;
    if (hk < 0 || hk >= m5.c.length || !Number.isFinite(e[hk])) continue;
    out[i] = m5.c[hk] >= e[hk]! ? "buy" : "sell";
  }
  ctx.trendCache.set(len, out);
  return out;
}

interface Res { ret: number; rt: number; win: number; pf: number; dd: number }

function run(ctx: Ctx, p: Params, from: number, to: number): Res | null {
  const { m1, m1atr } = ctx;
  const n = Math.min(to, m1.c.length);
  if (from + 200 >= n) return null;
  if (from < SEED) from = SEED;
  const volOk = volOkFor(ctx, p.volLook);
  const trend = trendFor(ctx, p.trendLen);
  let a0 = m1atr[from - 1];
  if (!Number.isFinite(a0) || a0 <= 0) return null;
  let step = a0 * p.mult;
  let base = m1.c[from - 1];
  let quote = EQUITY;
  let peak = EQUITY;
  let dd = 0;
  const books: { side: "buy" | "sell"; legs: { side: "buy" | "sell"; entry: number; qty: number }[]; anchor: number }[] = [];
  const trades: { pnl: number; win: boolean }[] = [];
  let prev: number | null = null;
  let lastStack = -1e9;
  const adv = (GOLD.spreadBps / 2 + GOLD.slippageBps) / 10000;
  const cm = GOLD.commissionBps / 10000;
  const ePx = (x: number, s: string) => (s === "buy" ? x * (1 + adv) : x * (1 - adv));
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
  for (let bi = from; bi < n; bi++) {
    const o = m1.o[bi], hh = m1.h[bi], ll = m1.c[bi], cc = m1.c[bi];
    const path = cc >= o ? [o, ll, hh, cc] : [o, hh, ll, cc];
    for (const px of path) {
      if (prev === null) { prev = px; continue; }
      if (px < base - p.escSteps * step || px > base + p.escSteps * step) {
        for (let i = books.length - 1; i >= 0; i--) shutBook(i, px);
        base = px;
        const na = m1atr[bi];
        if (Number.isFinite(na) && na > 0) step = na * p.mult;
        prev = px;
        continue;
      }
      for (let i = books.length - 1; i >= 0; i--) {
        const b = books[i];
        for (let li = b.legs.length - 1; li >= 0; li--) {
          const leg = b.legs[li];
          const tp = leg.side === "buy" ? leg.entry + p.legTP * step : leg.entry - p.legTP * step;
          if (leg.side === "buy" ? px >= tp : px <= tp) shutLeg(b, li, tp);
        }
        if (b.legs.length === 0) books.splice(i, 1);
      }
      for (let i = books.length - 1; i >= 0; i--) {
        const b = books[i];
        const av = avg(b);
        const target = b.side === "buy" ? av + p.basket * step : av - p.basket * step;
        if (b.side === "buy" ? px >= target : px <= target) shutBook(i, target);
      }
      if (books.length === 0 && bi - lastStack > 30 && volOk[bi]) {
        const t = trend[bi];
        if (t !== null) {
          for (let k = 0; k < p.stackLegs; k++) {
            if (k === 0) openBook(t as "buy" | "sell", base, px);
            else {
              const bk = books.find((b) => b.side === t);
              if (bk && bk.legs.length - 1 < p.adds) {
                const ep = ePx(px, t);
                const not = LOT_OZ * ep;
                quote -= not * cm + not * adv;
                bk.legs.push({ side: t as "buy" | "sell", entry: ep, qty: LOT_OZ });
              }
            }
          }
          lastStack = bi;
        }
      }
      for (const b of books) {
        if (b.legs.length - 1 >= p.adds) continue;
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

  const eval3 = (p: Params): { worst: number; green: number; rets: number[] } => {
    const rs = [0, 1, 2].map((k) => { const [a, b] = F(k); return run(ctx, p, a, b); });
    const rets = rs.map((r) => r?.ret ?? -999);
    return { worst: Math.min(...rets), green: rets.filter((r) => r > 0).length, rets };
  };

  let cur: Params = { ...START };
  let curEval = eval3(cur);
  console.log(`START ${JSON.stringify(cur)} worst=${curEval.worst.toFixed(1)} green=${curEval.green}/3 folds=${curEval.rets.map((r) => r.toFixed(1)).join("/")}`);

  const dims: { key: keyof Params; values: number[] }[] = [
    { key: "adds", values: [4, 5, 6, 7, 8, 9] },
    { key: "basket", values: [0.3, 0.4, 0.5, 0.6, 0.7] },
    { key: "mult", values: [1.6, 1.8, 2.0, 2.2, 2.4] },
    { key: "stackLegs", values: [2, 3, 4, 5, 6, 7, 8] },
    { key: "legTP", values: [0.5, 0.75, 1.0, 1.25, 1.5] },
    { key: "escSteps", values: [6, 7, 8, 9, 10] },
    { key: "volLook", values: [50, 75, 100, 150, 200] },
    { key: "trendLen", values: [20, 30, 50, 70, 100] },
  ];

  for (let round = 1; round <= 2; round++) {
    console.log(`\n--- ROUND ${round} ---`);
    let moved = false;
    for (const d of dims) {
      let bestV = cur[d.key];
      let bestWorst = curEval.worst;
      let bestGreen = curEval.green;
      for (const v of d.values) {
        if (v === cur[d.key]) continue;
        const trial = { ...cur, [d.key]: v };
        const e = eval3(trial);
        // accept only: 3/3 green AND strictly better worst-fold
        if (e.green === 3 && e.worst > bestWorst) {
          bestV = v; bestWorst = e.worst; bestGreen = e.green;
        }
      }
      if (bestV !== cur[d.key]) {
        cur = { ...cur, [d.key]: bestV };
        curEval = eval3(cur);
        moved = true;
        console.log(`  ${d.key}: ${cur[d.key]} (was ${(cur[d.key] === bestV ? "?" : cur[d.key])}) worst=${curEval.worst.toFixed(1)} green=${curEval.green}/3`);
      } else {
        console.log(`  ${d.key}: keep ${cur[d.key]} (no 3/3-green improver) worst=${curEval.worst.toFixed(1)}`);
      }
      void bestGreen;
    }
    if (!moved) { console.log("no moves — converged"); break; }
  }

  console.log(`\n=== OPTIMIZED ${JSON.stringify(cur)} ===`);
  console.log(`folds worst=${curEval.worst.toFixed(1)} green=${curEval.green}/3 rets=${curEval.rets.map((r) => r.toFixed(1)).join("/")}`);
  const te = run(ctx, cur, cut, m1.c.length);
  const tr = run(ctx, cur, SEED, cut);
  const fmt = (r: Res | null) => r ? `ret=${r.ret >= 0 ? "+" : ""}${r.ret.toFixed(1)}% RT=${r.rt} win=${r.win.toFixed(1)}% PF=${Number.isFinite(r.pf) ? r.pf.toFixed(2) : "inf"} DD=${r.dd.toFixed(1)}%` : "n/a";
  console.log(`TRAIN ${fmt(tr)}`);
  console.log(`TEST  ${fmt(te)}`);
  // OOS-2 sanity
  try {
    const m2 = await loadCsv("../../backtest/XAUUSD_M1.csv");
    const ctx2 = buildCtx(m2);
    console.log(`OOS-2 ${fmt(run(ctx2, cur, SEED, m2.c.length))}`);
  } catch (e) { console.log(`OOS-2 skipped: ${e instanceof Error ? e.message : e}`); }
  writeFileSync("optimize-results.json", JSON.stringify({ params: cur, folds: curEval, train: tr, test: te }, null, 2));
  console.log("wrote optimize-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

x// Grid+DCA filter sweep — finds the best first-entry filter with evidence.
//
// Engine: Grid first entries (ATR14 x2.0, 10 levels, M1 gold) + DCA books
// (max 3/side, adds every adverse step up to 6, basket exit avg ± 0.5 step,
// escape re-anchor beyond 8 steps with fresh ATR step). Adds/baskets/escapes
// are NEVER gated — only FIRST entries are, exactly like runner.ts
// (trendAllows/volAllows gate fresh placements only).
// Costs: commission 0.3 + spread 0.5 + slippage 0.3 bps, every fill.
// Splits: 3 folds on train (first 70%) + untouched test (last 30%).
// Indicators are causal per-bar (closed HTF bars only) — no lookahead.
//
// Run: npx tsx src/grid-dca-filter-sweep.ts   (from Context/gridbot)
import { loadCsv, resample } from "./market.js";
import { writeFileSync } from "node:fs";

const GOLD = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };
const EQUITY = 10000;
const LOT_OZ = 2;
const ATR_LEN = 14;
const MULT = 2.0; // live M1 gridMult
const LEVELS = 10;
const ADDS = 6;
const BSK = 0.5;
const ESC_STEPS = ADDS + 2; // 8
const LEG_TP = 1.0; // runner parity: every leg TPs at entry ± 1 step (opens server-side, adds tick-side)
const SEED = 3100; // covers H1 EMA50 + H1 ADX warmup causally

// ---------- pure causal indicators ----------
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
function adxArr(h: number[], l: number[], c: number[], p: number): number[] {
  const n = c.length;
  const out = new Array(n).fill(NaN);
  let sTR = 0, sPDM = 0, sMDM = 0;
  const dx: number[] = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    const pdm = up > dn && up > 0 ? up : 0;
    const mdm = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= p) { sTR += tr; sPDM += pdm; sMDM += mdm; }
    else { sTR = sTR - sTR / p + tr; sPDM = sPDM - sPDM / p + pdm; sMDM = sMDM - sMDM / p + mdm; }
    if (i >= p && sTR > 0) {
      const pdi = (100 * sPDM) / sTR, mdi = (100 * sMDM) / sTR;
      dx[i] = (100 * Math.abs(pdi - mdi)) / (pdi + mdi || 1);
    }
  }
  let adx = 0, cnt = 0;
  for (let i = p; i < n; i++) {
    if (!Number.isFinite(dx[i])) continue;
    cnt++;
    if (cnt <= p) { adx += dx[i]!; if (cnt === p) out[i] = adx / p; }
    else { adx = (adx * (p - 1) + dx[i]!) / p; out[i] = adx; }
  }
  return out;
}
function rsiArr(cl: number[], p: number): number[] {
  const n = cl.length;
  const out = new Array(n).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const d = cl[i] - cl[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    if (i <= p) { g += gain; l += loss; if (i === p) { g /= p; l /= p; out[i] = 100 - 100 / (1 + (l === 0 ? 100 : g / l)); } }
    else { g = (g * (p - 1) + gain) / p; l = (l * (p - 1) + loss) / p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------- filter config ----------
interface FilterCfg {
  name: string;
  bounce: boolean; // first entries only on snap-back bars
  trend: { tf: number; len: number } | null; // side-only on TF close vs EMA
  vol: boolean; // first entries only when ATR14 > trailing median(100)
  adxPause: number | null; // skip first entries when H1 ADX > T
  adxSide: number | null; // above T: H1-EMA50 side only (stacked with trend)
  rsi: boolean; // M5 RSI14 > 50 buys only, < 50 sells only
  stack: boolean; // video-style: market stack on signal side, no limit grid
  stackLegs: number;
  basket: number; // basket exit at avg ± basket steps (live 0.5)
  adds: number; // max DCA adds per book (live 6)
}
const SWEEP: FilterCfg[] = [
  { name: "baseline", bounce: true, trend: null, vol: false, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "noBounce", bounce: false, trend: null, vol: false, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "m5e20", bounce: true, trend: { tf: 5, len: 20 }, vol: false, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "m5e50", bounce: true, trend: { tf: 5, len: 50 }, vol: false, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "m5e100", bounce: true, trend: { tf: 5, len: 100 }, vol: false, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "m15e50", bounce: true, trend: { tf: 15, len: 50 }, vol: false, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "h1e50", bounce: true, trend: { tf: 60, len: 50 }, vol: false, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "vol", bounce: true, trend: null, vol: true, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "m5e50+vol", bounce: true, trend: { tf: 5, len: 50 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "adxPause25", bounce: true, trend: null, vol: false, adxPause: 25, adxSide: null, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "adxSide25", bounce: true, trend: null, vol: false, adxPause: null, adxSide: 25, rsi: false, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "rsi", bounce: true, trend: null, vol: false, adxPause: null, adxSide: null, rsi: true, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "m5e50+rsi", bounce: true, trend: { tf: 5, len: 50 }, vol: false, adxPause: null, adxSide: null, rsi: true, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "m5e50+vol+rsi", bounce: true, trend: { tf: 5, len: 50 }, vol: true, adxPause: null, adxSide: null, rsi: true, stack: false, stackLegs: 0, basket: 0.5, adds: 6 },
  { name: "stack-m5e50", bounce: false, trend: { tf: 5, len: 50 }, vol: false, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 5, basket: 0.5, adds: 6 },
  { name: "stack-m5e50+vol", bounce: false, trend: { tf: 5, len: 50 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 5, basket: 0.5, adds: 6 },
  { name: "stack3-m5e50+vol", bounce: false, trend: { tf: 5, len: 50 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 3, basket: 0.5, adds: 6 },
  { name: "stack10-m5e50+vol", bounce: false, trend: { tf: 5, len: 50 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 10, basket: 0.5, adds: 6 },
  { name: "stack-m5e20+vol", bounce: false, trend: { tf: 5, len: 20 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 5, basket: 0.5, adds: 6 },
  { name: "stack-m5e100+vol", bounce: false, trend: { tf: 5, len: 100 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 5, basket: 0.5, adds: 6 },
  { name: "stack-b1-m5e50+vol", bounce: false, trend: { tf: 5, len: 50 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 5, basket: 1.0, adds: 6 },
  { name: "stack-a4-m5e50+vol", bounce: false, trend: { tf: 5, len: 50 }, vol: true, adxPause: null, adxSide: null, rsi: false, stack: true, stackLegs: 5, basket: 0.5, adds: 4 },
];

interface Ctx {
  m1: { o: number[]; h: number[]; l: number[]; c: number[] };
  m1atr: number[];
  trendMaps: Map<string, (string | null)[]>;
  volOk: boolean[];
  adx: number[];
  rsi: number[];
  adxSide: (string | null)[];
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
  const mk = (tf: number, len: number) => {
    const ht = resample(m1, tf);
    const e = emaArr(ht.c, len);
    const out: (string | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const hk = Math.floor(i / tf) - 1;
      if (hk < 0 || hk >= ht.c.length || !Number.isFinite(e[hk])) continue;
      out[i] = ht.c[hk] >= e[hk]! ? "buy" : "sell";
    }
    return out;
  };
  const trendMaps = new Map<string, (string | null)[]>();
  for (const [tf, len] of [[5, 20], [5, 50], [5, 100], [15, 50], [60, 50]] as const)
    trendMaps.set(`${tf}/${len}`, mk(tf, len));
  const h1 = resample(m1, 60);
  const h1adx = adxArr(h1.h, h1.l, h1.c, 14);
  const h1ema = emaArr(h1.c, 50);
  const adx = new Array(n).fill(NaN);
  const adxSide: (string | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const hk = Math.floor(i / 60) - 1;
    if (hk < 0 || hk >= h1.c.length) continue;
    adx[i] = h1adx[hk];
    if (Number.isFinite(h1ema[hk])) adxSide[i] = h1.c[hk] >= h1ema[hk]! ? "buy" : "sell";
  }
  const m5 = resample(m1, 5);
  const m5rsi = rsiArr(m5.c, 14);
  const rsi = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const hk = Math.floor(i / 5) - 1;
    if (hk < 0 || hk >= m5.c.length) continue;
    rsi[i] = m5rsi[hk];
  }
  return { m1, m1atr, trendMaps, volOk, adx, rsi, adxSide };
}

interface Leg { side: "buy" | "sell"; entry: number; qty: number }
interface Book { side: "buy" | "sell"; legs: Leg[]; anchor: number }
interface Res { ret: number; rt: number; win: number; pf: number; esc: number; dd: number }

function run(ctx: Ctx, f: FilterCfg, from: number, to: number): Res | null {
  const { m1, m1atr } = ctx;
  const n = Math.min(to, m1.c.length);
  if (from + 200 >= n) return null;
  const tmap = f.trend ? ctx.trendMaps.get(`${f.trend.tf}/${f.trend.len}`)! : null;
  if (from < SEED) from = SEED;
  let a0 = m1atr[from - 1];
  if (!Number.isFinite(a0) || a0 <= 0) return null;
  let step = a0 * MULT;
  let base = m1.c[from - 1];
  let quote = EQUITY;
  let peak = EQUITY;
  let dd = 0;
  const books: Book[] = [];
  const trades: { pnl: number; win: boolean }[] = [];
  let escapes = 0;
  let prev: number | null = null;
  let lastStack = -1e9;
  const adv = (GOLD.spreadBps / 2 + GOLD.slippageBps) / 10000;
  const cm = GOLD.commissionBps / 10000;
  const ePx = (p: number, s: string) => (s === "buy" ? p * (1 + adv) : p * (1 - adv));
  const avg = (b: Book) => b.legs.reduce((s, l) => s + l.entry * l.qty, 0) / b.legs.reduce((s, l) => s + l.qty, 0);
  const qty = (b: Book) => b.legs.reduce((s, l) => s + l.qty, 0);
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
  const shutLeg = (b: Book, li: number, px: number) => {
    const leg = b.legs[li];
    const x = ePx(px, leg.side);
    const not = leg.qty * x;
    const net = (leg.side === "buy" ? x - leg.entry : leg.entry - x) * leg.qty - (not * cm + not * adv);
    quote += net;
    trades.push({ pnl: net, win: net > 0 });
    b.legs.splice(li, 1);
  };
  const allowSide = (side: "buy" | "sell", i: number): boolean => {
    if (tmap) { const t = tmap[i]; if (t !== null && t !== side) return false; }
    if (f.adxSide !== null && Number.isFinite(ctx.adx[i]) && ctx.adx[i] > f.adxSide) {
      const s = ctx.adxSide[i];
      if (s !== null && s !== side) return false;
    }
    if (f.rsi) {
      const r = ctx.rsi[i];
      if (Number.isFinite(r)) { if (side === "buy" && r <= 50) return false; if (side === "sell" && r >= 50) return false; }
    }
    return true;
  };
  const entriesOpen = (i: number): boolean => {
    if (f.vol && !ctx.volOk[i]) return false;
    if (f.adxPause !== null && Number.isFinite(ctx.adx[i]) && ctx.adx[i] > f.adxPause) return false;
    return true;
  };
  for (let bi = from; bi < n; bi++) {
    const o = m1.o[bi], hh = m1.h[bi], ll = m1.l[bi], cc = m1.c[bi];
    const upPrev = m1.c[bi - 1] >= m1.o[bi - 1];
    const path = cc >= o ? [o, ll, hh, cc] : [o, hh, ll, cc];
    for (const px of path) {
      if (prev === null) { prev = px; continue; }
      // runner order: escape → leg TPs → basket → first entries → adds
      if (px < base - ESC_STEPS * step || px > base + ESC_STEPS * step) {
        escapes++;
        for (let i = books.length - 1; i >= 0; i--) shutBook(i, px);
        base = px;
        const na = m1atr[bi];
        if (Number.isFinite(na) && na > 0) step = na * MULT; // runner parity: fresh ATR step
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
        const target = b.side === "buy" ? av + f.basket * step : av - f.basket * step;
        if (b.side === "buy" ? px >= target : px <= target) shutBook(i, target);
      }
      if (f.stack) {
        if (books.length === 0 && bi - lastStack > 30 && entriesOpen(bi)) {
          const t = tmap ? tmap[bi] : null;
          const side = (t ?? (upPrev ? "buy" : "sell")) as "buy" | "sell";
          if (allowSide(side, bi)) {
            for (let k = 0; k < f.stackLegs; k++) {
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
        }
      } else if (entriesOpen(bi)) {
        const sides: ("buy" | "sell")[] = f.bounce ? (upPrev ? ["buy"] : ["sell"]) : ["buy", "sell"];
        for (const side of sides) {
          if (!allowSide(side, bi)) continue;
          const lo = Math.min(prev, px), hi = Math.max(prev, px);
          const j0 = side === "buy" ? Math.ceil((base - hi) / step) : Math.ceil((lo - base) / step);
          const j1 = side === "buy" ? Math.floor((base - lo) / step) : Math.floor((hi - base) / step);
          for (let j = Math.max(1, j0); j <= Math.min(LEVELS, j1); j++)
            openBook(side, side === "buy" ? base - j * step : base + j * step, side === "buy" ? base - j * step : base + j * step);
        }
      }
      for (const b of books) {
        if (b.legs.length - 1 >= f.adds) continue;
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
    esc: escapes,
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
    console.log(`[${f.name}] TRAIN ${fmt(tr)} | TEST ${fmt(te)} | worstFold=${worstFold.toFixed(1)} greenFolds=${green}/3`);
    rows.push({
      filter: f.name,
      f0: fr[0]?.ret.toFixed(1) ?? "n/a", f1: fr[1]?.ret.toFixed(1) ?? "n/a", f2: fr[2]?.ret.toFixed(1) ?? "n/a",
      worstFold: +worstFold.toFixed(1), greenFolds: green,
      train: tr?.ret.toFixed(1) ?? "n/a", test: te?.ret.toFixed(1) ?? "n/a",
      testPF: te && Number.isFinite(te.pf) ? +te.pf.toFixed(2) : -1,
      testWin: te ? +te.win.toFixed(1) : -1, testDD: te ? +te.dd.toFixed(1) : -1,
      testRT: te?.rt ?? -1,
    });
  }
  rows.sort((a, b) => (b.worstFold as number) - (a.worstFold as number));
  console.log("\n=== RANKED by worst-foldREE (maximin, anti-overfit) ===");
  console.table(rows);
  writeFileSync("filter-sweep-results.json", JSON.stringify(rows, null, 2));
  console.log("wrote filter-sweep-results.json");

  // Second dataset, fully out-of-sample: repo backtest/XAUUSD_M1.csv (~5 days M1).
  try {
    const m2raw = await loadCsv("../../backtest/XAUUSD_M1.csv");
    const ctx2 = buildCtx(m2raw);
    console.log(`\n=== OOS-2 XAUUSD_M1 bars=${m2raw.c.length} (untouched, no tuning) ===`);
    for (const f of SWEEP) {
      const r = run(ctx2, f, SEED, m2raw.c.length);
      console.log(`[OOS-2 ${f.name}] ${fmt(r)}`);
    }
  } catch (e) {
    console.log(`OOS-2 skipped: ${e instanceof Error ? e.message : e}`);
  }

  // Third dataset (optional CLI arg): stack-family check on another untouched file.
  try {
    const extra = process.argv[2];
    if (extra) {
      const m3 = await loadCsv(extra);
      const ctx3 = buildCtx(m3);
      console.log(`\n=== OOS-3 ${extra} bars=${m3.c.length} (untouched, no tuning) ===`);
      for (const f of SWEEP.filter((s) => s.stack)) {
        console.log(`[OOS-3 ${f.name}] ${fmt(run(ctx3, f, SEED, m3.c.length))}`);
      }
    }
  } catch (e) {
    console.log(`OOS-3 skipped: ${e instanceof Error ? e.message : e}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

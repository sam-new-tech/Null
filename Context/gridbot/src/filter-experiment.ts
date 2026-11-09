// Backtest-ONLY experiment: spread gate + H1 ADX/EMA regime gate.
// Live bot (src/) is untouched — this drives the REAL app engine bar-by-bar
// like app-sim.ts, but at live parity (ATR14 x1.0 n10 M30) with gate wrappers
// around planTick intents. Run: npx tsx src/filter-experiment.ts
//
// Spread model: M1 CSVs carry no spread series, so spread is modeled per M30
// bar as base + fraction of bar range: spreadPx = 0.25 + 0.05 * (high - low).
// The gate skips NEW placements when modeled spread > cap (fills/TP/SL still
// process). Costs (commission + spread + slippage) apply to every fill anyway.
// Regime: H1 ADX(14) + H1 EMA50 from the same M1 tape. M30 bar i maps to H1
// bar floor(i/2) (resample chunks are sequential, no timestamps).
//   pause mode: ADX > T → skip all new placements (manage existing only)
//   side mode:  ADX > T → trend side only (close > EMA = buys, else sells)
import { ADX, EMA } from "technicalindicators";
import { loadCsv, resample } from "./market.js";
import {
  buildGrid as appBuildGrid,
  planTick as appPlanTick,
  isUpBar as appIsUpBar,
  type Bar as AppBar,
} from "../../../src/lib/bot/engine.js";

const GOLD_COSTS = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };
const EQUITY = 10000;
const LOT_OZ = 2;
const DISASTER = 8;
// Live parity (runner.ts STRATEGY_RULES after mult 1.9 → 1.0). Keep in sync.
const ATR_LEN = 14;
const GRID_MULT = 1.0;
const LEVELS = 10;
const SEED_M30 = 120; // covers H1 EMA50 warmup (100 M30 bars) + grid ATR14

interface Resting {
  side: "buy" | "sell";
  price: number;
  tp: number;
  sl: number;
}
interface Pos {
  side: "buy" | "sell";
  entry: number;
  tp: number;
  sl: number;
  qty: number;
  bar: number;
}

type RegimeMode = "off" | "pause" | "side";
interface FilterCfg {
  name: string;
  spreadCap: number | null; // $ — null = no spread gate
  regime: RegimeMode;
  adxT: number;
}

const SWEEP: FilterCfg[] = [
  { name: "baseline", spreadCap: null, regime: "off", adxT: 25 },
  { name: "spread35", spreadCap: 0.35, regime: "off", adxT: 25 },
  { name: "spread50", spreadCap: 0.5, regime: "off", adxT: 25 },
  { name: "spread70", spreadCap: 0.7, regime: "off", adxT: 25 },
  { name: "adx25-pause", spreadCap: null, regime: "pause", adxT: 25 },
  { name: "adx30-pause", spreadCap: null, regime: "pause", adxT: 30 },
  { name: "adx25-side", spreadCap: null, regime: "side", adxT: 25 },
  { name: "adx30-side", spreadCap: null, regime: "side", adxT: 30 },
  { name: "spread50+adx25-side", spreadCap: 0.5, regime: "side", adxT: 25 },
];

function rightAlign(out: number[], n: number): number[] {
  const a = new Array<number>(n).fill(NaN);
  const start = n - out.length;
  for (let i = 0; i < out.length; i++) a[start + i] = out[i];
  return a;
}

function simulate(
  m30: { o: number[]; h: number[]; l: number[]; c: number[] },
  h1adx: number[],
  h1ema: number[],
  h1c: number[],
  f: FilterCfg,
  label: string,
  m30Offset = 0, // global M30 index of m30[0] — keeps H1 mapping + spread honest on splits
) {
  const bars: AppBar[] = m30.c.map((c, i) => ({
    time: i,
    open: m30.o[i],
    high: m30.h[i],
    low: m30.l[i],
    close: c,
  }));
  const seed = bars.slice(0, SEED_M30);
  const grid = appBuildGrid(seed, ATR_LEN, GRID_MULT, LEVELS);
  let quote = EQUITY;
  let costs = 0;
  const mkRest = (g: { lower: number[]; upper: number[]; step: number }): Resting[] => [
    ...g.lower.map((L) => ({ side: "buy" as const, price: L, tp: L + g.step, sl: L - DISASTER * g.step })),
    ...g.upper.map((U) => ({ side: "sell" as const, price: U, tp: U - g.step, sl: U + DISASTER * g.step })),
  ];
  let resting: Resting[] = mkRest(grid);
  const positions: Pos[] = [];
  const trades: { pnl: number; win: boolean }[] = [];
  let escapes = 0;
  let reanchors = 0;
  let skipSpread = 0;
  let skipRegime = 0;
  let cur = { ...grid };
  let barDir: "up" | "down" | null = appIsUpBar(seed[seed.length - 1]) ? "up" : "down";
  let prev: number | null = null;

  const adverse = (GOLD_COSTS.spreadBps / 2 + GOLD_COSTS.slippageBps) / 10000;
  const commFrac = GOLD_COSTS.commissionBps / 10000;
  const entryPx = (p: number, side: "buy" | "sell") => (side === "buy" ? p * (1 + adverse) : p * (1 - adverse));
  const exitPx = (p: number, side: "buy" | "sell") => (side === "buy" ? p * (1 - adverse) : p * (1 + adverse));
  // Modeled spread for M30 bar b (backtest-only proxy, see header).
  const spreadAt = (b: number) => 0.25 + 0.05 * (m30.h[b] - m30.l[b]);
  const regimeAt = (b: number): { gated: boolean; sideOnly: "buy" | "sell" | null } => {
    if (f.regime === "off") return { gated: false, sideOnly: null };
    const gb = b + m30Offset; // global M30 index → H1 bar floor(gb/2)
    const h = Math.min(h1adx.length - 1, Math.floor(gb / 2));
    const adx = h1adx[h];
    if (!Number.isFinite(adx) || adx <= f.adxT) return { gated: false, sideOnly: null };
    if (f.regime === "pause") return { gated: true, sideOnly: null };
    const ema = h1ema[h];
    if (!Number.isFinite(ema)) return { gated: false, sideOnly: null };
    return { gated: false, sideOnly: h1c[h] >= ema ? "buy" : "sell" };
  };

  const closePos = (idx: number, px: number) => {
    const p = positions[idx];
    const x = exitPx(px, p.side);
    const notional = p.qty * x;
    const fee = notional * commFrac + notional * adverse;
    costs += fee;
    const net = (p.side === "buy" ? x - p.entry : p.entry - x) * p.qty - notional * commFrac;
    quote += net;
    trades.push({ pnl: net, win: net > 0 });
    positions.splice(idx, 1);
  };

  for (let b = SEED_M30; b < bars.length; b++) {
    const bar = bars[b];
    barDir = appIsUpBar(bars[b - 1]) ? "up" : "down";
    const path =
      bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
    for (const px of path) {
      if (prev === null) {
        prev = px;
        continue;
      }
      for (let i = resting.length - 1; i >= 0; i--) {
        const r = resting[i];
        const filled = r.side === "buy" ? prev > r.price && px <= r.price : prev < r.price && px >= r.price;
        if (filled) {
          const ep = entryPx(r.price, r.side);
          const notional = LOT_OZ * ep;
          const fee = notional * commFrac + notional * adverse;
          costs += fee;
          quote -= fee;
          positions.push({ side: r.side, entry: ep, tp: r.tp, sl: r.sl, qty: LOT_OZ, bar: b });
          resting.splice(i, 1);
        }
      }
      for (let i = positions.length - 1; i >= 0; i--) {
        const p = positions[i];
        if (p.side === "buy") {
          if (px >= p.tp) closePos(i, p.tp);
          else if (px <= p.sl) closePos(i, p.sl);
        } else {
          if (px <= p.tp) closePos(i, p.tp);
          else if (px >= p.sl) closePos(i, p.sl);
        }
      }
      const intents = appPlanTick({
        grid: cur,
        price: px,
        prevPrice: prev,
        barDir,
        positions: positions.map((p, j) => ({ id: String(j), side: p.side, entry: p.entry })),
        orders: resting.map((r, j) => ({ id: String(j), side: r.side, price: r.price })),
        volumeLots: 0.02,
        disasterSteps: DISASTER,
      });
      for (const it of intents) {
        if (it.type === "escape") {
          escapes++;
          for (let i = positions.length - 1; i >= 0; i--) {
            const p = positions[i];
            const x = exitPx(px, p.side);
            const notional = p.qty * x;
            const fee = notional * commFrac + notional * adverse;
            costs += fee;
            const net = (p.side === "buy" ? x - p.entry : p.entry - x) * p.qty - notional * commFrac;
            quote += net;
            trades.push({ pnl: net, win: net > 0 });
          }
          positions.length = 0;
          resting = [];
          reanchors++;
          const hist = bars.slice(Math.max(0, b - 60), b);
          try {
            let g2 = appBuildGrid(hist, ATR_LEN, GRID_MULT, LEVELS);
            for (const mult of [1.3, 1.6, 2.0]) {
              const lb = hist[hist.length - 1];
              if (lb.high - lb.low <= g2.step * LEVELS) break;
              g2 = appBuildGrid(hist, ATR_LEN, mult, LEVELS);
            }
            cur = g2;
            resting = mkRest(g2);
          } catch {
            // keep flat
          }
          break;
        }
        if (it.type === "place") {
          // --- backtest-only gates (never in live bot) ---
          if (f.spreadCap !== null && spreadAt(b) > f.spreadCap) {
            skipSpread++;
            continue;
          }
          const rg = regimeAt(b);
          if (rg.gated) {
            skipRegime++;
            continue;
          }
          if (rg.sideOnly !== null && it.side !== rg.sideOnly) {
            skipRegime++;
            continue;
          }
          if (!resting.some((r) => r.side === it.side && Math.abs(r.price - it.level) < cur.step * 0.49)) {
            resting.push({ side: it.side, price: it.level, tp: it.tp, sl: it.sl });
          }
        }
      }
      prev = px;
    }
  }
  const wins = trades.filter((t) => t.win).length;
  const gw = trades.filter((t) => t.win).reduce((s, t) => s + t.pnl, 0);
  const gl = -trades.filter((t) => !t.win).reduce((s, t) => s + t.pnl, 0);
  const pf = gl === 0 ? (gw > 0 ? Infinity : 0) : gw / gl;
  const ret = ((quote - EQUITY) / EQUITY) * 100;
  console.log(
    `${label} ${f.name}: step=$${cur.step.toFixed(2)} RT=${trades.length} win=${trades.length ? ((wins / trades.length) * 100).toFixed(0) : "—"}% PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"} ret=${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% costs=$${costs.toFixed(0)} esc=${escapes} skipSpr=${skipSpread} skipReg=${skipRegime} open=${positions.length} resting=${resting.length}`,
  );
}

async function main() {
  const m1 = await loadCsv("data/GC-1m.csv");
  const m30raw = resample(m1, 30);
  const h1raw = resample(m1, 60);
  // H1 regime series, right-aligned (technicalindicators shortens by warmup).
  const adxRaw = ADX.calculate({ high: h1raw.h, low: h1raw.l, close: h1raw.c, period: 14 }).map((d) => d.adx);
  const emaRaw = EMA.calculate({ values: h1raw.c, period: 50 });
  const h1adx = rightAlign(adxRaw, h1raw.c.length);
  const h1ema = rightAlign(emaRaw, h1raw.c.length);
  console.log(`M30 bars=${m30raw.c.length} H1 bars=${h1raw.c.length}`);
  const cut = Math.floor(m30raw.c.length * 0.7);
  const train = {
    o: m30raw.o.slice(0, cut),
    h: m30raw.h.slice(0, cut),
    l: m30raw.l.slice(0, cut),
    c: m30raw.c.slice(0, cut),
  };
  const test = {
    o: m30raw.o.slice(cut),
    h: m30raw.h.slice(cut),
    l: m30raw.l.slice(cut),
    c: m30raw.c.slice(cut),
  };
  for (const f of SWEEP) {
    simulate(train, h1adx, h1ema, h1raw.c, f, "TRAIN", 0);
  }
  for (const f of SWEEP) {
    simulate(test, h1adx, h1ema, h1raw.c, f, "TEST ", cut);
  }
  console.log("\nRT=round trips PF=grossWin/grossLoss ret=net% costs=all-in esc=escapes skipSpr/Reg=gated placements. Regime H1 maps floor(m30/2); test uses global H1 (no lookahead: values are causal per-bar).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

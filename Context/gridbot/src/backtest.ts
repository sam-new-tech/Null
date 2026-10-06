// Grid backtest engine — rebuilt with realistic all-in costs.
//
// Fills (every fill, both sides) pay, in order:
//   1. spread      — half-spread crossed against you
//   2. slippage    — extra adverse offset (queue, latency, fast market)
//   3. commission  — broker fee on notional
// Entry/exit prices in `fills` are POST-cost (what you actually got).
//
// Strategy: dir=+1 longs buy lower[] and sell +step; dir=-1 shorts sell
// upper[] and cover −step; "both" = two half-capital sub-runs merged.
// Escape → liquidate at market; trailing re-anchors a fresh grid at close.
// ADX gate pauses entries in chop; per-lot SL (default off) exits adverse.
// Equity marked to close every bar → honest drawdown.

import type { OHLC } from "./market.js";
import { buildGrid, warmup, type GridConfig } from "./strategy.js";

export interface Fill {
  bar: number;
  side: "buy" | "sell";
  price: number; // post-cost executed price
}

export interface Trade {
  barsHeld: number;
  pnl: number; // net of all costs
  win: boolean;
}

export interface BacktestResult {
  cfg: GridConfig;
  step: number;
  base: number;
  roundTrips: number;
  wins: number;
  winRatePct: number;
  profitFactor: number; // grossWin / grossLoss (Infinity = no losers)
  expectancy: number; // mean net PnL per round trip, in quote
  gridReturnPct: number;
  buyHoldReturnPct: number;
  finalEquity: number;
  maxDrawdownPct: number;
  costsPaid: number; // commission + spread + slippage, in quote
  barsHeld: number;
  escapedRange: boolean;
  stoppedOut: boolean; // CFD margin call hit (leverage>0 only)
  reanchors: number;
  equityCurve: number[];
  fills: Fill[];
  trades: Trade[];
}

export function backtest(m: OHLC, cfg: GridConfig, equity0 = 10_000): BacktestResult {
  if (cfg.direction === "both") return mergeBoth(m, cfg, equity0);
  return runOne(m, cfg, equity0, cfg.direction === "short" ? -1 : 1);
}

function mergeBoth(m: OHLC, cfg: GridConfig, equity0: number): BacktestResult {
  const a = backtest(m, { ...cfg, direction: "long" }, equity0 / 2);
  const b = backtest(m, { ...cfg, direction: "short" }, equity0 / 2);
  const len = Math.max(a.equityCurve.length, b.equityCurve.length);
  const last = (c: number[]) => c[c.length - 1];
  const equityCurve = Array.from({ length: len }, (_, i) =>
    (a.equityCurve[i] ?? last(a.equityCurve)) + (b.equityCurve[i] ?? last(b.equityCurve)));
  const finalEquity = a.finalEquity + b.finalEquity;
  let peak = -Infinity, maxDD = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e);
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  const trades = [...a.trades, ...b.trades];
  const wins = trades.filter((t) => t.win).length;
  return {
    cfg, step: a.step, base: a.base,
    roundTrips: trades.length, wins,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    profitFactor: pf(trades), expectancy: mean(trades.map((t) => t.pnl)),
    gridReturnPct: (finalEquity / equity0 - 1) * 100,
    buyHoldReturnPct: a.buyHoldReturnPct, finalEquity, maxDrawdownPct: maxDD * 100,
    costsPaid: a.costsPaid + b.costsPaid,
    barsHeld: Math.max(a.barsHeld, b.barsHeld),
    escapedRange: a.escapedRange && b.escapedRange,
    stoppedOut: a.stoppedOut || b.stoppedOut,
    reanchors: a.reanchors + b.reanchors, equityCurve,
    fills: [...a.fills, ...b.fills].sort((x, y) => x.bar - y.bar), trades,
  };
}

function pf(trades: Trade[]): number {
  const w = trades.filter((t) => t.win).reduce((s, t) => s + t.pnl, 0);
  const l = -trades.filter((t) => !t.win).reduce((s, t) => s + t.pnl, 0);
  if (l === 0) return w > 0 ? Infinity : 0;
  return w / l;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function runOne(m: OHLC, cfg: GridConfig, equity0: number, dir: 1 | -1): BacktestResult {
  const n = m.c.length;
  const a = warmup(cfg);
  if (a + 2 >= n) throw new Error("Not enough bars for warmup");
  const g = buildGrid(m, cfg, a);
  const t0 = Math.max(a, g.anchor); // start trading at the anchored bar, not inside dead minutes

  const perLevel = equity0 / cfg.levelsEachSide;
  let quote = equity0;
  let costsPaid = 0;
  const lots: { entry: number; target: number; qty: number; margin: number; bar: number }[] = [];
  const fills: Fill[] = [];
  const trades: Trade[] = [];
  const equityCurve: number[] = [];
  let escapedRange = false;
  let stoppedOut = false;
  let reanchors = 0;
  let endBar = n;

  let step = g.step, base = g.base;
  let entryLevels = dir === 1 ? g.lower : g.upper;
  let lo = base - cfg.levelsEachSide * step;
  let hi = base + cfg.levelsEachSide * step;

  // --- realistic costs: commission on notional + adverse price offsets ---
  const comm = (notional: number) => {
    const f = notional * (cfg.commissionBps / 10_000);
    costsPaid += f;
    quote -= f;
  };
  const adverse = (cfg.spreadBps / 2 + cfg.slippageBps) / 10_000; // fraction against you
  // Spread/slippage are paid through the adversely-shifted fill price itself
  // (entryPx/exitPx) — this only logs them for reporting. Commission deducts above.
  const paySpreadSlip = (notional: number) => {
    const f = notional * adverse;
    costsPaid += f;
  };
  // Executed price AFTER spread+slippage (commission is separate, on notional).
  const entryPx = (p: number) => (dir === 1 ? p * (1 + adverse) : p * (1 - adverse));
  const exitPx = (p: number) => (dir === 1 ? p * (1 - adverse) : p * (1 + adverse));

  const exitLots = (t: number, refPx: number, idx: number[]) => {
    for (const i of [...idx].sort((x, y) => y - x)) {
      const lot = lots[i];
      const px = exitPx(refPx);
      paySpreadSlip(lot.qty * px);
      const net = dir * (px - lot.entry) * lot.qty - lot.qty * px * (cfg.commissionBps / 10_000);
      quote += lot.margin + net;
      comm(lot.qty * px);
      const trade: Trade = { barsHeld: t - lot.bar, pnl: net, win: net > 0 };
      trades.push(trade);
      fills.push({ bar: t, side: dir === 1 ? "sell" : "buy", price: px });
      lots.splice(i, 1);
    }
  };
  const closeLots = (t: number, price: number) => exitLots(t, price, lots.map((_, i) => i));
  const lotsValue = (price: number) =>
    lots.reduce((s, l) => s + l.margin + dir * (price - l.entry) * l.qty, 0);

  for (let t = t0; t < n; t++) {
    const low = m.l[t], high = m.h[t], close = m.c[t];

    if (low < lo || high > hi) {
      closeLots(t, close);
      if (!cfg.reanchor) {
        escapedRange = true;
        endBar = t;
        equityCurve.push(quote);
        break;
      }
      reanchors++;
      base = close;
      step = cfg.mode === "atr" ? g.atr[t] * cfg.gridMult : cfg.fixedTicks * cfg.tickSize;
      if (!Number.isFinite(step) || step <= 0) { endBar = t; equityCurve.push(quote); break; }
      entryLevels = [];
      if (dir === 1) for (let i = cfg.levelsEachSide; i >= 1; i--) entryLevels.push(base - i * step);
      else for (let i = 1; i <= cfg.levelsEachSide; i++) entryLevels.push(base + i * step);
      lo = base - cfg.levelsEachSide * step;
      hi = base + cfg.levelsEachSide * step;
    }

    // Take-profits only. (Per-lot stops were tested: they sit inside 1m noise,
    // cut winners as often as losers and multiply fee events — removed.)
    lots.sort((x, y) => (dir === 1 ? y.target - x.target : x.target - y.target));
    for (let i = lots.length - 1; i >= 0; i--) {
      const lot = lots[i];
      const taken = dir === 1 ? high >= lot.target : low <= lot.target;
      if (taken) exitLots(t, lot.target, [i]);
    }

    // Entries. bounceEntry: don't chase escapes — longs only on up-bars, shorts on down-bars.
    const trendOk = !cfg.adxGate || (Number.isFinite(g.adx[t]) && g.adx[t] >= cfg.adxThreshold);
    const bounceOk = !cfg.bounceEntry || (dir === 1 ? close >= m.o[t] : close <= m.o[t]);
    if (trendOk && bounceOk) {
      const touched = entryLevels
        .filter((L) => (dir === 1 ? low <= L : high >= L))
        .sort((x, y) => (dir === 1 ? x - y : y - x));
      for (const L of touched) {
        // up to entriesPerLevel stacked lots per level; fixed oz sizing if set
        const atLevel = lots.filter((l) => Math.abs(l.entry - L) < step * 0.49).length;
        if (atLevel >= cfg.entriesPerLevel) continue;
        const px = entryPx(L);
        const qty = cfg.lotOz > 0 ? cfg.lotOz : perLevel / L;
        // CFD leverage: only margin is locked (notional/leverage); spot locks full notional.
        const lock = (qty * L) / (cfg.leverage > 0 ? cfg.leverage : 1);
        if (quote < lock) break;
        paySpreadSlip(lock);
        quote -= lock;
        comm(lock);
        lots.push({ entry: px, target: L + dir * step, qty, margin: lock, bar: t });
        fills.push({ bar: t, side: dir === 1 ? "buy" : "sell", price: px });
      }
    }

    equityCurve.push(quote + lotsValue(close));

    // CFD stop-out: equity below fraction of used margin → broker liquidates all.
    if (cfg.leverage > 0) {
      const exposure = lots.reduce((s, l) => s + l.qty * close, 0);
      const equityNow = quote + lotsValue(close);
      if (equityNow < (exposure / cfg.leverage) * cfg.stopOutFrac && lots.length) {
        closeLots(t, close);
        stoppedOut = true;
        equityCurve.push(quote);
        endBar = t;
        break;
      }
    }
  }

  const lastClose = m.c[n - 1];
  const finalEquity = quote + lotsValue(lastClose);
  let peak = -Infinity, maxDD = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e);
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  const wins = trades.filter((tr) => tr.win).length;
  return {
    cfg, step: g.step, base: g.base,
    roundTrips: trades.length, wins,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    profitFactor: pf(trades), expectancy: mean(trades.map((tr) => tr.pnl)),
    gridReturnPct: (finalEquity / equity0 - 1) * 100,
    buyHoldReturnPct: (lastClose / m.c[a] - 1) * 100,
    finalEquity, maxDrawdownPct: maxDD * 100, costsPaid,
    barsHeld: endBar - t0, escapedRange, stoppedOut, reanchors, equityCurve, fills, trades,
  };
}

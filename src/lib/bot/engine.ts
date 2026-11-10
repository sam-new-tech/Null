/**
 * XAU/USD Momentum Trend Strategy Engine.
 *
 * Implements the exact backtested quantitative strategy:
 * - Timeframe: 1-minute bars
 * - 5-minute EMA(50) resampled from 1-minute closes (closed="right", label="right"), forward-filled
 * - 1-minute Stochastic RSI (K=9, D=3, RSI=14, Stoch=14) — TradingView ta.stoch(ta.rsi(close,14)...)
 * - 1-minute ADX(14) (threshold: > 25.0)
 *
 * Signals:
 * - Long:  price > ema50_5m AND stochK > stochD AND adx > 25.0  -> Take Profit = price + 2.0
 * - Short: price < ema50_5m AND stochK < stochD AND adx > 25.0 -> Take Profit = price - 2.0
 * - StochRSI is neutral (no entry) when K or D is >= 80 or <= 20.
 *
 * Position Rules:
 * - Fixed 0.01 lots per signal, up to floor(equity / 20) concurrent positions.
 * - Fixed $2.00 target on Gold from entry price.
 */

import { ADX, EMA } from 'fast-technical-indicators';

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StrategyIndicators {
  ema5m: number | null;
  stochK: number | null;
  stochD: number | null;
  adx: number | null;
}

export interface StrategySignal {
  action: 'buy' | 'sell' | 'none';
  price: number;
  tp: number;
  ema5m: number | null;
  stochK: number | null;
  stochD: number | null;
  adx: number | null;
  reason: string;
}

export const STRATEGY_PARAMS = {
  symbol: 'XAUUSD',
  adxThreshold: 25.0,
  tpDelta: 2.0, // Fixed $2.00 gold profit target
  ema5mPeriod: 50,
  stochRsiRsiPeriod: 14,
  stochRsiStochPeriod: 14,
  stochRsiKPeriod: 9,
  stochRsiDPeriod: 3,
  adxPeriod: 14,
} as const;

/**
 * Resample 1m bars into 5m closes matching pandas `resample('5min', label='right', closed='right').last()`.
 * Computes EMA(50) on the 5m bars and forward-fills back to 1m bars.
 */
export function resample5mEMA(
  bars: Bar[],
  period: number = STRATEGY_PARAMS.ema5mPeriod,
): (number | null)[] {
  const n = bars.length;
  if (n === 0) return [];

  const intervalMs = 5 * 60 * 1000;
  // Map interval boundary -> last close in interval (closed='right', label='right')
  const fiveMinMap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const bucketKey = Math.ceil(b.time / intervalMs) * intervalMs;
    fiveMinMap.set(bucketKey, b.close);
  }

  const sortedBuckets = Array.from(fiveMinMap.keys()).sort((a, b) => a - b);
  const closes5m = sortedBuckets.map((k) => fiveMinMap.get(k)!);

  if (closes5m.length < period) {
    return new Array<number | null>(n).fill(null);
  }

  const ema5mValues = EMA.calculate({ period, values: closes5m });
  const bucketEmaMap = new Map<number, number>();
  for (let i = 0; i < ema5mValues.length; i++) {
    const bucketKey = sortedBuckets[i + (period - 1)];
    bucketEmaMap.set(bucketKey, ema5mValues[i]);
  }

  // Forward fill: for any 1m bar at timestamp t, the latest completed 5m bucket is Math.floor(t / 5m) * 5m
  const out = new Array<number | null>(n);
  let lastKnownEma: number | null = null;
  for (let i = 0; i < n; i++) {
    const completedKey = Math.floor(bars[i].time / intervalMs) * intervalMs;
    if (bucketEmaMap.has(completedKey)) {
      lastKnownEma = bucketEmaMap.get(completedKey)!;
    }
    out[i] = lastKnownEma;
  }

  return out;
}

/**
 * Wilder RSI matching TradingView `ta.rsi(close, period)`: the first value
 * appears at index `period`, then gains/losses are RMA-smoothed.
 */
export function calculateRSI(values: number[], period = 14): (number | null)[] {
  const n = values.length;
  const out = new Array<number | null>(n).fill(null);
  if (period <= 0 || n <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** SMA that keeps `null` gaps as `null` instead of coercing them to zero. */
function smaNullable(values: (number | null)[], period: number): (number | null)[] {
  const out = new Array<number | null>(values.length).fill(null);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let complete = true;
    for (let j = i - period + 1; j <= i; j++) {
      const value = values[j];
      if (value === null) {
        complete = false;
        break;
      }
      sum += value;
    }
    if (complete) out[i] = sum / period;
  }
  return out;
}

/**
 * TradingView Pine equivalent:
 *   rsi1 = ta.rsi(close, 14)
 *   k = ta.sma(ta.stoch(rsi1, rsi1, rsi1, 14), 9)
 *   d = ta.sma(k, 3)
 *
 * `ta.stoch` is called with the RSI series for source/high/low, so it measures
 * where the current RSI sits inside its own 14-bar range.
 */
export function calculateStochRSI(
  values: number[],
  rsiPeriod = STRATEGY_PARAMS.stochRsiRsiPeriod,
  stochPeriod = STRATEGY_PARAMS.stochRsiStochPeriod,
  kPeriod = STRATEGY_PARAMS.stochRsiKPeriod,
  dPeriod = STRATEGY_PARAMS.stochRsiDPeriod,
): { rsi: (number | null)[]; stoch: (number | null)[]; k: (number | null)[]; d: (number | null)[] } {
  const rsi = calculateRSI(values, rsiPeriod);
  const stoch = new Array<number | null>(values.length).fill(null);

  for (let i = 0; i < values.length; i++) {
    const current = rsi[i];
    if (current === null) continue;
    const start = i - stochPeriod + 1;
    if (start < 0) continue;

    let highest = Number.NEGATIVE_INFINITY;
    let lowest = Number.POSITIVE_INFINITY;
    let complete = true;
    for (let j = start; j <= i; j++) {
      const value = rsi[j];
      if (value === null) {
        complete = false;
        break;
      }
      if (value > highest) highest = value;
      if (value < lowest) lowest = value;
    }
    if (!complete) continue;
    stoch[i] = highest === lowest ? 0 : ((current - lowest) / (highest - lowest)) * 100;
  }

  const k = smaNullable(stoch, kPeriod);
  const d = smaNullable(k, dPeriod);
  return { rsi, stoch, k, d };
}

/**
 * StochRSI bands matching TradingView's 20/50/80 guides. Either line in an
 * extreme zone makes the trend NEUTRAL, regardless of K-vs-D order.
 */
export const STOCH_OVERBOUGHT = 80;
export const STOCH_OVERSOLD = 20;

export type StochTrend = 'bullish' | 'bearish' | 'flat' | 'neutral';

/**
 * Direction used by both the bot screen and the entry filter.
 * Returns null while K/D are still warming up.
 */
export function stochTrend(k: number | null, d: number | null): StochTrend | null {
  if (k === null || d === null || !Number.isFinite(k) || !Number.isFinite(d)) return null;
  if (k >= STOCH_OVERBOUGHT || d >= STOCH_OVERBOUGHT || k <= STOCH_OVERSOLD || d <= STOCH_OVERSOLD) {
    return 'neutral';
  }
  if (k > d) return 'bullish';
  if (k < d) return 'bearish';
  return 'flat';
}

/**
 * Calculate all indicators for the given 1m bars.
 * Returns an array of StrategyIndicators aligned with the input bars.
 */
export function calculateIndicators(bars: Bar[]): StrategyIndicators[] {
  const n = bars.length;
  const out: StrategyIndicators[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      ema5m: null,
      stochK: null,
      stochD: null,
      adx: null,
    };
  }

  if (n === 0) return out;

  // 1. 5m EMA(50) forward filled
  const ema5mArray = resample5mEMA(bars, STRATEGY_PARAMS.ema5mPeriod);
  for (let i = 0; i < n; i++) {
    out[i].ema5m = ema5mArray[i];
  }

  // 2. 1m Stochastic RSI (K=9, D=3, RSI=14, Stoch=14)
  const closes1m = bars.map((b) => b.close);
  const stochRsi = calculateStochRSI(closes1m);
  for (let i = 0; i < n; i++) {
    out[i].stochK = stochRsi.k[i];
    out[i].stochD = stochRsi.d[i];
  }

  // 3. 1m ADX(14)
  if (n >= 28) {
    const adxResults = ADX.calculate({
      period: STRATEGY_PARAMS.adxPeriod,
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      close: closes1m,
    });

    // ADX has warm-up: 1 bar diff + (period - 1) wilder + (period - 1) SMA = 27 bars offset
    const adxOffset = 27;
    for (let r = 0; r < adxResults.length; r++) {
      const barIdx = r + adxOffset;
      if (barIdx < n) {
        out[barIdx].adx = adxResults[r].adx ?? null;
      }
    }
  }

  return out;
}

/**
 * Evaluate strategy signal on the latest closed bar.
 */
export function evaluateSignal(bars: Bar[], indicators?: StrategyIndicators[]): StrategySignal {
  if (bars.length === 0) {
    return {
      action: 'none',
      price: 0,
      tp: 0,
      ema5m: null,
      stochK: null,
      stochD: null,
      adx: null,
      reason: 'No bars available',
    };
  }

  const lastIdx = bars.length - 1;
  const lastBar = bars[lastIdx];
  const price = lastBar.close;

  const indList = indicators ?? calculateIndicators(bars);
  const ind = indList[lastIdx];

  if (
    ind.ema5m === null ||
    ind.stochK === null ||
    ind.stochD === null ||
    ind.adx === null
  ) {
    return {
      action: 'none',
      price,
      tp: 0,
      ema5m: ind.ema5m,
      stochK: ind.stochK,
      stochD: ind.stochD,
      adx: ind.adx,
      reason: 'Warming up indicators',
    };
  }

  const trend = stochTrend(ind.stochK, ind.stochD);

  // Overbought/oversold on either line means no directional trend.
  if (trend === 'neutral') {
    return {
      action: 'none',
      price,
      tp: 0,
      ema5m: ind.ema5m,
      stochK: ind.stochK,
      stochD: ind.stochD,
      adx: ind.adx,
      reason: `StochRSI neutral: K ${ind.stochK.toFixed(1)} / D ${ind.stochD.toFixed(1)} is in the 20/80 zone`,
    };
  }

  // Long entry condition:
  // price > ema AND stochK > stochD (not overbought/oversold) AND adx > 25.0
  if (
    price > ind.ema5m &&
    trend === 'bullish' &&
    ind.adx > STRATEGY_PARAMS.adxThreshold
  ) {
    return {
      action: 'buy',
      price,
      tp: price + STRATEGY_PARAMS.tpDelta,
      ema5m: ind.ema5m,
      stochK: ind.stochK,
      stochD: ind.stochD,
      adx: ind.adx,
      reason: `Long: Price(${price.toFixed(2)}) > EMA5m(${ind.ema5m.toFixed(2)}) && StochRSI Bull (K ${ind.stochK.toFixed(1)} > D ${ind.stochD.toFixed(1)}) && ADX(${ind.adx.toFixed(1)}) > 25`,
    };
  }

  // Short entry condition:
  // price < ema AND stochK < stochD (not overbought/oversold) AND adx > 25.0
  if (
    price < ind.ema5m &&
    trend === 'bearish' &&
    ind.adx > STRATEGY_PARAMS.adxThreshold
  ) {
    return {
      action: 'sell',
      price,
      tp: price - STRATEGY_PARAMS.tpDelta,
      ema5m: ind.ema5m,
      stochK: ind.stochK,
      stochD: ind.stochD,
      adx: ind.adx,
      reason: `Short: Price(${price.toFixed(2)}) < EMA5m(${ind.ema5m.toFixed(2)}) && StochRSI Bear (K ${ind.stochK.toFixed(1)} < D ${ind.stochD.toFixed(1)}) && ADX(${ind.adx.toFixed(1)}) > 25`,
    };
  }

  return {
    action: 'none',
    price,
    tp: 0,
    ema5m: ind.ema5m,
    stochK: ind.stochK,
    stochD: ind.stochD,
    adx: ind.adx,
    reason: 'Waiting for signal criteria',
  };
}

/**
 * Fixed lot size per signal. Sizing no longer scales with equity — the number
 * of concurrent 0.01-lot positions does.
 */
export const BOT_LOT_SIZE = 0.01;

/**
 * Maximum concurrent managed positions for an account: floor(equity / $20).
 * Non-finite or non-positive equity yields 0 slots.
 */
export function maxOpenPositions(equity: number): number {
  if (!Number.isFinite(equity) || equity <= 0) return 0;
  return Math.floor(equity / 20);
}

/** @deprecated Kept only for the legacy research sandbox; the live bot uses {@link BOT_LOT_SIZE}. */
export function calculateLots(equity: number, cap = 0.05): number {
  if (!Number.isFinite(equity) || equity <= 0) return 0.01;
  const scaled = Math.floor((equity / 10000) * 2 * 100) / 100;
  return Math.max(0.01, Math.min(cap, scaled));
}

export const videoLots = calculateLots;

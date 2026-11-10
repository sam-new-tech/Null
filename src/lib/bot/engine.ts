/**
 * XAU/USD Momentum Trend Strategy Engine.
 *
 * Implements the exact backtested quantitative strategy:
 * - Timeframe: 1-minute bars
 * - 5-minute EMA(50) resampled from 1-minute closes (closed="right", label="right"), forward-filled
 * - 1-minute MACD(12, 26, 9)
 * - 1-minute ADX(14) (threshold: > 25.0)
 * - 1-minute VDC (Volume Delta Control, timeperiod=20, threshold=20.0, splitmode="candle")
 *
 * Signals:
 * - Long:  price > ema50_5m AND macd_line > macd_signal AND adx > 25.0 AND vdc > 20.0  -> Take Profit = price + 2.0
 * - Short: price < ema50_5m AND macd_line < macd_signal AND adx > 25.0 AND vdc < -20.0 -> Take Profit = price - 2.0
 *
 * Position Rules:
 * - Single managed position at a time (flat or in 1 trade).
 * - Fixed $2.00 target on Gold from entry price.
 */

import { ADX, EMA, MACD } from 'fast-technical-indicators';

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
  macdLine: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  adx: number | null;
  vdc: number | null;
}

export interface StrategySignal {
  action: 'buy' | 'sell' | 'none';
  price: number;
  tp: number;
  ema5m: number | null;
  macdLine: number | null;
  macdSignal: number | null;
  adx: number | null;
  vdc: number | null;
  reason: string;
}

export const STRATEGY_PARAMS = {
  symbol: 'XAUUSD',
  adxThreshold: 25.0,
  vdcThreshold: 20.0,
  tpDelta: 2.0, // Fixed $2.00 gold profit target
  ema5mPeriod: 50,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  adxPeriod: 14,
  vdcPeriod: 20,
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
 * Compute Volume Delta Control (VDC) indicator.
 * Matches Pine Script / Python port `vdc.py` exactly (candle mode).
 *
 * bull_vol = volume if close >= open else 0.0
 * bear_vol = volume - bull_vol
 * delta = rolling_sum(bull_vol, 20) - rolling_sum(bear_vol, 20)
 * vdc = delta / rolling_sum(volume, 20) * 100
 */
export function calculateVDC(
  bars: Bar[],
  period: number = STRATEGY_PARAMS.vdcPeriod,
): (number | null)[] {
  const n = bars.length;
  const out = new Array<number | null>(n).fill(null);
  if (n < period) return out;

  let bullSum = 0;
  let totalSum = 0;
  const bullVol = new Float64Array(n);
  const totalVol = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const vol = Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0;
    const isBull = b.close >= b.open;
    const bv = isBull ? vol : 0.0;

    bullVol[i] = bv;
    totalVol[i] = vol;

    bullSum += bv;
    totalSum += vol;

    if (i >= period) {
      bullSum -= bullVol[i - period];
      totalSum -= totalVol[i - period];
    }

    if (i >= period - 1) {
      const bearSum = totalSum - bullSum;
      const delta = bullSum - bearSum;
      out[i] = totalSum > 0 ? (delta / totalSum) * 100.0 : 0.0;
    }
  }

  return out;
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
      macdLine: null,
      macdSignal: null,
      macdHist: null,
      adx: null,
      vdc: null,
    };
  }

  if (n === 0) return out;

  // 1. 5m EMA(50) forward filled
  const ema5mArray = resample5mEMA(bars, STRATEGY_PARAMS.ema5mPeriod);
  for (let i = 0; i < n; i++) {
    out[i].ema5m = ema5mArray[i];
  }

  // 2. 1m VDC(20)
  const vdcArray = calculateVDC(bars, STRATEGY_PARAMS.vdcPeriod);
  for (let i = 0; i < n; i++) {
    out[i].vdc = vdcArray[i];
  }

  // 3. 1m MACD(12, 26, 9)
  const closes1m = bars.map((b) => b.close);
  if (n >= STRATEGY_PARAMS.macdSlow) {
    const macdResults = MACD.calculate({
      values: closes1m,
      fastPeriod: STRATEGY_PARAMS.macdFast,
      slowPeriod: STRATEGY_PARAMS.macdSlow,
      signalPeriod: STRATEGY_PARAMS.macdSignal,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });

    const macdOffset = STRATEGY_PARAMS.macdSlow - 1; // 25
    for (let r = 0; r < macdResults.length; r++) {
      const barIdx = r + macdOffset;
      if (barIdx < n) {
        const item = macdResults[r];
        out[barIdx].macdLine = item.MACD ?? null;
        out[barIdx].macdSignal = item.signal ?? null;
        out[barIdx].macdHist = item.histogram ?? null;
      }
    }
  }

  // 4. 1m ADX(14)
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
      macdLine: null,
      macdSignal: null,
      adx: null,
      vdc: null,
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
    ind.macdLine === null ||
    ind.macdSignal === null ||
    ind.adx === null ||
    ind.vdc === null
  ) {
    return {
      action: 'none',
      price,
      tp: 0,
      ema5m: ind.ema5m,
      macdLine: ind.macdLine,
      macdSignal: ind.macdSignal,
      adx: ind.adx,
      vdc: ind.vdc,
      reason: 'Warming up indicators',
    };
  }

  const macdUp = ind.macdLine > ind.macdSignal;
  const macdDown = ind.macdLine < ind.macdSignal;

  // Long entry condition:
  // price > ema AND macd_line > macd_signal AND adx > 25.0 AND vdc > 20.0
  if (
    price > ind.ema5m &&
    macdUp &&
    ind.adx > STRATEGY_PARAMS.adxThreshold &&
    ind.vdc > STRATEGY_PARAMS.vdcThreshold
  ) {
    return {
      action: 'buy',
      price,
      tp: price + STRATEGY_PARAMS.tpDelta,
      ema5m: ind.ema5m,
      macdLine: ind.macdLine,
      macdSignal: ind.macdSignal,
      adx: ind.adx,
      vdc: ind.vdc,
      reason: `Long: Price(${price.toFixed(2)}) > EMA5m(${ind.ema5m.toFixed(2)}) && MACD Bull && ADX(${ind.adx.toFixed(1)}) > 25 && VDC(+${ind.vdc.toFixed(1)}%) > 20`,
    };
  }

  // Short entry condition:
  // price < ema AND macd_line < macd_signal AND adx > 25.0 AND vdc < -20.0
  if (
    price < ind.ema5m &&
    macdDown &&
    ind.adx > STRATEGY_PARAMS.adxThreshold &&
    ind.vdc < -STRATEGY_PARAMS.vdcThreshold
  ) {
    return {
      action: 'sell',
      price,
      tp: price - STRATEGY_PARAMS.tpDelta,
      ema5m: ind.ema5m,
      macdLine: ind.macdLine,
      macdSignal: ind.macdSignal,
      adx: ind.adx,
      vdc: ind.vdc,
      reason: `Short: Price(${price.toFixed(2)}) < EMA5m(${ind.ema5m.toFixed(2)}) && MACD Bear && ADX(${ind.adx.toFixed(1)}) > 25 && VDC(${ind.vdc.toFixed(1)}%) < -20`,
    };
  }

  return {
    action: 'none',
    price,
    tp: 0,
    ema5m: ind.ema5m,
    macdLine: ind.macdLine,
    macdSignal: ind.macdSignal,
    adx: ind.adx,
    vdc: ind.vdc,
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

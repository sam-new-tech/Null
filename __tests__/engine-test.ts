import {
  BOT_LOT_SIZE,
  calculateIndicators,
  calculateRSI,
  calculateStochRSI,
  evaluateSignal,
  maxOpenPositions,
  resample5mEMA,
  stochTrend,
  type Bar,
  type StrategyIndicators,
} from '@/lib/bot/engine';

function makeBar(index: number, close: number, volume = 1): Bar {
  return {
    time: index * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume,
  };
}

function makeBars(closes: number[]): Bar[] {
  return closes.map((close, index) => makeBar(index, close));
}

function indicators(overrides: Partial<StrategyIndicators> = {}): StrategyIndicators {
  return {
    ema5m: 99,
    stochK: 60,
    stochD: 50,
    adx: 30,
    ...overrides,
  };
}

describe('resample5mEMA', () => {
  it('returns nulls until there are enough closed 5m bars', () => {
    const bars = makeBars(new Array(100).fill(100));
    expect(resample5mEMA(bars)).toEqual(new Array(100).fill(null));
  });

  it('aligns one value per 1m bar and forward-fills the latest EMA', () => {
    const bars = makeBars(new Array(600).fill(100));
    const ema = resample5mEMA(bars);

    expect(ema).toHaveLength(600);
    expect(ema[599]).toBeCloseTo(100);

    const firstValue = ema.findIndex((value) => value !== null);
    expect(firstValue).toBeGreaterThan(0);
    expect(ema.slice(firstValue).every((value) => value !== null)).toBe(true);
  });

  it('handles an empty series', () => {
    expect(resample5mEMA([])).toEqual([]);
  });
});

describe('position sizing', () => {
  it('uses a fixed 0.01 lot per signal', () => {
    expect(BOT_LOT_SIZE).toBe(0.01);
  });

  it('derives concurrent slots as floor(equity / 20)', () => {
    expect(maxOpenPositions(753.14)).toBe(37); // 37.657
    expect(maxOpenPositions(20)).toBe(1);
    expect(maxOpenPositions(39.99)).toBe(1);
    expect(maxOpenPositions(19.99)).toBe(0);
    expect(maxOpenPositions(0)).toBe(0);
    expect(maxOpenPositions(-100)).toBe(0);
    expect(maxOpenPositions(Number.NaN)).toBe(0);
    expect(maxOpenPositions(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('calculateRSI', () => {
  it('matches Wilder alignment: first value at the period index', () => {
    const values = Array.from({ length: 40 }, (_, i) => 100 + i);
    const rsi = calculateRSI(values, 14);
    expect(rsi[13]).toBeNull();
    expect(rsi[14]).toBe(100);
    expect(rsi.slice(15).every((value) => value !== null)).toBe(true);
  });

  it('returns 100 for all gains, 0 for all losses and 50 for a flat series', () => {
    const gains = Array.from({ length: 30 }, (_, i) => 1 + i);
    const losses = Array.from({ length: 30 }, (_, i) => 100 - i);
    const flat = new Array(30).fill(100);
    expect(calculateRSI(gains, 14)[14]).toBe(100);
    expect(calculateRSI(losses, 14)[14]).toBe(0);
    expect(calculateRSI(flat, 14)[14]).toBe(50);
  });
});

describe('calculateStochRSI', () => {
  // Zig-zag closes keep RSI varying so the stochastic range is non-zero.
  const closes = Array.from({ length: 60 }, (_, i) => 100 + (i % 10) * 0.5);

  it('warms up at the TradingView indices (RSI 14, stoch 27, K 35, D 37)', () => {
    const result = calculateStochRSI(closes);
    const firstIndex = (series: (number | null)[]) => series.findIndex((value) => value !== null);
    expect(firstIndex(result.rsi)).toBe(14);
    expect(firstIndex(result.stoch)).toBe(27);
    expect(firstIndex(result.k)).toBe(35);
    expect(firstIndex(result.d)).toBe(37);
  });

  it('keeps K and D inside the 0–100 band', () => {
    const result = calculateStochRSI(closes);
    for (const value of [...result.stoch, ...result.k, ...result.d]) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it('exposes StochRSI K/D from calculateIndicators', () => {
    const bars = makeBars(closes);
    const indicators = calculateIndicators(bars);
    expect(indicators[36].stochK).not.toBeNull();
    expect(indicators[36].stochD).toBeNull();
    expect(indicators[37].stochD).not.toBeNull();
  });
});

describe('stochTrend', () => {
  it('is bullish or bearish inside the 20–80 band', () => {
    expect(stochTrend(60, 50)).toBe('bullish');
    expect(stochTrend(40, 55)).toBe('bearish');
    expect(stochTrend(50, 50)).toBe('flat');
  });

  it('is neutral when either line is at or beyond 80/20', () => {
    expect(stochTrend(85, 70)).toBe('neutral');
    expect(stochTrend(70, 85)).toBe('neutral');
    expect(stochTrend(10, 30)).toBe('neutral');
    expect(stochTrend(30, 10)).toBe('neutral');
    expect(stochTrend(80, 70)).toBe('neutral');
    expect(stochTrend(20, 30)).toBe('neutral');
  });

  it('is null while warming up', () => {
    expect(stochTrend(null, 50)).toBeNull();
    expect(stochTrend(50, null)).toBeNull();
  });
});

describe('evaluateSignal', () => {
  const bars = [makeBar(0, 100)];

  it('emits a long signal with a +2.00 target', () => {
    const signal = evaluateSignal(bars, [indicators()]);
    expect(signal).toMatchObject({ action: 'buy', price: 100, tp: 102 });
  });

  it('emits a short signal with a -2.00 target', () => {
    const signal = evaluateSignal(bars, [
      indicators({ ema5m: 101, stochK: 40, stochD: 55 }),
    ]);
    expect(signal).toMatchObject({ action: 'sell', price: 100, tp: 98 });
  });

  it('stays flat when the ADX threshold is not strictly exceeded', () => {
    expect(evaluateSignal(bars, [indicators({ adx: 25 })]).action).toBe('none');
    expect(evaluateSignal(bars, [indicators({ adx: 25.1 })]).action).toBe('buy');
  });

  it('blocks entries while StochRSI is overbought or oversold', () => {
    const overbought = evaluateSignal(bars, [indicators({ stochK: 90, stochD: 85 })]);
    expect(overbought.action).toBe('none');
    expect(overbought.reason).toContain('StochRSI neutral');

    const oversold = evaluateSignal(bars, [
      indicators({ ema5m: 101, stochK: 10, stochD: 15 }),
    ]);
    expect(oversold.action).toBe('none');
    expect(oversold.reason).toContain('StochRSI neutral');
  });

  it('reports warming up while indicators are null', () => {
    const signal = evaluateSignal(bars, [
      indicators({ ema5m: null, stochK: null, stochD: null, adx: null }),
    ]);
    expect(signal.action).toBe('none');
    expect(signal.reason).toBe('Warming up indicators');
  });

  it('handles an empty series', () => {
    const signal = evaluateSignal([]);
    expect(signal.action).toBe('none');
    expect(signal.reason).toBe('No bars available');
  });
});

describe('calculateIndicators', () => {
  it('returns one entry per bar', () => {
    const bars = makeBars(new Array(600).fill(2000));
    const result = calculateIndicators(bars);

    expect(result).toHaveLength(600);
    expect(Number.isFinite(result[599].ema5m)).toBe(true);
  });

  it('returns an empty array for no bars', () => {
    expect(calculateIndicators([])).toEqual([]);
  });
});

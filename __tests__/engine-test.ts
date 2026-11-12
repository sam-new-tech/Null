import {
  adxStrength,
  BOT_LOT_SIZE,
  calculateIndicators,
  calculateVDC,
  evaluateSignal,
  macdTrend,
  maxOpenPositions,
  resample5mEMA,
  takeProfitFor,
  vdcControl,
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
    macdLine: 1,
    macdSignal: 0.5,
    macdHist: 0.5,
    adx: 30,
    vdc: 25,
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

describe('adxStrength', () => {
  it('is strong only strictly above the ADX threshold', () => {
    expect(adxStrength(20)).toBe('weak');
    expect(adxStrength(20.1)).toBe('strong');
    expect(adxStrength(45)).toBe('strong');
  });

  it('is null while warming up', () => {
    expect(adxStrength(null)).toBeNull();
  });
});

describe('macdTrend', () => {
  it('is bullish or bearish from the line-vs-signal order', () => {
    expect(macdTrend(1, 0.5)).toBe('bullish');
    expect(macdTrend(0.5, 1)).toBe('bearish');
    expect(macdTrend(1, 1)).toBe('flat');
  });

  it('is null while either line is warming up', () => {
    expect(macdTrend(null, 0.5)).toBeNull();
    expect(macdTrend(0.5, null)).toBeNull();
  });
});

describe('takeProfitFor', () => {
  it('puts the TP 2.50 away from the live price on both sides', () => {
    expect(takeProfitFor('buy', 2000)).toBe(2002.5);
    expect(takeProfitFor('sell', 2000)).toBe(1997.5);
  });

  it('accepts a custom distance', () => {
    expect(takeProfitFor('buy', 100, 1)).toBe(101);
    expect(takeProfitFor('sell', 100, 1)).toBe(99);
  });
});

describe('calculateVDC', () => {
  it('computes the candle-split control percentage', () => {
    const bars: Bar[] = [
      { ...makeBar(0, 101, 10), open: 100 },
      { ...makeBar(1, 100, 20), open: 101 },
      { ...makeBar(2, 102, 30), open: 100 },
      { ...makeBar(3, 101, 40), open: 102 },
    ];
    const vdc = calculateVDC(bars, 3);

    expect(vdc[0]).toBeNull();
    expect(vdc[1]).toBeNull();
    // Bars 0-2: bull = 10 + 0 + 30 = 40, total = 60, delta = +20.
    expect(vdc[2]).toBeCloseTo((20 / 60) * 100);
    // Bars 1-3: bull = 0 + 30 + 0 = 30, total = 90, delta = -30.
    expect(vdc[3]).toBeCloseTo((-30 / 90) * 100);
  });

  it('splits volume by bar range in range mode', () => {
    const bars: Bar[] = [
      { time: 0, open: 100, high: 103, low: 99, close: 101, volume: 10 },
      { time: 60_000, open: 101, high: 102, low: 100, close: 100, volume: 10 },
    ];
    // Bar 0: rng 4, close-low 2 -> bull 5. Bar 1: rng 2, close-low 0 -> bull 0.
    const vdc = calculateVDC(bars, 2, 'range');
    expect(vdc[0]).toBeNull();
    // bull 5, bear 15 -> delta -10 over total 20 -> -50%.
    expect(vdc[1]).toBeCloseTo(-50);
  });

  it('returns zero when there is no volume', () => {
    const bars = [makeBar(0, 101, 0), makeBar(1, 100, 0), makeBar(2, 102, 0)];
    expect(calculateVDC(bars, 3)[2]).toBe(0);
  });
});

describe('vdcControl', () => {
  it('is buyers/sellers at or beyond ±20 and neutral inside', () => {
    expect(vdcControl(25)).toBe('buyers');
    expect(vdcControl(20)).toBe('buyers');
    expect(vdcControl(-20)).toBe('sellers');
    expect(vdcControl(-25)).toBe('sellers');
    expect(vdcControl(19.99)).toBe('neutral');
    expect(vdcControl(-19.99)).toBe('neutral');
  });

  it('is null while warming up', () => {
    expect(vdcControl(null)).toBeNull();
  });
});

describe('evaluateSignal', () => {
  const bars = [makeBar(0, 100)];

  it('emits a long signal with a +2.50 target', () => {
    const signal = evaluateSignal(bars, [indicators()]);
    expect(signal).toMatchObject({ action: 'buy', price: 100, tp: 102.5 });
  });

  it('emits a short signal with a -2.50 target', () => {
    const signal = evaluateSignal(bars, [
      indicators({ ema5m: 101, macdLine: 0.5, macdSignal: 1, vdc: -25 }),
    ]);
    expect(signal).toMatchObject({ action: 'sell', price: 100, tp: 97.5 });
  });

  it('stays flat when the ADX threshold is not strictly exceeded', () => {
    expect(evaluateSignal(bars, [indicators({ adx: 20 })]).action).toBe('none');
    expect(evaluateSignal(bars, [indicators({ adx: 20.1 })]).action).toBe('buy');
  });

  it('requires MACD line vs signal for direction', () => {
    // Price is above EMA, but MACD is bearish -> no long.
    expect(evaluateSignal(bars, [indicators({ macdLine: 0.5, macdSignal: 1 })]).action).toBe('none');
    // Price is below EMA, but MACD is bullish -> no short.
    expect(
      evaluateSignal(bars, [indicators({ ema5m: 101, macdLine: 1, macdSignal: 0.5, vdc: -25 })]).action,
    ).toBe('none');
    // A flat MACD gives no direction.
    expect(evaluateSignal(bars, [indicators({ macdLine: 1, macdSignal: 1 })]).action).toBe('none');
  });

  it('requires VDC to reach ±20 (inclusive, like the Pine script)', () => {
    expect(evaluateSignal(bars, [indicators({ vdc: 19.99 })]).action).toBe('none');
    expect(evaluateSignal(bars, [indicators({ vdc: 20 })]).action).toBe('buy');
    expect(
      evaluateSignal(bars, [indicators({ ema5m: 101, macdLine: 0.5, macdSignal: 1, vdc: -20 })]).action,
    ).toBe('sell');
    expect(
      evaluateSignal(bars, [indicators({ ema5m: 101, macdLine: 0.5, macdSignal: 1, vdc: -19.99 })]).action,
    ).toBe('none');
  });

  it('reports warming up while indicators are null', () => {
    const signal = evaluateSignal(bars, [
      indicators({ ema5m: null, macdLine: null, macdSignal: null, adx: null, vdc: null }),
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

  it('uses the 14-bar VDC lookback', () => {
    const result = calculateIndicators(makeBars(new Array(20).fill(2000)));
    expect(result[12].vdc).toBeNull();
    expect(result[13].vdc).not.toBeNull();
  });

  it('aligns MACD line and signal after their warm-up', () => {
    const result = calculateIndicators(makeBars(new Array(60).fill(2000)));
    expect(result[24].macdLine).toBeNull();
    expect(result[25].macdLine).not.toBeNull();
    expect(result[40].macdSignal).not.toBeNull();
  });
});

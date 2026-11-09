import {
  asArray,
  money,
  normalizeSymbolName,
  scaleSpot,
  secondsSinceMessage,
} from '@/lib/ctrader/wire';

describe('scaleSpot', () => {
  it('scales 1e5 integers', () => {
    expect(scaleSpot(414613000)).toBeCloseTo(4146.13);
    expect(scaleSpot(108520)).toBeCloseTo(1.0852);
  });

  it('passes pre-flattened doubles through', () => {
    expect(scaleSpot(4146.13)).toBe(4146.13);
  });

  it('rejects non-finite and non-number input', () => {
    expect(scaleSpot(Number.NaN)).toBeNull();
    expect(scaleSpot(Infinity)).toBeNull();
    expect(scaleSpot('4146.13')).toBeNull();
    expect(scaleSpot(undefined)).toBeNull();
  });
});

describe('secondsSinceMessage', () => {
  it('returns infinity before the first frame', () => {
    expect(secondsSinceMessage(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns elapsed seconds and never goes negative', () => {
    expect(secondsSinceMessage(1_000, 4_500)).toBe(3.5);
    expect(secondsSinceMessage(5_000, 4_000)).toBe(0);
  });
});

describe('normalizeSymbolName', () => {
  it('strips slashes and upper-cases', () => {
    expect(normalizeSymbolName('xau/usd')).toBe('XAUUSD');
    expect(normalizeSymbolName('EURUSD')).toBe('EURUSD');
  });
});

describe('money', () => {
  it('scales by 10^digits and defaults to cents', () => {
    expect(money(12345, 2)).toBe(123.45);
    expect(money(12345, 5)).toBe(0.12345);
    expect(money(100, undefined)).toBe(1);
  });

  it('treats missing values as zero', () => {
    expect(money(undefined, 2)).toBe(0);
  });
});

describe('asArray', () => {
  it('passes arrays through and wraps single objects', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
  });

  it('returns an empty array for nullish input', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });
});

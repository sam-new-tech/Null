import {
  formatIndicator,
  formatLots,
  formatMoney,
  formatPlainMoney,
  formatPrice,
} from '@/lib/format';

describe('formatMoney', () => {
  it('prefixes profit with + and loss with -', () => {
    expect(formatMoney(12.34)).toBe('+$12.34');
    expect(formatMoney(-5)).toBe('-$5.00');
    expect(formatMoney(0)).toBe('+$0.00');
  });

  it('never renders NaN or Infinity', () => {
    expect(formatMoney(Number.NaN)).toBe('+$0.00');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('+$0.00');
  });
});

describe('formatPlainMoney', () => {
  it('renders unsigned currency', () => {
    expect(formatPlainMoney(753.14)).toBe('$753.14');
    expect(formatPlainMoney(Number.NaN)).toBe('$0.00');
  });
});

describe('formatPrice', () => {
  it('uses four decimals for sub-$10 reference symbols', () => {
    expect(formatPrice('EURUSD', 1.0852)).toBe('1.0852');
  });

  it('uses two decimals for everything else', () => {
    expect(formatPrice('XAUUSD', 2415.3)).toBe('2415.30');
    expect(formatPrice('USDJPY', 151.2)).toBe('151.20');
    expect(formatPrice('UNKNOWN', 12.345)).toBe('12.35');
  });

  it('handles non-finite values', () => {
    expect(formatPrice('XAUUSD', Number.NaN)).toBe('0.00');
  });
});

describe('formatLots', () => {
  it('renders two decimals', () => {
    expect(formatLots(0.1)).toBe('0.10');
    expect(formatLots(2)).toBe('2.00');
  });

  it('renders an em dash for bad input', () => {
    expect(formatLots(Number.NaN)).toBe('—');
  });
});

describe('formatIndicator', () => {
  it('renders fixed decimals', () => {
    expect(formatIndicator(2415.3, 2)).toBe('2415.30');
    expect(formatIndicator(27.456, 1)).toBe('27.5');
    expect(formatIndicator(0, 1)).toBe('0.0');
  });

  it('renders an em dash while warming up or on bad data', () => {
    expect(formatIndicator(null, 2)).toBe('—');
    expect(formatIndicator(undefined, 2)).toBe('—');
    expect(formatIndicator(Number.NaN, 2)).toBe('—');
    expect(formatIndicator(Number.POSITIVE_INFINITY, 2)).toBe('—');
  });
});

import { decimalsForSymbol } from '@/constants/markets';

const usdCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** Signed money for P/L display: `+$12.34`, `-$5.00`. */
export function formatMoney(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  const formatted = usdCurrency.format(Math.abs(safe));
  return safe < 0 ? `-${formatted}` : `+${formatted}`;
}

/** Unsigned money for balances and equity: `$753.14`. */
export function formatPlainMoney(value: number): string {
  return usdCurrency.format(Number.isFinite(value) ? value : 0);
}

/** Price with the symbol-appropriate number of decimals. */
export function formatPrice(symbol: string, value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return safe.toFixed(decimalsForSymbol(symbol));
}

/** Display-safe lots with exactly two decimals (never throws on bad data). */
export function formatLots(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

/**
 * Indicator value with fixed decimals, or an em dash while the indicator is
 * still warming up (`null`) or the feed delivers a non-finite number.
 */
export function formatIndicator(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

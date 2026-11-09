/**
 * Reference prices used by the demo feed and price formatting.
 * Keys are normalized symbol names (no slash, upper case).
 */
export const REFERENCE_PRICES: Record<string, number> = {
  EURUSD: 1.0852,
  GBPUSD: 1.2694,
  XAUUSD: 2415.3,
  BTCUSD: 97400,
  US30: 44250,
  USDJPY: 151.2,
};

/**
 * Decimal places for a symbol's price. Sub-$10 instruments quote four
 * decimals; everything else quotes two. Unknown symbols default to two.
 */
export function decimalsForSymbol(symbol: string): number {
  const reference = REFERENCE_PRICES[symbol] ?? 100;
  return reference < 10 ? 4 : 2;
}

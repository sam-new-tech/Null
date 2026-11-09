/**
 * Market-hours helpers.
 *
 * The app trades CFDs (XAU/USD and majors), which stop quoting over the
 * weekend. Broker confirmations for orders placed then only land at the
 * Sunday open, so screens warn instead of pretending the request was lost.
 */

/** True on Saturday and Sunday, when the broker is closed. */
export function isWeekendMarketClosed(date: Date = new Date()): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

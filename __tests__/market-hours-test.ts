import { isWeekendMarketClosed } from '@/lib/market-hours';

describe('isWeekendMarketClosed', () => {
  it('closes on Saturday and Sunday', () => {
    // 2026-11-07 is a Saturday, 2026-11-08 a Sunday (local time).
    expect(isWeekendMarketClosed(new Date(2026, 10, 7, 12))).toBe(true);
    expect(isWeekendMarketClosed(new Date(2026, 10, 8, 12))).toBe(true);
  });

  it('is open Monday through Friday', () => {
    expect(isWeekendMarketClosed(new Date(2026, 10, 6, 12))).toBe(false); // Friday
    expect(isWeekendMarketClosed(new Date(2026, 10, 9, 12))).toBe(false); // Monday
  });
});

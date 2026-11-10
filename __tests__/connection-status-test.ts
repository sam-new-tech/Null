import { connectionBannerLabel } from '@/lib/connection-status';

const fresh = { socket: 'open', staleSeconds: 1, stale: false };

describe('connectionBannerLabel', () => {
  it('stays quiet in demo mode (idle)', () => {
    expect(connectionBannerLabel('idle', null, { socket: 'closed', staleSeconds: -1, stale: false })).toBeNull();
  });

  it('stays quiet only when ready, open and fresh', () => {
    expect(connectionBannerLabel('ready', null, fresh)).toBeNull();
    expect(connectionBannerLabel('ready', null, { ...fresh, stale: true })).toBe(
      'Stream stale — reconnecting…',
    );
    expect(connectionBannerLabel('ready', null, { ...fresh, socket: 'connecting' })).toBe(
      'Reconnecting to cTrader…',
    );
    expect(connectionBannerLabel('ready', null, { ...fresh, socket: 'closed' })).toBe(
      'Reconnecting to cTrader…',
    );
  });

  it('surfaces connecting and error states', () => {
    expect(connectionBannerLabel('connecting', null, { ...fresh, socket: 'connecting' })).toBe(
      'Connecting to cTrader…',
    );
    expect(connectionBannerLabel('error', null, { ...fresh, socket: 'closed' })).toBe(
      'Connection failed',
    );
    expect(connectionBannerLabel('error', 'Bad token', { ...fresh, socket: 'closed' })).toBe(
      'Bad token',
    );
  });
});

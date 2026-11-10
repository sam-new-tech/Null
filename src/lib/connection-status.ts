/**
 * Connection banner copy. Kept pure so the state matrix (idle / connecting /
 * ready / error + socket + stale) is unit-testable without React.
 */

export type LiveStatus = 'idle' | 'connecting' | 'ready' | 'error';

export interface ConnectionHealth {
  socket: string;
  staleSeconds: number;
  stale: boolean;
}

/**
 * Returns the banner message, or `null` when the screen should stay quiet.
 *
 * - `idle` means no connection is intended (demo build) — show nothing.
 * - `ready` is only quiet while the socket is actually open and the stream
 *   is fresh; a silent reconnect or stale stream must still warn the user.
 */
export function connectionBannerLabel(
  status: LiveStatus,
  error: string | null,
  health: ConnectionHealth,
): string | null {
  if (status === 'idle') return null;
  if (status === 'ready' && health.socket === 'open' && !health.stale) return null;
  if (status === 'error') return error ?? 'Connection failed';
  if (status === 'connecting') return 'Connecting to cTrader…';
  if (health.stale) return 'Stream stale — reconnecting…';
  if (health.socket !== 'open') return 'Reconnecting to cTrader…';
  return 'Connecting…';
}

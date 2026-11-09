import { storeDel, storeGet, storeSet } from '../storage';

export interface CTraderSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  ctidTraderAccountId: number;
  isLive: boolean;
}

const KEYS = {
  accessToken: 'ctrader.accessToken',
  refreshToken: 'ctrader.refreshToken',
  expiresAt: 'ctrader.expiresAt',
  accountId: 'ctrader.accountId',
  isLive: 'ctrader.isLive',
} as const;

/**
 * Token vault. Backend is storage.ts (SecureStore native, localStorage web,
 * memory fallback). Keys unchanged (shared with older installs).
 */
async function get(key: keyof typeof KEYS): Promise<string | null> {
  return storeGet(KEYS[key]);
}

async function set(key: keyof typeof KEYS, value: string): Promise<void> {
  await storeSet(KEYS[key], value);
}

async function del(key: keyof typeof KEYS): Promise<void> {
  await storeDel(KEYS[key]);
}

export async function saveSession(session: CTraderSession): Promise<void> {
  await Promise.all([
    set('accessToken', session.accessToken),
    set('refreshToken', session.refreshToken),
    set('expiresAt', String(session.expiresAt)),
    set('accountId', String(session.ctidTraderAccountId)),
    set('isLive', session.isLive ? '1' : '0'),
  ]);
}

export async function loadSession(): Promise<CTraderSession | null> {
  const [accessToken, refreshToken, expiresAt, accountId, isLive] = await Promise.all([
    get('accessToken'),
    get('refreshToken'),
    get('expiresAt'),
    get('accountId'),
    get('isLive'),
  ]);
  if (!accessToken || !refreshToken || !expiresAt || !accountId) return null;
  const expiresAtMs = Number(expiresAt);
  const accountIdNum = Number(accountId);
  // Corrupt stores ("undefined", "abc") must not poison token math or auth.
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(accountIdNum) || accountIdNum <= 0) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: expiresAtMs,
    ctidTraderAccountId: accountIdNum,
    isLive: isLive === '1',
  };
}

export async function clearSession(): Promise<void> {
  await Promise.all(
    (Object.keys(KEYS) as (keyof typeof KEYS)[]).map((key) => del(key)),
  );
}

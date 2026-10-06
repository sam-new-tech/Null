import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

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
 * Token vault. Native: SecureStore (Keychain / EncryptedSharedPreferences).
 * Web: localStorage (SecureStore has no usable web backend here).
 * Memory fallback keeps the UI working if both fail.
 */
let memory: Partial<Record<keyof typeof KEYS, string>> = {};

const webStore =
  Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage
    ? window.localStorage
    : null;

async function get(key: keyof typeof KEYS): Promise<string | null> {
  if (webStore) return webStore.getItem(KEYS[key]) ?? memory[key] ?? null;
  try {
    const value = await SecureStore.getItemAsync(KEYS[key]);
    if (value !== null) return value;
  } catch {
    // Fall through to memory.
  }
  return memory[key] ?? null;
}

async function set(key: keyof typeof KEYS, value: string): Promise<void> {
  if (webStore) {
    try {
      webStore.setItem(KEYS[key], value);
      return;
    } catch {
      memory[key] = value;
      return;
    }
  }
  try {
    await SecureStore.setItemAsync(KEYS[key], value);
  } catch {
    memory[key] = value;
  }
}

async function del(key: keyof typeof KEYS): Promise<void> {
  delete memory[key];
  if (webStore) {
    try {
      webStore.removeItem(KEYS[key]);
    } catch {
      // Ignore.
    }
  }
  try {
    await SecureStore.deleteItemAsync(KEYS[key]);
  } catch {
    // Ignore — memory already cleared.
  }
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
  return {
    accessToken,
    refreshToken,
    expiresAt: Number(expiresAt),
    ctidTraderAccountId: Number(accountId),
    isLive: isLive === '1',
  };
}

export async function clearSession(): Promise<void> {
  await Promise.all(
    (Object.keys(KEYS) as (keyof typeof KEYS)[]).map((key) => del(key)),
  );
  memory = {};
}

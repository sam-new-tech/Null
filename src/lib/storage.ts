import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Tiny key-value store: SecureStore on native (Keychain / EncryptedSharedPreferences),
 * localStorage on web, memory fallback. Used for tokens AND engine state.
 */
let memory = new Map<string, string>();

const webStore =
  Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage
    ? window.localStorage
    : null;

export async function storeGet(key: string): Promise<string | null> {
  if (webStore) {
    try {
      return webStore.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  }
  try {
    const value = await SecureStore.getItemAsync(key);
    if (value !== null) return value;
  } catch {
    // Fall through to memory.
  }
  return memory.get(key) ?? null;
}

export async function storeSet(key: string, value: string): Promise<void> {
  if (webStore) {
    try {
      webStore.setItem(key, value);
      return;
    } catch {
      memory.set(key, value);
      return;
    }
  }
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    memory.set(key, value);
  }
}

export async function storeDel(key: string): Promise<void> {
  memory.delete(key);
  if (webStore) {
    try {
      webStore.removeItem(key);
    } catch {
      // Ignore.
    }
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // Ignore — memory already cleared.
  }
}

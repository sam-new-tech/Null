import Constants from 'expo-constants';
import { Platform } from 'react-native';

type NotificationsModule = typeof import('expo-notifications');

let cached: NotificationsModule | null | undefined;

/**
 * Expo Go (SDK 53+) throws at import time for expo-notifications — the native
 * push module was removed from Go. Lazy-load it and no-op in Go/web so the
 * import chain (runner -> auth -> layout) never crashes the router.
 */
function load(): NotificationsModule | null {
  if (cached !== undefined) return cached;
  try {
    if (Platform.OS === 'web') {
      cached = null;
      return cached;
    }
    if (Constants.appOwnership === 'expo') {
      cached = null;
      return cached;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-notifications') as NotificationsModule;
  } catch {
    cached = null;
  }
  return cached;
}

export async function notify(title: string, body: string): Promise<void> {
  const mod = load();
  if (!mod) return;
  try {
    await mod.scheduleNotificationAsync({
      content: { title, body },
      // Immediate local notification. `as never` keeps TS happy across SDK trigger-type changes.
      trigger: null as never,
    });
  } catch {
    // Notifications are best-effort — logs still persist in-app.
  }
}

export async function ensureNotifyPermissions(): Promise<void> {
  const mod = load();
  if (!mod) return;
  try {
    const { status } = await mod.getPermissionsAsync();
    if (status !== 'granted') await mod.requestPermissionsAsync();
  } catch {
    // Optional.
  }
}

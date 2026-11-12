import Constants from 'expo-constants';
import { Platform } from 'react-native';

type NotificationsModule = typeof import('expo-notifications');

/** Which bundled sound a bot notification should play. */
export type NotifySound = 'entry' | 'exit';

const SOUND_FILE: Record<NotifySound, string> = {
  entry: 'entry.wav',
  exit: 'exit.wav',
};

/**
 * Android 8+ fixes the sound on the notification channel, so each sound needs
 * its own channel. The config plugin copies the .wav files into res/raw.
 */
const CHANNEL: Record<NotifySound, { id: string; name: string }> = {
  entry: { id: 'bot_entry', name: 'Bot entries' },
  exit: { id: 'bot_exit', name: 'Bot exits' },
};

let cached: NotificationsModule | null | undefined;
let channelsReady: Promise<void> | null = null;

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

/** Create the two custom-sound channels once per app session (Android only). */
function ensureChannels(mod: NotificationsModule): Promise<void> {
  if (channelsReady) return channelsReady;

  channelsReady = (async () => {
    if (Platform.OS !== 'android') return;
    for (const sound of Object.keys(CHANNEL) as NotifySound[]) {
      const channel = CHANNEL[sound];
      try {
        await mod.setNotificationChannelAsync(channel.id, {
          name: channel.name,
          importance: mod.AndroidImportance.HIGH,
          sound: SOUND_FILE[sound],
          enableVibrate: true,
        });
      } catch {
        // Channel setup is best-effort; the fallback channel still notifies.
      }
    }
  })();

  return channelsReady;
}

export async function notify(
  title: string,
  body: string,
  sound: NotifySound = 'entry',
): Promise<void> {
  const mod = load();
  if (!mod) return;
  try {
    await ensureChannels(mod);
    await mod.scheduleNotificationAsync({
      content: {
        title,
        body,
        // iOS plays the bundled file directly; Android <8 also honours this.
        sound: SOUND_FILE[sound],
      },
      // A channel-aware trigger is immediate and routes Android through the
      // channel that owns the custom sound.
      trigger: { channelId: CHANNEL[sound].id },
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

/**
 * Notification-path tests.
 *
 * `src/lib/notify.ts` lazy-loads expo-notifications so that web, Expo Go (which
 * dropped the native module in SDK 53) and import-time failures degrade to a
 * no-op instead of crashing the router. These tests drive the real module in an
 * isolated registry per case and assert the SDK 57 contract:
 * - the foreground handler is registered once (otherwise local notifications
 *   received while the app is open are discarded);
 * - Android gets one HIGH-importance channel per bundled sound;
 * - iOS skips channels and plays the bundled file directly;
 * - entry/exit map to `entry.wav`/`exit.wav` and their channel ids;
 * - permissions are requested only when not already granted;
 * - every failure is swallowed because alerts are best-effort.
 */

import { Platform } from 'react-native';

const mockRequireCount = { value: 0 };

const mockSetNotificationHandler = jest.fn();
const mockSetNotificationChannelAsync = jest.fn(async () => undefined);
const mockScheduleNotificationAsync = jest.fn(async () => 'notification-id');
const mockGetPermissionsAsync = jest.fn(async () => ({ status: 'granted' }));
const mockRequestPermissionsAsync = jest.fn(async () => ({ status: 'granted' }));

const mockAndroidImportance = { HIGH: 4 };
const mockConstants = { appOwnership: null as string | null };

const mockNativeModule = {
  setNotificationHandler: mockSetNotificationHandler,
  setNotificationChannelAsync: mockSetNotificationChannelAsync,
  scheduleNotificationAsync: mockScheduleNotificationAsync,
  getPermissionsAsync: mockGetPermissionsAsync,
  requestPermissionsAsync: mockRequestPermissionsAsync,
  AndroidImportance: mockAndroidImportance,
};

jest.mock('expo-notifications', () => {
  mockRequireCount.value += 1;
  return mockNativeModule;
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: mockConstants,
}));

type NotifyModule = typeof import('@/lib/notify');

/** Re-evaluate `notify.ts` with a clean module-level cache. */
function freshNotify(): NotifyModule {
  let mod!: NotifyModule;
  jest.isolateModules(() => {
    mod = require('@/lib/notify') as NotifyModule;
  });
  return mod;
}

function setPlatform(os: 'ios' | 'android' | 'web'): void {
  (Platform as unknown as { OS: string }).OS = os;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCount.value = 0;
  mockConstants.appOwnership = null;
  setPlatform('ios');

  mockSetNotificationChannelAsync.mockResolvedValue(undefined);
  mockScheduleNotificationAsync.mockResolvedValue('notification-id');
  mockGetPermissionsAsync.mockResolvedValue({ status: 'granted' });
  mockRequestPermissionsAsync.mockResolvedValue({ status: 'granted' });
});

afterAll(() => {
  setPlatform('ios');
});

describe('availability guards', () => {
  it('no-ops on web without loading the native module', async () => {
    setPlatform('web');
    const { notify, ensureNotifyPermissions } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD', 'entry');
    await ensureNotifyPermissions();

    expect(mockRequireCount.value).toBe(0);
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockGetPermissionsAsync).not.toHaveBeenCalled();
  });

  it('no-ops in Expo Go without loading the native module', async () => {
    mockConstants.appOwnership = 'expo';
    const { notify, ensureNotifyPermissions } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD', 'entry');
    await ensureNotifyPermissions();

    expect(mockRequireCount.value).toBe(0);
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('no-ops when the native module cannot be imported', async () => {
    jest.doMock('expo-notifications', () => {
      throw new Error('native module unavailable');
    });
    const { notify, ensureNotifyPermissions } = freshNotify();

    await expect(notify('Bot filled', 'BUY XAUUSD', 'entry')).resolves.toBeUndefined();
    await expect(ensureNotifyPermissions()).resolves.toBeUndefined();

    // Restore the working factory for any later require in this file.
    jest.doMock('expo-notifications', () => {
      mockRequireCount.value += 1;
      return mockNativeModule;
    });
  });
});

describe('foreground handler', () => {
  it('registers a handler that shows, lists and sounds the notification', async () => {
    const { notify } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD', 'entry');

    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
    const handler = mockSetNotificationHandler.mock.calls[0][0] as {
      handleNotification: () => Promise<Record<string, boolean>>;
    };
    await expect(handler.handleNotification()).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
  });

  it('registers the handler only once across notifications', async () => {
    const { notify } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD', 'entry');
    await notify('Bot closed', 'XAUUSD P/L +$2.50', 'exit');

    expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
  });
});

describe('channel setup', () => {
  it('creates one HIGH-importance Android channel per bundled sound', async () => {
    setPlatform('android');
    const { notify } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD', 'entry');

    expect(mockSetNotificationChannelAsync).toHaveBeenCalledTimes(2);
    expect(mockSetNotificationChannelAsync).toHaveBeenCalledWith('bot_entry', {
      name: 'Bot entries',
      importance: mockAndroidImportance.HIGH,
      sound: 'entry.wav',
      enableVibrate: true,
    });
    expect(mockSetNotificationChannelAsync).toHaveBeenCalledWith('bot_exit', {
      name: 'Bot exits',
      importance: mockAndroidImportance.HIGH,
      sound: 'exit.wav',
      enableVibrate: true,
    });
  });

  it('creates channels once per app session', async () => {
    setPlatform('android');
    const { notify } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD', 'entry');
    await notify('Bot closed', 'XAUUSD P/L -$1.00', 'exit');

    expect(mockSetNotificationChannelAsync).toHaveBeenCalledTimes(2);
  });

  it('skips channels on iOS', async () => {
    const { notify } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD', 'entry');

    expect(mockSetNotificationChannelAsync).not.toHaveBeenCalled();
    expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('still schedules when channel creation fails', async () => {
    setPlatform('android');
    mockSetNotificationChannelAsync.mockRejectedValue(new Error('bad channel'));
    const { notify } = freshNotify();

    await expect(notify('Bot filled', 'BUY XAUUSD', 'entry')).resolves.toBeUndefined();

    expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});

describe('sound and channel mapping', () => {
  it('routes entry alerts through entry.wav and bot_entry', async () => {
    const { notify } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD @ 2000.50', 'entry');

    expect(mockScheduleNotificationAsync).toHaveBeenCalledWith({
      content: {
        title: 'Bot filled',
        body: 'BUY XAUUSD @ 2000.50',
        sound: 'entry.wav',
      },
      trigger: { channelId: 'bot_entry' },
    });
  });

  it('routes exit alerts through exit.wav and bot_exit', async () => {
    const { notify } = freshNotify();

    await notify('Bot closed', 'XAUUSD P/L +$2.50', 'exit');

    expect(mockScheduleNotificationAsync).toHaveBeenCalledWith({
      content: {
        title: 'Bot closed',
        body: 'XAUUSD P/L +$2.50',
        sound: 'exit.wav',
      },
      trigger: { channelId: 'bot_exit' },
    });
  });

  it('defaults to the entry sound', async () => {
    const { notify } = freshNotify();

    await notify('Bot filled', 'BUY XAUUSD');

    expect(mockScheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ sound: 'entry.wav' }),
        trigger: { channelId: 'bot_entry' },
      }),
    );
  });
});

describe('permissions', () => {
  it('does not request when permission is already granted', async () => {
    const { ensureNotifyPermissions } = freshNotify();

    await ensureNotifyPermissions();

    expect(mockGetPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('requests permission when the status is not granted', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ status: 'denied' });
    const { ensureNotifyPermissions } = freshNotify();

    await ensureNotifyPermissions();

    expect(mockRequestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('swallows permission errors', async () => {
    mockGetPermissionsAsync.mockRejectedValue(new Error('permission API failed'));
    const { ensureNotifyPermissions } = freshNotify();

    await expect(ensureNotifyPermissions()).resolves.toBeUndefined();
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('swallows scheduling errors', async () => {
    mockScheduleNotificationAsync.mockRejectedValue(new Error('scheduling failed'));
    const { notify } = freshNotify();

    await expect(notify('Bot filled', 'BUY XAUUSD', 'entry')).resolves.toBeUndefined();
  });
});

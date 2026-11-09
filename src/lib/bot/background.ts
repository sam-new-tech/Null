import { Platform } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { botRunner } from './runner';

export const GRID_TASK = 'null-grid-tick';

/**
 * Background reconcile tick. Must be defined at module scope and this module
 * imported early (root layout) so the OS can wake the JS and find the task.
 * Budget ~30s: quick reconcile, then exit. Trading intents are best-effort;
 * server-side TPs/SLs always protect exits.
 * OS reality: minimum interval is ~15min (Android) and background execution
 * is heavily throttled on iOS — the foreground SpotEvent stream is the
 * realtime path; this is a safety net only.
 */
if (Platform.OS !== 'web') {
  TaskManager.defineTask(GRID_TASK, async () => {
    try {
      const ok = await botRunner.backgroundTick();
      return ok ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerGridTask(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await BackgroundTask.registerTaskAsync(GRID_TASK, { minimumInterval: 15 });
  } catch {
    // Background execution unavailable — foreground loop still covers trading.
  }
}

export async function unregisterGridTask(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await BackgroundTask.unregisterTaskAsync(GRID_TASK);
  } catch {
    // Best effort.
  }
}

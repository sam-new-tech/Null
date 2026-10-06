import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { botRunner } from './runner';

export const GRID_TASK = 'null-grid-tick';

/**
 * Background reconcile tick. Must be defined at module scope and this module
 * imported early (root layout) so the OS can wake the JS and find the task.
 * Budget ~30s: quick reconcile, then exit. Trading intents are best-effort;
 * server-side TPs/SLs always protect exits.
 */
TaskManager.defineTask(GRID_TASK, async () => {
  try {
    const ok = await botRunner.backgroundTick();
    return ok ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerGridTask(): Promise<void> {
  try {
    await BackgroundTask.registerTaskAsync(GRID_TASK, { minimumInterval: 15 });
  } catch {
    // Background execution unavailable — foreground loop still covers trading.
  }
}

export async function unregisterGridTask(): Promise<void> {
  try {
    await BackgroundTask.unregisterTaskAsync(GRID_TASK);
  } catch {
    // Best effort.
  }
}

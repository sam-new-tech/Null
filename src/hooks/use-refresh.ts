import { useState } from 'react';

export interface RefreshState {
  refreshing: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
}

/**
 * Shared pull-to-refresh behaviour for the tab screens: guards against
 * double triggers, clears the previous error, and surfaces a readable
 * message on failure.
 */
export function useRefresh(refresh: () => Promise<void>): RefreshState {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRefresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  return { refreshing, error, onRefresh };
}

import { Pressable, View } from 'react-native';

import { connectionBannerLabel } from '@/lib/connection-status';
import { liveEngine, useLive } from '@/lib/ctrader/live';
import { Text } from '@/components/text';

/**
 * Realtime connection banner. Purely event-driven:
 * - engine `connecting`/`error` status shows instantly,
 * - stream staleness (watchdog) surfaces without polling,
 * - tap retries a full snapshot.
 * Renders nothing when healthy so it costs zero layout.
 */
export function ConnectionBanner({ onRetry }: { onRetry?: () => void }) {
  const live = useLive();
  const label = connectionBannerLabel(live.status, live.error, liveEngine.health());

  if (!label) return null;

  return (
    <View className="flex-row items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-2.5">
      <View className="flex-1 flex-row items-center gap-2">
        <View className="h-2 w-2 rounded-full bg-destructive" />
        <Text size="sm" weight="medium" numberOfLines={2}>
          {label}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry connection"
        hitSlop={8}
        onPress={() => {
          if (onRetry) onRetry();
          else void liveEngine.refresh();
        }}
        className="rounded-full bg-secondary px-4 py-2.5">
        <Text size="sm" weight="bold">
          Retry
        </Text>
      </Pressable>
    </View>
  );
}

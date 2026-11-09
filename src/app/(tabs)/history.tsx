import { memo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { LiveBadge, ScreenHeader } from '@/components/screen-header';
import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { GlassSheen } from '@/components/glass-sheen';
import { ConnectionBanner } from '@/components/connection-banner';
import { ScreenErrorBoundary } from '@/components/screen-error-boundary';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { formatLots, formatMoney } from '@/hooks/use-mock-account';
import { useTrading } from '@/lib/trading/useTrading';
import { liveEngine } from '@/lib/ctrader/live';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { Text } from 'panelui-native/primitives/text';

const PAGE_SIZE = 7;

const HistoryRow = memo(function HistoryRow({
  t,
}: {
  t: { id: number; symbol: string; side: 'buy' | 'sell'; volume: number; pl: number; time: string };
}) {
  const win = t.pl >= 0;
  return (
    <Card>
      <GlassSheen />
      <Card.Content className="gap-1 px-5 py-3">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            <Text
              size="xs"
              weight="bold"
              className={t.side === 'buy' ? 'text-success' : 'text-destructive'}>
              {t.side === 'buy' ? 'BUY' : 'SELL'}
            </Text>
            <Text weight="medium">{t.symbol}</Text>
            <Text size="sm" muted>
              {formatLots(t.volume)}
            </Text>
          </View>
          <Text
            weight="semibold"
            className={`font-mono ${win ? 'text-success' : 'text-destructive'}`}>
            {formatMoney(t.pl)}
          </Text>
        </View>
        <Text size="xs" muted className="font-mono">
          {t.time} · closed
        </Text>
      </Card.Content>
    </Card>
  );
});

export default function HistoryScreen() {
  const { history, live } = useTrading();
  const [page, setPage] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await liveEngine.refresh();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = history.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const total = history.reduce((sum, t) => sum + t.pl, 0);
  const up = total >= 0;

  return (
    <ScreenErrorBoundary key={live ? 'live' : 'demo'}>
    <View className="flex-1 bg-background">
      <ChartBackdrop />
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingBottom: TAB_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
        <View className="gap-4 p-4">
          <ScreenHeader title="History" />
          <ConnectionBanner />
          {refreshError ? (
            <Text size="sm" className="text-center text-destructive">
              {refreshError}
            </Text>
          ) : null}
          <LiveBadge live={live} />
          {history.length === 0 ? (
            <Card className="rounded-full">
              <GlassSheen radius={999} />
              <Card.Content className="items-center py-4">
                <Text muted>No closed trades yet</Text>
              </Card.Content>
            </Card>
          ) : (
          <View className="gap-2">
            {visible.map((t) => (
              <HistoryRow key={t.id} t={t} />
            ))}
          </View>
        )}
        {history.length > 0 && (
          <Card>
            <GlassSheen />
            <Card.Content className="flex-row items-center justify-between px-5 py-3">
              <Text size="sm" muted className="uppercase tracking-widest">
                Total closed
              </Text>
              <Text weight="bold" className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
                {formatMoney(total)}
              </Text>
            </Card.Content>
          </Card>
        )}
        {totalPages > 1 && (
          <View className="flex-row items-center justify-between">
            <Button
              size="sm"
              variant="outline"
              disabled={safePage <= 1}
              onPress={() => setPage((p) => Math.max(1, p - 1))}>
              Prev
            </Button>
            <Text size="sm" muted>
              {`Page ${safePage} of ${totalPages}`}
            </Text>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage >= totalPages}
              onPress={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next
            </Button>
          </View>
        )}
      </View>
    </ScrollView>
    </View>
    </ScreenErrorBoundary>
  );
}

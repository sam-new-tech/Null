import { memo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { PositionsCard } from '@/components/home/positions-card';
import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { GlassSheen } from '@/components/glass-sheen';
import { ConnectionBanner } from '@/components/connection-banner';
import { ScreenErrorBoundary } from '@/components/screen-error-boundary';
import { LiveBadge, ScreenHeader } from '@/components/screen-header';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { formatLots, formatMoney, formatPrice } from '@/hooks/use-mock-account';
import { useTrading } from '@/lib/trading/useTrading';
import { liveEngine } from '@/lib/ctrader/live';
import { botRunner } from '@/lib/bot/runner';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { Dialog } from 'panelui-native/components/dialog';
import { Text } from 'panelui-native/primitives/text';
import { ChevronDownIcon } from 'panelui-native/icons';

type Tab = 'positions' | 'orders';

const OrderRow = memo(function OrderRow({ order, last }: {
  order: { id: string; symbol: string; side: 'buy' | 'sell'; volume: number; limitPrice: number; stopLoss: number; takeProfit: number };
  last: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className={last && !expanded ? '' : 'border-b border-border'}>
      <Pressable onPress={() => setExpanded((e) => !e)} className="flex-row items-center justify-between py-3">
        <View className="flex-row items-center gap-2">
          <Text
            size="xs"
            weight="bold"
            className={order.side === 'buy' ? 'text-success' : 'text-destructive'}>
            {order.side === 'buy' ? 'BUY' : 'SELL'}
          </Text>
          <Text weight="medium">{order.symbol}</Text>
          <Text size="sm" muted>
            {formatLots(order.volume)}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text weight="semibold" className="font-mono">
            {formatPrice(order.symbol, order.limitPrice)}
          </Text>
          <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
            <ChevronDownIcon size={16} />
          </View>
        </View>
      </Pressable>
      {expanded && (
        <View className="pb-3">
          <View className="flex-row items-center justify-between py-1.5">
            <Text size="sm" muted className="uppercase tracking-widest">TP</Text>
            <Text size="sm" weight="medium" className="font-mono">
              {order.takeProfit ? formatPrice(order.symbol, order.takeProfit) : '—'}
            </Text>
          </View>
          <View className="flex-row items-center justify-between py-1.5">
            <Text size="sm" muted className="uppercase tracking-widest">SL</Text>
            <Text size="sm" weight="medium" className="font-mono">
              {order.stopLoss ? formatPrice(order.symbol, order.stopLoss) : '—'}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
});

export default function TradesScreen() {
  const { positions, orders, live } = useTrading();
  const [tab, setTab] = useState<Tab>('positions');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const total = positions.reduce((sum, p) => sum + p.pl, 0);
  const up = total >= 0;

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

  const closeAll = async () => {
    if (closing) return;
    setClosing(true);
    setCloseError(null);
    try {
      // Positions tab flattens fills; Orders tab cancels limits only.
      await botRunner.flattenAll(false, undefined, tab === 'orders' ? 'orders' : 'positions');
      await liveEngine.refresh();
      setConfirmOpen(false);
    } catch (err) {
      // Keep the dialog open on failure so the error is seen in context.
      setCloseError(err instanceof Error ? err.message : 'Close failed — retry');
    } finally {
      setClosing(false);
    }
  };
  const isOrders = tab === 'orders';
  // XAUUSD is closed on weekends — the broker confirms nothing until open.
  const weekend = (() => {
    const d = new Date();
    const day = d.getDay();
    return day === 0 || day === 6;
  })();

  return (
    <ScreenErrorBoundary key={live ? 'live' : 'demo'}>
    <View className="flex-1 bg-background">
      <ChartBackdrop />
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingBottom: TAB_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
        <View className="gap-4 p-4">
          <ScreenHeader title="Trades" />
          <ConnectionBanner />
          {refreshError ? (
            <Text size="sm" className="text-center text-destructive">
              {refreshError}
            </Text>
          ) : null}
          <LiveBadge live={live} />
        <View className="flex-row gap-2">
          {(['positions', 'orders'] as Tab[]).map((t) => {
            const active = tab === t;
            const count = t === 'positions' ? positions.length : orders.length;
            return (
              <Pressable
                key={t}
                onPress={() => setTab(t)}
                className={`flex-1 flex-row items-center justify-center gap-2 rounded-full border px-4 py-2.5 ${
                  active ? 'border-transparent bg-secondary' : 'border-border'
                }`}>
                <Text weight={active ? 'bold' : 'normal'} className={active ? '' : 'text-muted-foreground'}>
                  {t === 'positions' ? 'Positions' : 'Orders'}
                </Text>
                <Text size="sm" muted>
                  {count}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {tab === 'positions' ? (
          <>
            <PositionsCard positions={positions} allowClose={live} />
            {positions.length > 0 && (
              <Card>
                <GlassSheen />
                <Card.Content className="flex-row items-center justify-between px-5 py-3">
                  <Text size="sm" muted className="uppercase tracking-widest">
                    Total floating
                  </Text>
                  <Text weight="bold" className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
                    {formatMoney(total)}
                  </Text>
                </Card.Content>
              </Card>
            )}
            {(positions.length > 0 || orders.length > 0) && live && (
              <Button
                variant="destructive"
                fullWidth
                disabled={closing}
                loading={closing}
                onPress={() => setConfirmOpen(true)}>
                Close all
              </Button>
            )}
            {closeError && !isOrders ? (
              <Text size="sm" className="text-center text-destructive">
                {closeError}
              </Text>
            ) : null}
          </>
        ) : orders.length === 0 ? (
          <Card className="rounded-full">
            <GlassSheen radius={999} />
            <Card.Content className="items-center py-4">
              <Text muted>No open orders</Text>
            </Card.Content>
          </Card>
        ) : (
          <View className="gap-2">
            {orders.map((o) => (
              <Card key={o.id}>
                <GlassSheen />
                <Card.Content className="px-5 py-2">
                  <OrderRow order={o} last />
                </Card.Content>
              </Card>
            ))}
            {live && (
              <Button
                variant="destructive"
                fullWidth
                disabled={closing}
                loading={closing}
                onPress={() => setConfirmOpen(true)}>
                Cancel all
              </Button>
            )}
            {closeError && isOrders ? (
              <Text size="sm" className="text-center text-destructive">
                {closeError}
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </ScrollView>
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <Dialog.Content>
        <Dialog.Title>{isOrders ? 'Cancel orders?' : 'Close positions?'}</Dialog.Title>
        <Dialog.Description>
          {isOrders
            ? `Cancel ${orders.length} resting orders now? Positions stay.`
            : `Close ${positions.length} open positions now? Orders stay.`}
        </Dialog.Description>
        {weekend ? (
          <Text size="sm" muted>
            Weekend — market closed, confirms resume at open.
          </Text>
        ) : null}
        {closeError ? (
          <Text size="sm" className="text-destructive">
            {closeError}
          </Text>
        ) : null}
        <Dialog.Footer>
          <Dialog.Close>
            <Button variant="outline">Keep</Button>
          </Dialog.Close>
          <Button variant="destructive" disabled={closing} loading={closing} onPress={() => void closeAll()}>
            {isOrders ? 'Cancel all' : 'Close all'}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog>
    </View>
    </ScreenErrorBoundary>
  );
}

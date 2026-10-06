import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { PositionsCard } from '@/components/home/positions-card';
import { ScreenHeader } from '@/components/screen-header';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { formatMoney, formatPrice } from '@/hooks/use-mock-account';
import { useTrading } from '@/lib/trading/useTrading';
import { useLive } from '@/lib/ctrader/live';
import { Card } from 'panelui-native/components/card';
import { Text } from 'panelui-native/primitives/text';
import { ChevronDownIcon } from 'panelui-native/icons';

type Tab = 'positions' | 'orders';

function OrderRow({ order, last }: {
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
            {order.volume.toFixed(2)}
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
}

export default function TradesScreen() {
  const { positions, orders } = useTrading();
  const live = useLive();
  const [tab, setTab] = useState<Tab>('positions');
  const total = positions.reduce((sum, p) => sum + p.pl, 0);
  const up = total >= 0;

  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: TAB_CLEARANCE }}>
      <View className="gap-4 p-4">
        <ScreenHeader title="Trades" />
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
            <PositionsCard positions={positions} allowClose={live.status === 'ready'} />
            {positions.length > 0 && (
              <View className="flex-row items-center justify-between px-1">
                <Text size="sm" muted className="uppercase tracking-widest">
                  Total floating
                </Text>
                <Text weight="bold" className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
                  {formatMoney(total)}
                </Text>
              </View>
            )}
          </>
        ) : orders.length === 0 ? (
          <Card className="rounded-full">
            <Card.Content className="items-center py-4">
              <Text muted>No open orders</Text>
            </Card.Content>
          </Card>
        ) : (
          <View className="gap-2">
            {orders.map((o) => (
              <Card key={o.id}>
                <Card.Content className="px-5 py-2">
                  <OrderRow order={o} last />
                </Card.Content>
              </Card>
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

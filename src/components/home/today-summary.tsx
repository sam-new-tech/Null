import { View } from 'react-native';

import type { DayStats } from '@/hooks/use-mock-account';
import { formatMoney } from '@/hooks/use-mock-account';
import { Card } from 'panelui-native/components/card';
import { Text } from 'panelui-native/primitives/text';
import { GlassSheen } from '@/components/glass-sheen';

export function TodaySummary({ stats }: { stats: DayStats }) {
  const up = stats.openPL >= 0;
  const closedUp = stats.realizedPL >= 0;
  return (
    <Card>
      <GlassSheen />
      <Card.Content className="flex-row items-center justify-between p-5">
        <View className="gap-1">
          <Text size="sm" muted className="uppercase tracking-widest">
            Open P&L
          </Text>
          <Text
            size="3xl"
            weight="bold"
            className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
            {formatMoney(stats.openPL)}
          </Text>
        </View>
        <View className="items-end gap-1">
          <Text weight="bold" className={`font-mono ${closedUp ? 'text-success' : 'text-destructive'}`}>
            {formatMoney(stats.realizedPL)}
          </Text>
          <Text size="sm" muted className="text-right">
            {`Trades: ${stats.trades} · Win: ${stats.wins} (${stats.winRate.toFixed(0)}%)`}
          </Text>
        </View>
      </Card.Content>
    </Card>
  );
}

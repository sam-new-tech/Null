import { View } from 'react-native';

import type { DayStats } from '@/hooks/use-mock-account';
import { formatMoney } from '@/hooks/use-mock-account';
import { Card } from 'panelui-native/components/card';
import { Text } from 'panelui-native/primitives/text';
import { GlassSheen } from '@/components/glass-sheen';

export function TodaySummary({ stats }: { stats: DayStats }) {
  const up = stats.realizedPL >= 0;
  const openUp = stats.openPL >= 0;
  return (
    <Card>
      <GlassSheen />
      <Card.Content className="flex-row items-center justify-between p-5">
        <View className="gap-1">
          <Text size="sm" muted className="uppercase tracking-widest">
            Total P&L
          </Text>
          <Text
            size="3xl"
            weight="bold"
            className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
            {formatMoney(stats.realizedPL)}
          </Text>
        </View>
        <View className="items-end gap-1">
          <Text size="xs" muted className="uppercase tracking-widest">
            Open
          </Text>
          <Text weight="bold" className={`font-mono ${openUp ? 'text-success' : 'text-destructive'}`}>
            {formatMoney(stats.openPL)}
          </Text>
          <Text size="sm" muted className="text-right">
            {`Trades: ${stats.trades} · Win: ${stats.wins} (${stats.winRate.toFixed(0)}%)`}
          </Text>
        </View>
      </Card.Content>
    </Card>
  );
}

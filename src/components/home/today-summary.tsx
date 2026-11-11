import { View } from 'react-native';

import type { DayStats } from '@/lib/trading/types';
import { formatMoney } from '@/lib/format';
import { Card } from 'panelui-native/components/card';
import { Text } from '@/components/text';
import { GlassSheen } from '@/components/glass-sheen';

export function TodaySummary({ stats }: { stats: DayStats }) {
  const up = stats.realizedPL >= 0;
  return (
    <Card>
      <GlassSheen />
      <Card.Content className="flex-row items-center justify-between gap-3 p-5">
        <View className="gap-1" style={{ flexShrink: 1, minWidth: 0 }}>
          <Text size="sm" muted className="uppercase tracking-widest">
            Total P&L
          </Text>
          <Text
            size="3xl"
            weight="bold"
            className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}
            fit
            minimumFontScale={0.6}>
            {formatMoney(stats.realizedPL)}
          </Text>
        </View>
        <View className="items-end gap-1" style={{ flexShrink: 0 }}>
          <Text size="sm" muted className="text-right">
            {`Trades: ${stats.trades} · Win: ${stats.wins} (${stats.winRate.toFixed(0)}%)`}
          </Text>
        </View>
      </Card.Content>
    </Card>
  );
}

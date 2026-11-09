import { View } from 'react-native';

import type { AccountState } from '@/lib/trading/types';
import { formatPlainMoney } from '@/lib/format';
import { Card } from 'panelui-native/components/card';
import { Text } from 'panelui-native/primitives/text';
import { GlassSheen } from '@/components/glass-sheen';

function Figure({ label, value, caps = false }: { label: string; value: string; caps?: boolean }) {
  return (
    <View className="gap-1">
      <Text size="sm" muted className={caps ? 'uppercase tracking-widest' : ''}>
        {label}
      </Text>
      <Text size="2xl" weight="bold" className="font-mono">
        {value}
      </Text>
    </View>
  );
}

export function AccountCard({ account }: { account: AccountState }) {
  return (
    <Card>
      <GlassSheen />
      <Card.Content className="flex-row gap-4 p-5">
        <View className="flex-1 gap-5">
          <Figure label="Balance" value={formatPlainMoney(account.balance)} />
          <Figure label="Equity" value={formatPlainMoney(account.equity)} />
        </View>
        <View className="flex-1 gap-5">
          <Figure label="FREE MARGIN" value={formatPlainMoney(account.freeMargin)} caps />
          <Figure
            label="MARGIN %"
            value={account.marginLevel > 0 ? `${account.marginLevel.toFixed(0)}%` : '—'}
            caps
          />
        </View>
      </Card.Content>
    </Card>
  );
}

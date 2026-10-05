import { ScrollView, View } from 'react-native';

import { PositionsCard } from '@/components/home/positions-card';
import { ScreenHeader } from '@/components/screen-header';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { formatMoney, useMockAccount } from '@/hooks/use-mock-account';
import { Text } from 'panelui-native/primitives/text';

export default function TradesScreen() {
  const { positions } = useMockAccount();
  const total = positions.reduce((sum, p) => sum + p.pl, 0);
  const up = total >= 0;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: TAB_CLEARANCE }}>
      <View className="gap-4 p-4">
        <ScreenHeader title="Trades" />
        <PositionsCard positions={positions} />
        {positions.length > 0 && (
          <View className="flex-row items-center justify-between px-1">
            <Text size="sm" muted className="uppercase tracking-widest">
              Total floating
            </Text>
            <Text
              weight="bold"
              className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
              {formatMoney(total)}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

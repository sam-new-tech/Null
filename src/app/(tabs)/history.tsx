import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { formatMoney } from '@/hooks/use-mock-account';
import { useTrading } from '@/lib/trading/useTrading';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { Text } from 'panelui-native/primitives/text';

const PAGE_SIZE = 7;

export default function HistoryScreen() {
  const { history } = useTrading();
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = history.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const total = history.reduce((sum, t) => sum + t.pl, 0);
  const up = total >= 0;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: TAB_CLEARANCE }}>
      <View className="gap-4 p-4">
        <ScreenHeader title="History" />
        {history.length === 0 ? (
          <Card className="rounded-full">
            <Card.Content className="items-center py-4">
              <Text muted>No closed trades yet</Text>
            </Card.Content>
          </Card>
        ) : (
          <View className="gap-2">
            {visible.map((t) => {
              const win = t.pl >= 0;
              return (
                <Card key={t.id}>
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
                          {t.volume.toFixed(2)}
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
              })}
          </View>
        )}
        {history.length > 0 && (
          <View className="flex-row items-center justify-between px-1">
            <Text size="sm" muted className="uppercase tracking-widest">
              Total closed
            </Text>
            <Text weight="bold" className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
              {formatMoney(total)}
            </Text>
          </View>
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
  );
}

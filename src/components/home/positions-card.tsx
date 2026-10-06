import { useState } from 'react';
import { Pressable, View } from 'react-native';

import type { Position } from '@/hooks/use-mock-account';
import { formatMoney, formatPrice } from '@/hooks/use-mock-account';
import { liveEngine } from '@/lib/ctrader/live';
import { closePosition, unitsPerLot } from '@/lib/ctrader/orders';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { Text } from 'panelui-native/primitives/text';
import { ChevronDownIcon } from 'panelui-native/icons';

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between py-1.5">
      <Text size="sm" muted className="uppercase tracking-widest">
        {label}
      </Text>
      <Text size="sm" weight="medium" className="font-mono">
        {value}
      </Text>
    </View>
  );
}

function PositionRow({
  position,
  expanded,
  onToggle,
  allowClose,
  closing,
  onClose,
}: {
  position: Position;
  expanded: boolean;
  onToggle: () => void;
  allowClose: boolean;
  closing: boolean;
  onClose: () => void;
}) {
  const up = position.pl >= 0;
  return (
    <View>
      <Pressable onPress={onToggle} className="flex-row items-center justify-between py-3">
        <View className="flex-row items-center gap-2">
          <Text
            size="xs"
            weight="bold"
            className={position.side === 'buy' ? 'text-success' : 'text-destructive'}>
            {position.side === 'buy' ? 'BUY' : 'SELL'}
          </Text>
          <Text weight="medium">{position.symbol}</Text>
          <Text size="sm" muted>
            {position.volume.toFixed(2)}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          <Text weight="semibold" className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
            {formatMoney(position.pl)}
          </Text>
          <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
            <ChevronDownIcon size={16} />
          </View>
        </View>
      </Pressable>
      {expanded && (
        <View className="pb-3">
          <DetailRow label="Open" value={formatPrice(position.symbol, position.openPrice)} />
          <DetailRow label="TP" value={formatPrice(position.symbol, position.tp)} />
          <DetailRow label="SL" value={formatPrice(position.symbol, position.sl)} />
          {allowClose && (
            <Button
              size="sm"
              variant="destructive"
              disabled={closing}
              loading={closing}
              onPress={onClose}
              fullWidth>
              Close position
            </Button>
          )}
        </View>
      )}
    </View>
  );
}

export function PositionsCard({ positions, allowClose = false }: { positions: Position[]; allowClose?: boolean }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);

  const close = async (position: Position) => {
    if (closingId !== null) return;
    setClosingId(position.id);
    try {
      const accountId = liveEngine.getAccountId();
      if (!accountId) return;
      const pair = closePosition(accountId, position.id, 0, 100000, position.rawVolume);
      liveEngine.execSend(pair.type, pair.payload);
      setTimeout(() => {
        void liveEngine.refresh();
      }, 3000);
    } finally {
      setClosingId(null);
    }
  };

  if (positions.length === 0) {
    return (
      <Card className="rounded-full">
        <Card.Content className="items-center py-4">
          <Text muted>No active positions</Text>
        </Card.Content>
      </Card>
    );
  }

  return (
    <View className="gap-2">
      {positions.map((p) => (
        <Card key={p.id}>
          <Card.Content className="px-5 py-2">
            <PositionRow
              position={p}
              expanded={expandedId === p.id}
              onToggle={() => setExpandedId((id) => (id === p.id ? null : p.id))}
              allowClose={allowClose}
              closing={closingId === p.id}
              onClose={() => void close(p)}
            />
          </Card.Content>
        </Card>
      ))}
    </View>
  );
}

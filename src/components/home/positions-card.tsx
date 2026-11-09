import { memo, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import type { Position } from '@/lib/trading/types';
import { formatLots, formatMoney, formatPrice } from '@/lib/format';
import { liveEngine } from '@/lib/ctrader/live';
import { closePosition } from '@/lib/ctrader/orders';
import { Payload } from '@/lib/ctrader/protocol';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { GlassSheen } from '@/components/glass-sheen';
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
  closeError,
  onClose,
}: {
  position: Position;
  expanded: boolean;
  onToggle: () => void;
  allowClose: boolean;
  closing: boolean;
  closeError: string | null;
  onClose: () => void;
}) {
  const up = position.pl >= 0;
  return (
    <View>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${position.side} ${position.symbol} ${position.volume.toFixed(2)} lots, ${formatMoney(position.pl)}`}>
        <View className="flex-row items-center justify-between py-3">
        <View className="flex-row items-center gap-2">
          <Text
            size="xs"
            weight="bold"
            className={position.side === 'buy' ? 'text-success' : 'text-destructive'}>
            {position.side === 'buy' ? 'BUY' : 'SELL'}
          </Text>
          <Text weight="medium">{position.symbol}</Text>
          <Text size="sm" muted>
            {formatLots(position.volume)}
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
        </View>
      </Pressable>
      {expanded && (
        <View className="pb-3">
          <DetailRow label="Open" value={formatPrice(position.symbol, position.openPrice)} />
          <DetailRow label="TP" value={formatPrice(position.symbol, position.tp)} />
          <DetailRow label="SL" value={formatPrice(position.symbol, position.sl)} />
          {allowClose && (
            <View className="gap-2 pt-1">
              <Button
                size="sm"
                variant="destructive"
                disabled={closing}
                loading={closing}
                onPress={onClose}
                fullWidth>
                Close position
              </Button>
              {closeError ? (
                <Text size="xs" className="text-center text-destructive">
                  {closeError}
                </Text>
              ) : null}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const MemoRow = memo(PositionRow);

export function PositionsCard({ positions, allowClose = false }: { positions: Position[]; allowClose?: boolean }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<number | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const close = async (position: Position) => {
    if (closingId !== null) return;
    setClosingId(position.id);
    setCloseError(null);
    const done = (fn: () => void) => {
      if (mounted.current) fn();
    };
    try {
      const accountId = liveEngine.getAccountId();
      if (!accountId) {
        setCloseError('Not connected — retry');
        return;
      }
      if (!liveEngine.isOpen()) {
        setCloseError('Socket down — retry in a moment');
        return;
      }
      const pair = closePosition(accountId, position.id, 0, 100000, position.rawVolume);
      const confirmed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve(false);
        }, 10000);
        const off = liveEngine.onEvent(Payload.ExecutionEvent, (payload) => {
          const deal = payload.deal as { positionId?: number; closePositionDetail?: object } | undefined;
          if (deal?.closePositionDetail && Number(deal.positionId) === Number(position.id)) {
            clearTimeout(timer);
            off();
            resolve(true);
          }
        });
        liveEngine.execSend(pair.type, pair.payload);
      });
      if (!confirmed) {
        done(() => setCloseError('Close not confirmed — pull to refresh'));
      }
      // Truth arrives via ExecutionEvent → patch + trailing snapshot.
      // Refresh is a fallback only, never the primary path.
      await liveEngine.refresh();
    } catch (err) {
      done(() => setCloseError(err instanceof Error ? err.message : 'Close failed — retry'));
    } finally {
      done(() => setClosingId(null));
    }
  };

  if (positions.length === 0) {
    return (
      <Card className="rounded-full">
        <GlassSheen radius={999} />
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
          <GlassSheen />
          <Card.Content className="px-5 py-2">
            <MemoRow
              position={p}
              expanded={expandedId === p.id}
              onToggle={() => {
                setCloseError(null);
                setExpandedId((id) => (id === p.id ? null : p.id));
              }}
              allowClose={allowClose}
              closing={closingId === p.id}
              closeError={closingId === p.id || expandedId === p.id ? closeError : null}
              onClose={() => void close(p)}
            />
          </Card.Content>
        </Card>
      ))}
    </View>
  );
}

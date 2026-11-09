import { Text } from 'panelui-native/primitives/text';

/** BUY / SELL tag shared by position, order and history rows. */
export function SideLabel({ side }: { side: 'buy' | 'sell' }) {
  return (
    <Text size="xs" weight="bold" className={side === 'buy' ? 'text-success' : 'text-destructive'}>
      {side === 'buy' ? 'BUY' : 'SELL'}
    </Text>
  );
}

import { GlassSheen } from '@/components/glass-sheen';
import { Card } from 'panelui-native/components/card';
import { Text } from '@/components/text';

/** Rounded empty-state used by the positions, orders and history lists. */
export function EmptyCard({ message }: { message: string }) {
  return (
    <Card className="rounded-full">
      <GlassSheen radius={999} />
      <Card.Content className="items-center py-4">
        <Text muted>{message}</Text>
      </Card.Content>
    </Card>
  );
}

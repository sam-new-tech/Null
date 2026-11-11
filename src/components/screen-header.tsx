import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';

import { Text } from '@/components/text';

export function LogoMark({ size = 72 }: { size?: number }) {
  return (
    <Image
      source={require('@/assets/images/logo-mark.png')}
      style={{ width: size, height: size, borderRadius: size * 0.27 }}
      contentFit="cover"
    />
  );
}

/**
 * Data-source badge: green LIVE dot on real cTrader data, muted DEMO on mock.
 */
export function LiveBadge({ live }: { live: boolean }) {
  return (
    <View className="flex-row items-center gap-1.5 px-1">
      <View className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-success' : 'bg-muted-foreground'}`} />
      <Text size="xs" muted>
        {live ? 'Live' : 'Demo'}
      </Text>
    </View>
  );
}

/**
 * Shared tab-screen header: title (or action) on the left,
 * logo always on the right near the corner.
 */
export function ScreenHeader({ title, action }: { title?: string; action?: ReactNode }) {
  return (
    <View className="flex-row items-center justify-between">
      {title ? (
        <Text size="xl" weight="bold">
          {title}
        </Text>
      ) : (
        <View>{action}</View>
      )}
      <LogoMark />
    </View>
  );
}

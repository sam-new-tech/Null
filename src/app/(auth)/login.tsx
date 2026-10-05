import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';

import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { LogoMark } from '@/components/screen-header';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { useAuth } from '@/context/auth';
import { Button } from 'panelui-native/components/button';
import { Text } from 'panelui-native/primitives/text';
import { Image } from 'expo-image';

export default function LoginScreen() {
  const { login } = useAuth();
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await login();
      router.replace('/(tabs)');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ChartBackdrop />
      <View className="items-center gap-8 px-8" style={{ width: '100%', maxWidth: 340 }}>
        <LogoMark size={120} />
        <Text size="2xl" weight="bold" className="text-center">
          Welcome to Zero
        </Text>
        <Button
          fullWidth
          size="lg"
          loading={busy}
          onPress={connect}
          startContent={
            <Image
              source={require('@/assets/images/ctrader-mark.png')}
              style={{ width: 24, height: 24 }}
              contentFit="contain"
            />
          }>
          Connect with cTrader
        </Button>
      </View>
      <View style={{ height: TAB_CLEARANCE }} />
    </View>
  );
}

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';

import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { LogoMark } from '@/components/screen-header';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { REDIRECT_URI } from '@/lib/ctrader/config';
import { useAuth } from '@/context/auth';
import { Button } from 'panelui-native/components/button';
import { Input } from 'panelui-native/components/input';
import { Text } from 'panelui-native/primitives/text';
import { Image } from 'expo-image';

function codeFromPasted(text: string): string | null {
  try {
    const code = new URL(text.trim()).searchParams.get('code');
    if (code) return code;
  } catch {
    // Not a full URL — try a bare code or query fragment.
  }
  const match = text.match(/[?&]code=([^&\s]+)/) ?? text.match(/^([A-Za-z0-9_-]{10,})$/);
  return match ? match[1] : null;
}

export default function LoginScreen() {
  const { login, busy, stage, error, connectWithCode } = useAuth();
  const [manual, setManual] = useState(false);
  const [pasted, setPasted] = useState('');

  const connect = async () => {
    if (busy) return;
    await login();
    router.replace('/(tabs)');
  };

  const connectManual = async () => {
    if (busy) return;
    const code = codeFromPasted(pasted);
    if (!code) return;
    try {
      await connectWithCode(code);
      router.replace('/(tabs)');
    } catch {
      // Error is shown from context.
    }
  };

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ChartBackdrop />
      <View className="items-center gap-8 px-8" style={{ width: '100%', maxWidth: 340 }}>
        <LogoMark size={120} />
        <Text size="2xl" weight="bold" className="text-center">
          Welcome to Null
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
        {busy && stage ? (
          <Text size="sm" muted className="text-center">
            {stage}
          </Text>
        ) : null}
        {error ? (
          <Text size="sm" className="text-center text-destructive">
            {error}
          </Text>
        ) : null}
        {manual ? (
          <View className="w-full gap-2">
            <Input
              label="Redirect link"
              placeholder="https://openapi.ctrader.com/?code=…"
              value={pasted}
              onChangeText={setPasted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button fullWidth loading={busy} onPress={connectManual}>
              Connect with link
            </Button>
          </View>
        ) : (
          <Pressable onPress={() => setManual(true)}>
            <Text size="sm" muted className="text-center">
              Popup not working? Paste the link instead
            </Text>
          </Pressable>
        )}
        {__DEV__ ? (
          <Text size="xs" muted className="text-center font-mono">
            {REDIRECT_URI}
          </Text>
        ) : null}
      </View>
      <View style={{ height: TAB_CLEARANCE }} />
    </View>
  );
}

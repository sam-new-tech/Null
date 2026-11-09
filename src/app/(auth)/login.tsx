import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { LogoMark } from '@/components/screen-header';
import { NEEDS_MANUAL_LINK, redirectUri } from '@/lib/ctrader/config';
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
  const [manual, setManual] = useState(NEEDS_MANUAL_LINK);
  const [pasted, setPasted] = useState('');

  const connect = async () => {
    if (busy) return;
    // AuthGuard navigates on `connected` — no manual replace here so a
    // cancelled native sheet doesn't flash into /(tabs) and bounce back.
    await login();
  };

  const connectManual = async () => {
    if (busy) return;
    const code = codeFromPasted(pasted);
    if (!code) return;
    try {
      await connectWithCode(code);
      // AuthGuard covers navigation; no replace needed.
    } catch {
      // Error is shown from context.
    }
  };

  return (
    <View className="flex-1 bg-background">
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
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
          accessibilityLabel="Connect with cTrader"
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
            <Text size="xs" muted className="text-center">
              After allowing access, the browser ends on a page like
              {'\n'}https://openapi.ctrader.com/?code=… — copy that address and paste it here.
            </Text>
            <Input
              label="Redirect link"
              placeholder="https://openapi.ctrader.com/?code=…"
              value={pasted}
              onChangeText={setPasted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => void connectManual()}
            />
            <Button
              fullWidth
              loading={busy}
              onPress={connectManual}
              accessibilityLabel="Connect with pasted link">
              Connect with link
            </Button>
          </View>
        ) : (
          <Pressable
            onPress={() => setManual(true)}
            accessibilityRole="button"
            accessibilityLabel="Paste redirect link instead"
            hitSlop={12}>
            <Text size="sm" muted className="text-center">
              Popup not working? Paste the link instead
            </Text>
          </Pressable>
        )}
        {__DEV__ ? (
          <Text size="xs" muted className="text-center font-mono">
            {redirectUri()}
          </Text>
        ) : null}
      </View>
    </View>
      </ScrollView>
    </KeyboardAvoidingView>
    </SafeAreaView>
    </View>
  );
}

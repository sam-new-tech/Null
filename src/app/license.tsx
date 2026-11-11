import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';

import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { LogoMark } from '@/components/screen-header';
import { useResponsive } from '@/hooks/use-responsive';
import { activateLicense } from '@/lib/license';
import { Button } from 'panelui-native/components/button';
import { Input } from 'panelui-native/components/input';
import { Text } from '@/components/text';

export default function LicenseScreen() {
  const { displayScale } = useResponsive();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Auto-format as typed: NULL-XXXX-XXXX-XXXX (12 key chars max). */
  const onChangeCode = (text: string) => {
    const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const head = clean.startsWith('NULL') ? clean.slice(4) : clean;
    const body = head.slice(0, 12);
    const grouped = (body.match(/.{1,4}/g) ?? []).join('-');
    setCode(body.length > 0 ? `NULL-${grouped}` : '');
    if (error) setError(null);
  };

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // One-shot user action: the root guard converges right behind it.
      await activateLicense(code);
      router.replace('/(auth)/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ChartBackdrop />
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <View className="flex-1 items-center justify-center gap-6 px-8 py-10">
          <LogoMark size={Math.round(96 * displayScale)} />
          <Text size="xl" weight="bold" className="text-center">
            Enter your license
          </Text>
          <View className="w-full gap-2">
            <Input
              label="License key"
              placeholder="NULL-XXXX-XXXX-XXXX"
              value={code}
              onChangeText={onChangeCode}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={20}
              returnKeyType="go"
              onSubmitEditing={() => void activate()}
            />
            <Button
              fullWidth
              size="lg"
              loading={busy}
              disabled={busy}
              onPress={() => void activate()}
              accessibilityLabel="Activate license">
              Activate
            </Button>
          </View>
          {error ? (
            <Text size="sm" className="text-center text-destructive">
              {error}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

import '../global.css';

import { DarkTheme, DefaultTheme, router, Slot, ThemeProvider, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { PanelUIProvider } from 'panelui-native/provider';
import { useThemeMode } from 'panelui-native/theme';
import { useCSSVariable } from 'uniwind';
import { useEffect, useRef } from 'react';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider, useAuth } from '@/context/auth';
import { useLicense } from '@/lib/license';
import LicenseScreen from './license';
// Registers the grid background task at launch (no-op until the bot starts it).
import '@/lib/bot/background';

SplashScreen.preventAutoHideAsync();

function AuthGuard() {
  const { connected, hydrated } = useAuth();
  const { licensed, hydrated: licenseReady } = useLicense();
  const segments = useSegments();
  // Successive replaces during a pending transition never commit (segments
  // stay stale) and loop forever — push each target exactly once.
  const lastTarget = useRef<string | null>(null);

  useEffect(() => {
    if (!hydrated || !licenseReady || !licensed) return;
    let target: '/(auth)/login' | '/(tabs)' | null = null;
    const inAuth = segments[0] === '(auth)';
    if (!connected && !inAuth) target = '/(auth)/login';
    else if (connected && inAuth) target = '/(tabs)';
    if (target && target !== lastTarget.current) {
      lastTarget.current = target;
      router.replace(target);
    } else if (!target) {
      lastTarget.current = null;
    }
  }, [connected, hydrated, licensed, licenseReady, segments]);

  if (!hydrated || !licenseReady) return null;
  // Unlicensed renders the license screen directly — zero navigation, so no
  // guard/router fight is possible. Licensed renders the normal route tree.
  if (!licensed) return <LicenseScreen />;
  return <Slot />;
}

function ThemedNavigation() {
  const { mode } = useThemeMode();
  const [background, card, text, border] = useCSSVariable([
    '--color-background',
    '--color-card',
    '--color-foreground',
    '--color-border',
  ]) as (string | undefined)[];

  const base = mode === 'dark' ? DarkTheme : DefaultTheme;

  return (
    <ThemeProvider
      value={{
        ...base,
        dark: mode === 'dark',
        colors: {
          ...base.colors,
          background: background ?? base.colors.background,
          card: card ?? base.colors.card,
          text: text ?? base.colors.text,
          border: border ?? base.colors.border,
        },
      }}>
      <AnimatedSplashOverlay />
      <AuthGuard />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <PanelUIProvider>
        <ThemedNavigation />
      </PanelUIProvider>
    </AuthProvider>
  );
}

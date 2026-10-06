import '../global.css';

import { DarkTheme, DefaultTheme, router, Slot, ThemeProvider, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { PanelUIProvider } from 'panelui-native/provider';
import { useThemeMode } from 'panelui-native/theme';
import { useCSSVariable } from 'uniwind';
import { useEffect } from 'react';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider, useAuth } from '@/context/auth';

SplashScreen.preventAutoHideAsync();

function AuthGuard() {
  const { connected, hydrated } = useAuth();
  const segments = useSegments();

  useEffect(() => {
    if (!hydrated) return;
    const inAuth = segments[0] === '(auth)' || segments[0] === 'oauth';
    if (!connected && !inAuth) router.replace('/(auth)/login');
    else if (connected && inAuth) router.replace('/(tabs)');
  }, [connected, hydrated, segments]);

  if (!hydrated) return null;
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

import '../global.css';

import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { PanelUIProvider } from 'panelui-native/provider';
import { useThemeMode } from 'panelui-native/theme';
import { useCSSVariable } from 'uniwind';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';

SplashScreen.preventAutoHideAsync();

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
      <AppTabs />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <PanelUIProvider>
      <ThemedNavigation />
    </PanelUIProvider>
  );
}

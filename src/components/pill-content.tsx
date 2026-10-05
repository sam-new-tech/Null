import { useColorScheme, Text, View, StyleSheet } from 'react-native';
import { useTabTrigger } from 'expo-router/ui';

import { Colors } from '@/constants/theme';
import type { TabMeta } from '@/constants/tabs';

/**
 * Pill-tab content: icon always, label only when focused.
 * Press handling lives on the parent TabTrigger — this only styles.
 */
export function PillContent({ tab }: { tab: TabMeta }) {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const { triggerProps } = useTabTrigger({ name: tab.name });
  const focused = triggerProps.isFocused;
  const Icon = tab.Icon;

  return (
    <View
      style={[
        styles.pill,
        focused && { backgroundColor: colors.backgroundSelected },
      ]}>
      <Icon size={22} color={focused ? colors.text : colors.textSecondary} />
      {focused && <Text style={[styles.label, { color: colors.text }]}>{tab.label}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 999,
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
});

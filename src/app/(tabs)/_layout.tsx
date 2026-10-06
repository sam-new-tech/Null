import { Tabs, TabList, TabTrigger, TabSlot } from 'expo-router/ui';
import { BlurView } from 'expo-blur';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSheen } from '@/components/glass-sheen';
import { PillContent } from '@/components/pill-content';
import { Colors } from '@/constants/theme';
import { TABS } from '@/constants/tabs';

export default function TabsLayout() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.root}>
      <Tabs>
        <SafeAreaView edges={['top']} style={styles.slot}>
          <TabSlot style={styles.slot} />
        </SafeAreaView>
        <TabList
          style={[
            styles.pill,
            {
              bottom: insets.bottom + 16,
              backgroundColor: 'rgba(12,12,12,0.55)',
              borderColor: colors.backgroundSelected,
            },
          ]}>
          <BlurView
            intensity={60}
            tint="dark"
            style={StyleSheet.absoluteFill}
          />
          <GlassSheen radius={999} />
          {TABS.map((tab) => (
            <TabTrigger key={tab.name} name={tab.name} href={tab.href} style={styles.trigger}>
              <PillContent tab={tab} />
            </TabTrigger>
          ))}
        </TabList>
      </Tabs>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  slot: {
    flex: 1,
  },
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    padding: 6,
    gap: 2,
    borderRadius: 999,
    borderWidth: 1,
    overflow: 'hidden',
  },
  trigger: {
    justifyContent: 'center',
  },
});

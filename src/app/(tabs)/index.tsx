import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';

import { AccountCard } from '@/components/home/account-card';
import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { PositionsCard } from '@/components/home/positions-card';
import { TodaySummary } from '@/components/home/today-summary';
import { LiveBadge, LogoMark } from '@/components/screen-header';
import { useAuth } from '@/context/auth';
import { Button } from 'panelui-native/components/button';
import { liveEngine } from '@/lib/ctrader/live';
import { Popover } from 'panelui-native/components/popover';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { useTrading } from '@/lib/trading/useTrading';
import { Text } from 'panelui-native/primitives/text';

function SectionLabel({ children }: { children: string }) {
  return (
    <Text size="sm" muted className="uppercase tracking-widest">
      {children}
    </Text>
  );
}

export default function HomeScreen() {
  const { account, stats, positions, live } = useTrading();
  const { logout } = useAuth();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await liveEngine.refresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ChartBackdrop />
      <ScrollView
        style={{ flex: 1, minHeight: 0 }}
        contentContainerStyle={{ paddingBottom: TAB_CLEARANCE }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
        <View className="gap-4 p-4">
          <View className="flex-row items-center justify-between">
            <LogoMark size={48} />
            <View className="flex-row items-center gap-3">
              <LiveBadge live={live} />
              <Popover>
              <Popover.Trigger>
                <Pressable className="h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-muted">
                  <Image
                    source={require('@/assets/images/avatar.png')}
                    style={{ width: 40, height: 40 }}
                    contentFit="cover"
                  />
                </Pressable>
              </Popover.Trigger>
              <Popover.Content placement="bottom" align="end">
                <Button
                  variant="outline"
                  onPress={() => {
                    logout();
                    router.replace('/(auth)/login');
                  }}>
                  Log out
                </Button>
              </Popover.Content>
            </Popover>
            </View>
          </View>
          <AccountCard account={account} />
          <View className="gap-2">
            <SectionLabel>Live positions</SectionLabel>
            <PositionsCard positions={positions} allowClose={live} />
          </View>
          <View className="gap-2">
            <SectionLabel>Summary</SectionLabel>
            <TodaySummary stats={stats} />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

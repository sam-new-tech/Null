import { useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { ScreenHeader } from '@/components/screen-header';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { liveEngine, useLive } from '@/lib/ctrader/live';
import { botRunner } from '@/lib/bot/runner';
import { registerGridTask, unregisterGridTask } from '@/lib/bot/background';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { Dialog } from 'panelui-native/components/dialog';
import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { GlassSheen } from '@/components/glass-sheen';
import { formatMoney } from '@/hooks/use-mock-account';
import { Input } from 'panelui-native/components/input';
import { Text } from 'panelui-native/primitives/text';
import { ThinkingOrb } from 'panelui-native/components/thinking-orb';

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexBasis: '48%', flexGrow: 1 }}>
      <Card>
        <GlassSheen />
        <Card.Content className="gap-1 p-4">
          <Text size="sm" muted className="uppercase tracking-widest">
            {label}
          </Text>
          <Text size="xl" weight="bold" className="font-mono">
            {value}
          </Text>
        </Card.Content>
      </Card>
    </View>
  );
}

function LiveDot() {
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.3, { duration: 900 }), -1, true);
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#34d399' }, style]} />;
}

function LivePL() {
  const pl = liveEngine.openPL();
  const up = pl >= 0;
  return (
    <Text size="3xl" weight="bold" className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
      {formatMoney(pl)}
    </Text>
  );
}

export default function BotScreen() {
  const live = useLive();
  useSyncExternalStore(botRunner.subscribe, botRunner.getRevision);
  const status = botRunner.getStatus();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [riskText, setRiskText] = useState('2');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    void botRunner.load();
  }, []);

  const running = status.state === 'running';
  const canArm = live.status === 'ready' && live.trader !== null;
  const equity = liveEngine.accountState().equity;
  const riskPct = Number(riskText.replace(',', '.'));
  const riskValid = Number.isFinite(riskPct) && riskPct > 0 && riskPct <= 3;
  const stakePreview = riskValid ? (equity * riskPct) / 100 : 0;

  const confirmStart = async () => {
    if (!riskValid || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await botRunner.start(riskPct);
      await registerGridTask();
      setSheetOpen(false);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Start failed');
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    await botRunner.stopAll();
    await unregisterGridTask();
    router.replace('/');
  };

  // Stopped: only the Start button (plus account gate + risk sheet).
  if (!running) {
    return (
      <View className="flex-1 bg-background">
        <ChartBackdrop />
        <View className="gap-4 p-4">
          <ScreenHeader
            action={
              <Text size="sm" muted>
                Stopped
              </Text>
            }
          />
        </View>
        <View className="flex-1 items-center justify-center px-8" style={{ paddingBottom: TAB_CLEARANCE }}>
          <View className="w-full items-center gap-5">
            <Text size="xl" weight="bold" className="text-center">
              Grid Bot
            </Text>
            <Button size="lg" fullWidth disabled={!canArm} onPress={() => setSheetOpen(true)}>
              Start bot
            </Button>
          </View>
          {!canArm && (
            <Text size="sm" muted className="mt-3 text-center">
              Connect your cTrader account to arm the bot
            </Text>
          )}
        </View>
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          <Dialog.Content>
            <Dialog.Title>Risk per level</Dialog.Title>
            <Dialog.Description>
              {`Stake per grid level as % of equity ($${equity.toFixed(2)}). Max 10 levels/side, 0.05 lots/level cap.`}
            </Dialog.Description>
            <Input
              label="Risk %"
              value={riskText}
              onChangeText={setRiskText}
              keyboardType="decimal-pad"
              errorMessage={!riskValid && riskText.length > 0 ? 'Enter 0–3' : undefined}
            />
            {riskValid && (
              <Text size="sm" muted>
                {`≈ $${stakePreview.toFixed(2)} margin per level · XAUUSD M30 · DCA grid`}
              </Text>
            )}
            {startError ? (
              <Text size="sm" className="text-destructive">
                {startError}
              </Text>
            ) : null}
            <Dialog.Footer>
              <Dialog.Close>
                <Button variant="outline">Cancel</Button>
              </Dialog.Close>
              <Button disabled={!riskValid || starting} loading={starting} onPress={confirmStart}>
                Arm grid
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog>
      </View>
    );
  }

  // Running: orb + live status + event logs + stop.
  return (
    <View className="flex-1 bg-background">
      <ChartBackdrop />
      <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: TAB_CLEARANCE, flexGrow: 1 }}>
        <View className="gap-3 p-4">
        <ScreenHeader
          action={
            <View className="flex-row items-center gap-2">
              <LiveDot />
              <Text size="sm" weight="bold" className="text-success">
                Live
              </Text>
            </View>
          }
        />
        <View className="flex-row items-center justify-between px-2 py-1">
          <View className="flex-1 items-start gap-1">
            <Text size="sm" muted className="uppercase tracking-widest">
              Live P/L
            </Text>
            <LivePL />
          </View>
          <View className="items-center gap-1">
            <ThinkingOrb state="working" size={128} />
            <Text size="xs" muted className="text-center font-mono">
              {status.symbol}
            </Text>
          </View>
          <View className="flex-1 items-end gap-1">
            <Text size="sm" muted className="uppercase tracking-widest">
              Price
            </Text>
            <Text size="3xl" weight="bold" className="text-center font-mono">
              {status.lastPrice !== null ? status.lastPrice.toFixed(2) : '—'}
            </Text>
          </View>
        </View>
        {status.coolingDown && (
          <Text size="sm" muted className="text-center">
            Taking a short break — back on its own soon
          </Text>
        )}
        <View className="flex-row flex-wrap gap-3">
          <StatTile label="Open" value={`${status.openManaged}/20`} />
          <StatTile label="Resting" value={String(status.restingCount)} />
          <StatTile label="Lots / lvl" value={status.volumeLots.toFixed(2)} />
          <StatTile label="Step" value={status.step !== null ? status.step.toFixed(2) : '—'} />
        </View>
        <Button variant="destructive" fullWidth onPress={stop}>
          Stop bot
        </Button>
        <View className="gap-2">
          {status.logs.slice(0, 3).map((entry, i) => (
            <Card key={`${entry.time}-${i}`}>
              <GlassSheen />
              <Card.Content className="gap-2 p-4">
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-2">
                    <View
                      className={`h-2 w-2 rounded-full ${
                        entry.kind === 'fill' || entry.kind === 'close'
                          ? 'bg-success'
                          : entry.kind === 'escape' || entry.kind === 'error'
                            ? 'bg-destructive'
                            : 'bg-foreground'
                      }`}
                    />
                    <Text size="xs" weight="bold" className="uppercase tracking-widest">
                      {entry.kind}
                    </Text>
                  </View>
                  <Text size="xs" muted className="font-mono">
                    {entry.time}
                  </Text>
                </View>
                <Text>{entry.message}</Text>
              </Card.Content>
            </Card>
          ))}
        </View>
      </View>
    </ScrollView>
    </View>
  );
}

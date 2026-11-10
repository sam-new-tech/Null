import { memo, useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { LogoMark, ScreenHeader } from '@/components/screen-header';
import { ConnectionBanner } from '@/components/connection-banner';
import { ScreenErrorBoundary } from '@/components/screen-error-boundary';
import { TAB_CLEARANCE } from '@/constants/tabs';
import { Fonts } from '@/constants/theme';
import { liveEngine, useLive } from '@/lib/ctrader/live';
import { botRunner } from '@/lib/bot/runner';
import { videoLots } from '@/lib/bot/engine';
import { registerGridTask, unregisterGridTask } from '@/lib/bot/background';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { Dialog } from 'panelui-native/components/dialog';
import { ChartBackdrop } from '@/components/home/chart-backdrop';
import { GlassSheen } from '@/components/glass-sheen';
import { formatIndicator, formatMoney, formatPrice } from '@/lib/format';
import { isWeekendMarketClosed } from '@/lib/market-hours';
import { Text } from 'panelui-native/primitives/text';
import { ThinkingOrb } from 'panelui-native/components/thinking-orb';

const StatTile = memo(function StatTile({ label, value }: { label: string; value: string }) {
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
});

function LiveDot() {
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.3, { duration: 900 }), -1, true);
    return () => cancelAnimation(pulse);
  }, [pulse]);
  const style = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return <Animated.View style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#34d399' }, style]} />;
}

/**
 * Latest tick price. Subscribes to the engine too, so a spot update
 * re-renders even when the bot itself did not emit a revision.
 */
function useTickerPrice(): number | null {
  useLive();
  return useSyncExternalStore(botRunner.subscribeTick, botRunner.getTickPrice) ?? botRunner.getLivePrice();
}

function LivePL() {
  // Revision subscription keeps P/L fresh when the managed position changes.
  useSyncExternalStore(botRunner.subscribe, botRunner.getRevision);
  const price = useTickerPrice();
  const pl = price === null ? 0 : botRunner.managedPlAt(price);
  const up = pl >= 0;
  return (
    <Text size="3xl" weight="bold" numberOfLines={1} className={`font-mono ${up ? 'text-success' : 'text-destructive'}`}>
      {formatMoney(pl)}
    </Text>
  );
}

function LivePrice({ symbol }: { symbol: string }) {
  const price = useTickerPrice();
  return (
    <Text size="3xl" weight="bold" numberOfLines={1} className="text-center font-mono">
      {price === null ? '—' : formatPrice(symbol, price)}
    </Text>
  );
}

export default function BotScreen() {
  const live = useLive();
  // Subscribe so status.* re-renders in realtime on every bot emit.
  useSyncExternalStore(botRunner.subscribe, botRunner.getRevision);
  const status = botRunner.getStatus();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    void botRunner.load();
  }, []);

  // A persisted running strategy must reattach when the account becomes ready
  // (app restart, reconnect, or a restored session that finishes after mount).
  useEffect(() => {
    if (live.status !== 'ready') return;
    void botRunner.resumeIfRunning();
  }, [live.status]);

  const running = status.state === 'running';
  const canArm = live.status === 'ready' && live.trader !== null;
  const equity = liveEngine.accountState().equity;
  const autoLots = videoLots(equity, 0.05);
  const gateMessage =
    live.status === 'error'
      ? (live.error ?? 'Connection failed — retry')
      : live.status === 'connecting'
        ? 'Connecting to cTrader…'
        : 'Connect your cTrader account to arm the bot';
  // XAUUSD is closed on weekends — the broker confirms nothing until open.
  const weekend = isWeekendMarketClosed();

  const confirmStart = async () => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await botRunner.start();
      await registerGridTask();
      setSheetOpen(false);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Start failed');
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await botRunner.stopAll();
      await unregisterGridTask();
      setConfirmStop(false);
      router.replace('/');
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'Stop failed — retry');
    } finally {
      setStopping(false);
    }
  };

  // Stopped: only the Start button (plus account gate + risk sheet).
  if (!running) {
    return (
      <ScreenErrorBoundary key={live.status}>
        <View className="flex-1 bg-background">
          <ChartBackdrop />
          <View className="gap-4 p-4">
            <ConnectionBanner />
          </View>
          <View className="flex-1 items-center justify-center px-8" style={{ paddingBottom: TAB_CLEARANCE }}>
            <View className="w-full items-center gap-5">
              <LogoMark size={160} />
              <Text
                size="2xl"
                weight="bold"
                style={{ fontFamily: Fonts.rounded }}
                className="text-center uppercase tracking-widest">
                XAU/USD Momentum Bot
              </Text>
              <Button size="lg" fullWidth disabled={!canArm || starting} loading={starting} onPress={() => setSheetOpen(true)}>
                Start bot
              </Button>
            </View>
            {!canArm && (
              <Text size="sm" muted className="mt-3 text-center">
                {gateMessage}
              </Text>
            )}
          </View>
          <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
            <Dialog.Content>
              <Dialog.Title>Start Strategy</Dialog.Title>
              <Dialog.Description>
                {`XAU/USD 1m Momentum Strategy · Fixed TP $2.00 target.\n~${autoLots.toFixed(2)} lots from $${equity.toFixed(2)} equity.`}
                {weekend ? ' Weekend: rests at open.' : ''}
              </Dialog.Description>
              {startError ? (
                <Text size="sm" className="text-destructive">
                  {startError}
                </Text>
              ) : null}
              <Dialog.Footer>
                <Dialog.Close>
                  <Button variant="outline">Cancel</Button>
                </Dialog.Close>
                <Button disabled={!canArm || starting} loading={starting} onPress={confirmStart}>
                  Arm Strategy
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog>
        </View>
      </ScreenErrorBoundary>
    );
  }

  // Running: orb + live status + event logs + stop.
  return (
    <ScreenErrorBoundary key={live.status}>
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
            <ConnectionBanner />
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
                <LivePrice symbol={status.symbol} />
              </View>
          </View>
          <View className="flex-row flex-wrap gap-3">
            <StatTile
              label="Position"
              value={status.position ? `${status.position.side.toUpperCase()} ${status.position.lots}L` : 'FLAT'}
            />
            <StatTile label="5m EMA" value={formatIndicator(status.indicators.ema5m, 2)} />
            <StatTile label="ADX (14)" value={formatIndicator(status.indicators.adx, 1)} />
            <StatTile
              label="VDC (20)"
              value={
                status.indicators.vdc === null || !Number.isFinite(status.indicators.vdc)
                  ? '—'
                  : `${status.indicators.vdc > 0 ? '+' : ''}${status.indicators.vdc.toFixed(1)}%`
              }
            />
          </View>

          {status.logs.length > 0 && (
            <Card>
              <GlassSheen />
              <Card.Content className="gap-2 p-3">
                <Text size="xs" muted className="uppercase tracking-widest font-semibold">
                  Strategy Activity
                </Text>
                <View className="gap-1.5">
                  {status.logs.slice(-5).reverse().map((entry, idx) => (
                    <View key={idx} className="flex-row items-center justify-between gap-2">
                      <Text size="xs" muted className="font-mono">
                        {entry.time}
                      </Text>
                      <Text
                        size="xs"
                        className={`flex-1 font-mono ${
                          entry.kind === 'signal'
                            ? 'text-primary'
                            : entry.kind === 'fill'
                              ? 'text-success'
                              : entry.kind === 'close'
                                ? 'text-warning'
                                : entry.kind === 'error'
                                  ? 'text-destructive'
                                  : ''
                        }`}
                        numberOfLines={1}>
                        {entry.message}
                      </Text>
                    </View>
                  ))}
                </View>
              </Card.Content>
            </Card>
          )}

          <Button variant="destructive" fullWidth disabled={stopping} loading={stopping} onPress={() => setConfirmStop(true)}>
            Stop bot
          </Button>
          {stopError ? (
            <Text size="sm" className="text-center text-destructive">
              {stopError}
            </Text>
          ) : null}
          <Dialog open={confirmStop} onOpenChange={setConfirmStop}>
            <Dialog.Content>
              <Dialog.Title>Stop bot?</Dialog.Title>
              <Dialog.Description>
                {status.openManaged
                  ? 'Close the open managed trade and stop the bot? Manual trades stay.'
                  : 'Stop the strategy bot?'}
              </Dialog.Description>
              {weekend ? (
                <Text size="sm" muted>
                  Weekend — market closed, confirms resume at open.
                </Text>
              ) : null}
              <Dialog.Footer>
                <Dialog.Close>
                  <Button variant="outline">Keep running</Button>
                </Dialog.Close>
                <Button variant="destructive" disabled={stopping} loading={stopping} onPress={() => void stop()}>
                  Stop bot
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog>
        </View>
      </ScrollView>
      </View>
    </ScreenErrorBoundary>
  );
}

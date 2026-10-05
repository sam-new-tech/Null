import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { TAB_CLEARANCE } from '@/constants/tabs';
import { Button } from 'panelui-native/components/button';
import { Card } from 'panelui-native/components/card';
import { ScreenHeader } from '@/components/screen-header';
import { ThinkingOrb } from 'panelui-native/components/thinking-orb';
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg';
import { Text } from 'panelui-native/primitives/text';

const SYMBOLS = ['XAUUSD', 'EURUSD', 'GBPUSD', 'BTCUSD'];

type LogTag = 'GRID' | 'ATR';

interface LogEntry {
  id: number;
  tag: LogTag;
  time: string;
  message: string;
}

function clockNow(): string {
  return new Date().toLocaleTimeString('en-GB');
}

function formatUptime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function randomLog(symbol: string): Omit<LogEntry, 'id' | 'time'> {
  if (Math.random() < 0.5) {
    const level = 1 + Math.floor(Math.random() * 5);
    const up = Math.random() < 0.5;
    const price = (2380 + Math.random() * 60).toFixed(2);
    return { tag: 'GRID', message: `Level ${up ? '+' : '−'}${level} filled @ ${price} (${symbol})` };
  }
  const atr = (1.8 + Math.random() * 1.6).toFixed(1);
  const step = (0.8 + Math.random() * 1.2).toFixed(2);
  return { tag: 'ATR', message: `ATR: ${atr} · grid step $${step}` };
}

export default function BotScreen() {
  const [running, setRunning] = useState(true);
  const [uptime, setUptime] = useState(5);
  const [logs, setLogs] = useState<LogEntry[]>([
    { id: 0, tag: 'ATR', time: clockNow(), message: 'ATR: 2.4 · grid step $1.20' },
  ]);
  const logId = useRef(1);

  const symbol = SYMBOLS[0];

  // Uptime ticks while running.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setUptime((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Bot event feed: append a grid/atr log entry.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const entry = randomLog(symbol);
      setLogs((prev) =>
        [{ ...entry, id: logId.current++, time: clockNow() }, ...prev].slice(0, 5),
      );
    }, 8000);
    return () => clearInterval(id);
  }, [running, symbol]);

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: TAB_CLEARANCE }}>
      <View className="gap-4 p-4">
        <ScreenHeader
          action={
            <Button
              size="sm"
              variant={running ? 'destructive' : 'primary'}
              onPress={() => setRunning((r) => !r)}>
              {running ? 'Stop' : 'Start'}
            </Button>
          }
        />

        <View className="items-center gap-3 py-2">
          <View className="items-center justify-center">
            <Svg
              width={260}
              height={220}
              viewBox="0 0 260 220"
              style={{ position: 'absolute', opacity: 0.8, pointerEvents: 'none' }}>
              <Defs>
                <RadialGradient id="orbGoo" cx="50%" cy="50%" r="50%">
                  <Stop offset="0%" stopColor="#16a34a" stopOpacity={0.22} />
                  <Stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Ellipse cx={130} cy={110} rx={120} ry={100} fill="url(#orbGoo)" />
            </Svg>
            <View
              className={`items-center justify-center rounded-full border border-border p-5 ${running ? '' : 'opacity-40'}`}>
              <ThinkingOrb state="working" size={120} paused={!running} />
            </View>
          </View>
          <Text size="lg" weight="bold" className="text-center">
            {running ? 'Bot is running' : 'Bot is stopped'}
          </Text>
          <Text size="sm" muted className="text-center font-mono">
            {`${symbol} · atr · grid · ${formatUptime(uptime)}`}
          </Text>
        </View>

        <Text size="sm" muted className="text-center uppercase tracking-widest">
          Bot activity
        </Text>

        <View className="gap-2">
          {logs.map((entry) => (
            <Card key={entry.id}>
              <Card.Content className="gap-2 p-4">
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center gap-2">
                    <View className="h-2 w-2 rounded-full bg-foreground" />
                    <Text size="xs" weight="bold" className="uppercase tracking-widest">
                      {entry.tag}
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
  );
}

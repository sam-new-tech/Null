import { useEffect, useRef, useState } from 'react';

import { REFERENCE_PRICES } from '@/constants/markets';
import { unitsPerLot } from '@/lib/ctrader/orders';
import type { ClosedTrade, MockAccount, Position, Side } from '@/lib/trading/types';

const TICK_MS = 2500;
const LIFECYCLE_MS = 9000;
const START_BALANCE = 753.14;
const MARGIN_PER_POSITION = 62.5;
const MAX_OPEN = 4;
const MAX_HISTORY = 30;

const SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD', 'US30', 'USDJPY'];

let nextId = 1;

function clockNow(): string {
  return new Date().toLocaleTimeString('en-GB');
}

function todayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function randomPosition(): Position {
  const side: Side = Math.random() < 0.5 ? 'buy' : 'sell';
  const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  const openPrice = REFERENCE_PRICES[symbol];
  const distance = openPrice * (0.002 + Math.random() * 0.006);
  const direction = side === 'buy' ? 1 : -1;
  const volume = [0.01, 0.05, 0.1][Math.floor(Math.random() * 3)];
  return {
    id: nextId++,
    symbol,
    side,
    volume,
    // Same formula as orders.ts: protocol volume = lots × units/lot × 100.
    rawVolume: Math.round(volume * unitsPerLot(symbol) * 100),
    pl: (Math.random() - 0.5) * 8,
    openPrice,
    tp: openPrice + direction * distance,
    sl: openPrice - direction * distance,
  };
}

interface FeedState {
  positions: Position[];
  history: ClosedTrade[];
}

/**
 * Mock trading feed: starts flat like a fresh account, then opens and closes
 * positions over time. Shapes match the live feed so screens never branch.
 */
export function useMockAccount(): MockAccount {
  const [feed, setFeed] = useState<FeedState>({ positions: [], history: [] });
  const feedRef = useRef(feed);

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  useEffect(() => {
    const tick = setInterval(() => {
      setFeed((prev) => ({
        ...prev,
        positions: prev.positions.map((p) => ({ ...p, pl: p.pl + (Math.random() - 0.5) * 4 })),
      }));
    }, TICK_MS);

    const lifecycle = setInterval(() => {
      let { positions, history } = feedRef.current;

      if (positions.length > 0 && Math.random() < 0.35) {
        const index = Math.floor(Math.random() * positions.length);
        const closed = positions[index];
        positions = positions.filter((_, i) => i !== index);
        history = [
          {
            id: closed.id,
            symbol: closed.symbol,
            side: closed.side,
            volume: closed.volume,
            pl: closed.pl,
            time: clockNow(),
            day: todayKey(),
          },
          ...history,
        ].slice(0, MAX_HISTORY);
      }
      if (positions.length < MAX_OPEN && Math.random() < 0.55) {
        positions = [...positions, randomPosition()];
      }
      setFeed({ positions, history });
    }, LIFECYCLE_MS);

    return () => {
      clearInterval(tick);
      clearInterval(lifecycle);
    };
  }, []);

  const { positions, history } = feed;
  const openPL = positions.reduce((sum, p) => sum + p.pl, 0);
  const equity = START_BALANCE + openPL;
  const margin = positions.length * MARGIN_PER_POSITION;
  const wins = history.filter((t) => t.pl > 0).length;

  return {
    account: {
      balance: START_BALANCE,
      equity,
      margin,
      freeMargin: equity - margin,
      marginLevel: margin > 0 ? (equity / margin) * 100 : 0,
    },
    stats: {
      trades: history.length,
      wins,
      winRate: history.length === 0 ? 0 : (wins / history.length) * 100,
      openPL,
      realizedPL: history.reduce((sum, t) => sum + t.pl, 0),
    },
    positions,
    orders: [],
    history,
  };
}

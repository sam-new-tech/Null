import { useEffect, useRef, useState } from 'react';

export type Side = 'buy' | 'sell';

export interface Position {
  id: number;
  symbol: string;
  side: Side;
  volume: number;
  pl: number;
  openPrice: number;
  tp: number;
  sl: number;
}

export interface ClosedTrade {
  id: number;
  symbol: string;
  side: Side;
  volume: number;
  pl: number;
  time: string;
}

export interface AccountState {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  /** Margin level in percent. 0 when there is no margin (display "—"). */
  marginLevel: number;
}

export interface DayStats {
  trades: number;
  wins: number;
  winRate: number;
  openPL: number;
}

export interface MockAccount {
  account: AccountState;
  stats: DayStats;
  positions: Position[];
  history: ClosedTrade[];
}

const TICK_MS = 2500;
const LIFECYCLE_MS = 9000;
const START_BALANCE = 753.14;
const MARGIN_PER_POSITION = 62.5;
const MAX_OPEN = 4;
const MAX_HISTORY = 30;

const SYMBOLS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD', 'US30', 'USDJPY'];

const BASE_PRICE: Record<string, number> = {
  EURUSD: 1.0852,
  GBPUSD: 1.2694,
  XAUUSD: 2415.3,
  BTCUSD: 97400,
  US30: 44250,
  USDJPY: 151.2,
};

let nextId = 1;

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function formatMoney(value: number): string {
  const formatted = currency.format(Math.abs(value));
  return value < 0 ? `-${formatted}` : `+${formatted}`;
}

export function formatPlainMoney(value: number): string {
  return currency.format(value);
}

export function formatPrice(symbol: string, value: number): string {
  const base = BASE_PRICE[symbol] ?? 100;
  return base < 10 ? value.toFixed(4) : value.toFixed(2);
}

function clockNow(): string {
  return new Date().toLocaleTimeString('en-GB');
}

function randomPosition(): Position {
  const side: Side = Math.random() < 0.5 ? 'buy' : 'sell';
  const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
  const openPrice = BASE_PRICE[symbol];
  const distance = openPrice * (0.002 + Math.random() * 0.006);
  const dir = side === 'buy' ? 1 : -1;
  return {
    id: nextId++,
    symbol,
    side,
    volume: [0.01, 0.05, 0.1][Math.floor(Math.random() * 3)],
    pl: (Math.random() - 0.5) * 8,
    openPrice,
    tp: openPrice + dir * distance,
    sl: openPrice - dir * distance,
  };
}

interface FeedState {
  positions: Position[];
  history: ClosedTrade[];
  trades: number;
  wins: number;
}

/**
 * Mock trading feed: starts flat like a fresh account, then opens/closes
 * positions over time. Same shape the real bot API will provide.
 */
export function useMockAccount(): MockAccount {
  const [feed, setFeed] = useState<FeedState>({ positions: [], history: [], trades: 0, wins: 0 });
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
      const prev = feedRef.current;
      let positions = prev.positions;
      let history = prev.history;
      let trades = prev.trades;
      let wins = prev.wins;

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
          },
          ...history,
        ].slice(0, MAX_HISTORY);
        trades += 1;
        if (closed.pl > 0) wins += 1;
      }
      if (positions.length < MAX_OPEN && Math.random() < 0.55) {
        positions = [...positions, randomPosition()];
      }
      setFeed({ positions, history, trades, wins });
    }, LIFECYCLE_MS);

    return () => {
      clearInterval(tick);
      clearInterval(lifecycle);
    };
  }, []);

  const { positions, history, trades, wins } = feed;
  const openPL = positions.reduce((sum, p) => sum + p.pl, 0);
  const equity = START_BALANCE + openPL;
  const margin = positions.length * MARGIN_PER_POSITION;
  const freeMargin = equity - margin;

  return {
    account: {
      balance: START_BALANCE,
      equity,
      margin,
      freeMargin,
      marginLevel: margin > 0 ? (equity / margin) * 100 : 0,
    },
    stats: {
      trades,
      wins,
      winRate: trades === 0 ? 0 : (wins / trades) * 100,
      openPL,
    },
    positions,
    history,
  };
}

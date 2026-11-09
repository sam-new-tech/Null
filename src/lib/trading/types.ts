/** Shared trading shapes. Kept free of React so they can be imported anywhere. */

export type Side = 'buy' | 'sell';

export interface Position {
  id: number;
  symbol: string;
  side: Side;
  /** Volume in lots, for display. */
  volume: number;
  /** Raw protocol volume, echoed back verbatim on close. */
  rawVolume: number;
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
  /** YYYY-MM-DD of the close, for per-day stats. */
  day: string;
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
  realizedPL: number;
}

export interface LiveOrder {
  id: string;
  symbol: string;
  side: Side;
  volume: number;
  limitPrice: number;
  stopLoss: number;
  takeProfit: number;
}

export interface MockAccount {
  account: AccountState;
  stats: DayStats;
  positions: Position[];
  orders: LiveOrder[];
  history: ClosedTrade[];
}

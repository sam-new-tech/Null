/**
 * Momentum Trend Bot Runner for cTrader.
 *
 * Implements the live real-time execution of the backtested strategy:
 * - Instrument: XAUUSD (Gold)
 * - Timeframe: 1-minute bars
 * - Indicators:
 *   - 5m EMA(50) (resampled from 1m closes, forward-filled)
 *   - 1m MACD(12, 26, 9)
 *   - 1m ADX(14) > 25
 *   - 1m VDC(20) > 20 (buy) / < -20 (sell)
 * - Take Profit: Entry ± 2.0 (fixed $2.00 target on Gold)
 * - Single managed position at a time (1 position max).
 */

import { liveEngine, scaleSpot } from '../ctrader/live';
import { Payload } from '../ctrader/protocol';
import {
  amendPositionSLTP,
  asSide,
  closePosition,
  isFilledStatus,
  mapTrendbars,
  placeMarketOrder,
  TrendbarPeriod,
} from '../ctrader/orders';
import { storeGet, storeSet } from '../storage';
import {
  calculateIndicators,
  calculateLots,
  evaluateSignal,
  STRATEGY_PARAMS,
  type Bar,
  type StrategyIndicators,
  type StrategySignal,
} from './engine';

export const BOT_LABEL_PREFIX = 'null-strat';
export const XAUUSD_UNITS_PER_LOT = 100;
/**
 * EMA(50) runs on 5-minute bars, so a signal needs at least 250 one-minute
 * bars before the first EMA value exists (plus a small alignment margin).
 * Fetching only 200 left `ema5m` null forever and the bot never signalled.
 */
const BAR_COUNT = 600;
const MIN_BARS = STRATEGY_PARAMS.ema5mPeriod * 5 + 5;
const STATE_KEY = 'null_strategy_bot.state';
const LOG_KEY = 'null_strategy_bot.logs';

export interface BotLogEntry {
  time: string;
  kind: 'info' | 'fill' | 'close' | 'signal' | 'error';
  message: string;
}

export interface ManagedPosition {
  id: number;
  side: 'buy' | 'sell';
  entry: number;
  tp: number;
  volume: number; // raw protocol volume
  lots: number;
  openedAt: number;
}

export interface BotStatus {
  state: 'stopped' | 'running';
  symbol: string;
  volumeLots: number;
  trendEma: number | null;
  indicators: StrategyIndicators;
  position: ManagedPosition | null;
  openManaged: number;
  restingCount: number;
  startedAt: number | null;
  lastTick: number | null;
  lastPrice: number | null;
  coolingDown: boolean;
  logs: BotLogEntry[];
}

interface PersistedState {
  state: 'stopped' | 'running';
  symbol: string;
  symbolId: number;
  digits: number;
  volumeLots: number;
  position: ManagedPosition | null;
  startedAt: number | null;
}

const DEFAULT_PERSISTED: PersistedState = {
  state: 'stopped',
  symbol: STRATEGY_PARAMS.symbol,
  symbolId: 0,
  digits: 2,
  volumeLots: 0.01,
  position: null,
  startedAt: null,
};

function clockNow(): string {
  return new Date().toLocaleTimeString('en-GB');
}

export class BotRunner {
  private persisted: PersistedState = { ...DEFAULT_PERSISTED };
  private listeners = new Set<() => void>();
  private tickListeners = new Set<() => void>();
  private logs: BotLogEntry[] = [];
  private revision = 0;
  private lastPrice: number | null = null;
  private lastTickAt: number | null = null;
  private loaded = false;
  private starting = false;
  private stopping = false;

  // Real-time bar buffer (1m bars)
  private bars: Bar[] = [];
  private formingBar: Bar | null = null;
  private currentIndicators: StrategyIndicators = {
    ema5m: null,
    macdLine: null,
    macdSignal: null,
    macdHist: null,
    adx: null,
    vdc: null,
  };

  // Subscriptions & timers
  private spotUnsub: (() => void) | null = null;
  private execUnsub: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pendingCloseId: number | null = null;
  private pendingEntryTime = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeTick = (listener: () => void): (() => void) => {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  };

  getRevision = (): number => this.revision;

  getTickPrice = (): number | null => this.lastPrice;

  getLivePrice = (): number | null => this.lastPrice;

  getStatus(): BotStatus {
    return {
      state: this.persisted.state,
      symbol: this.persisted.symbol,
      volumeLots: this.persisted.volumeLots,
      trendEma: this.currentIndicators.ema5m,
      indicators: this.currentIndicators,
      position: this.persisted.position,
      openManaged: this.persisted.position ? 1 : 0,
      restingCount: 0,
      startedAt: this.persisted.startedAt,
      lastTick: this.lastTickAt,
      lastPrice: this.lastPrice,
      coolingDown: false,
      logs: this.logs.slice(-50),
    };
  }

  managedPlAt(price: number): number {
    const pos = this.persisted.position;
    if (!pos || !Number.isFinite(price) || price <= 0) return 0;
    const units = pos.lots * XAUUSD_UNITS_PER_LOT;
    return pos.side === 'buy' ? (price - pos.entry) * units : (pos.entry - price) * units;
  }

  private emit(): void {
    this.revision++;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // Safe dispatch
      }
    }
  }

  private emitTick(): void {
    for (const l of this.tickListeners) {
      try {
        l();
      } catch {
        // Safe dispatch
      }
    }
  }

  private log(kind: BotLogEntry['kind'], message: string): void {
    const entry: BotLogEntry = { time: clockNow(), kind, message };
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.shift();
    void storeSet(LOG_KEY, JSON.stringify(this.logs.slice(-100)));
    this.emit();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await storeGet(STATE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        this.persisted = {
          ...DEFAULT_PERSISTED,
          ...parsed,
        };
      }
      const rawLogs = await storeGet(LOG_KEY);
      if (rawLogs) {
        const list = JSON.parse(rawLogs) as BotLogEntry[];
        if (Array.isArray(list)) this.logs = list;
      }
    } catch {
      // Defaults
    } finally {
      this.loaded = true;
      this.emit();
    }
  }

  private async persist(): Promise<void> {
    try {
      await storeSet(STATE_KEY, JSON.stringify(this.persisted));
    } catch {
      // Ignore
    }
  }

  private accountId(): number {
    const id = liveEngine.getAccountId();
    if (!id) throw new Error('Account not connected');
    return id;
  }

  private symbolId(symbol: string): number {
    const snapshot = liveEngine.getSnapshot();
    for (const [id, s] of snapshot.symbols) {
      if (s.symbolName === symbol) return id;
    }
    throw new Error(`Symbol ${symbol} not found`);
  }

  /**
   * Fetch historical 1m trendbars from cTrader.
   */
  private async fetchBars(symbolId: number, count = BAR_COUNT): Promise<Bar[]> {
    const res = await liveEngine.execRequest(Payload.GetTrendbarsReq, {
      ctidTraderAccountId: this.accountId(),
      symbolId,
      period: TrendbarPeriod.M1,
      count,
    });
    const bars = mapTrendbars(res);
    if (bars.length < MIN_BARS) {
      throw new Error(
        `Not enough historical bars (got ${bars.length}, need at least ${MIN_BARS}: 50 closed 5m bars for EMA50)`,
      );
    }

    return bars.map((b) => ({
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume ?? 1,
    }));
  }

  /**
   * Start the bot.
   */
  async start(): Promise<void> {
    await this.load();
    if (this.persisted.state === 'running') return;
    if (this.starting) throw new Error('Bot is currently starting');
    if (!liveEngine.connected) throw new Error('Connect cTrader account first');

    this.starting = true;
    try {
      const symId = this.symbolId(this.persisted.symbol);
      this.persisted.symbolId = symId;
      // Subscribe the strategy symbol immediately. Without this the runner
      // only gets ticks after a position exists (snapshot subscribes open
      // symbols), so real-time entries and TP checks stayed silent.
      liveEngine.ensureSpots([symId]);

      this.log('info', `Initializing strategy on ${this.persisted.symbol} M1...`);

      // 1. Fetch enough 1m history for EMA50 on resampled 5m bars.
      const fetched = await this.fetchBars(symId, BAR_COUNT);
      this.bars = fetched;

      // 2. Compute initial indicators
      const allInds = calculateIndicators(this.bars);
      this.currentIndicators = allInds[allInds.length - 1] ?? this.currentIndicators;

      const lastBar = this.bars[this.bars.length - 1];
      this.lastPrice = lastBar.close;

      // 3. Mark running
      this.persisted.state = 'running';
      this.persisted.startedAt = Date.now();
      await this.persist();

      // 4. Hook real-time events
      this.attachEvents();

      // 5. Periodic bar sync timer (every 60s)
      if (this.refreshTimer) clearInterval(this.refreshTimer);
      this.refreshTimer = setInterval(() => void this.syncBars(), 60_000);

      this.log(
        'info',
        `Strategy armed! 5mEMA: ${this.currentIndicators.ema5m?.toFixed(2) ?? '—'}, ADX: ${this.currentIndicators.adx?.toFixed(1) ?? '—'}, VDC: ${this.currentIndicators.vdc?.toFixed(1) ?? '—'}%`,
      );
      if (this.currentIndicators.ema5m === null) {
        this.log(
          'error',
          'EMA50 not ready — no signal until enough closed 5m bars. The bot will keep syncing history.',
        );
      }
    } finally {
      this.starting = false;
      this.emit();
    }
  }

  /**
   * Stop the bot and flatten managed position.
   */
  async stopAll(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      this.detachEvents();
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }

      // Close open position if any
      const pos = this.persisted.position;
      if (pos) {
        this.log('close', `Closing managed position ${pos.id} on bot stop`);
        try {
          const pair = closePosition(this.accountId(), pos.id, 0, 100, pos.volume);
          liveEngine.execSend(pair.type, pair.payload);
        } catch (err) {
          this.log('error', `Failed to close position: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      this.persisted.position = null;
      this.persisted.state = 'stopped';
      this.persisted.startedAt = null;
      await this.persist();
      this.log('info', 'Bot stopped successfully');
    } finally {
      this.stopping = false;
      this.emit();
    }
  }

  /**
   * Real-time tick & execution listener attachments.
   */
  private attachEvents(): void {
    this.detachEvents();

    // 1. Spot events (ticks)
    this.spotUnsub = liveEngine.onEvent(Payload.SpotEvent, (payload: Record<string, unknown>) => {
      if (payload.symbolId !== this.persisted.symbolId) return;
      // cTrader JSON spot quotes are 1e5-scaled ints; pre-flattened doubles
      // pass through. Scaling here keeps TP/bar math on real prices — the
      // previous raw read treated 4070.70 as ~407 million.
      const bid = scaleSpot(payload.bid ?? payload.ask);
      const ask = scaleSpot(payload.ask ?? payload.bid);
      const rawPrice = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
      if (rawPrice === null || !Number.isFinite(rawPrice) || rawPrice <= 0) return;

      this.lastPrice = rawPrice;
      this.lastTickAt = Date.now();
      this.emitTick();

      if (this.persisted.state === 'running') {
        this.handleTick(rawPrice);
      }
    });

    // 2. Execution events (fills, closes)
    this.execUnsub = liveEngine.onEvent(Payload.ExecutionEvent, (payload: Record<string, unknown>) => {
      this.handleExecution(payload);
    });
  }

  private detachEvents(): void {
    if (this.spotUnsub) {
      this.spotUnsub();
      this.spotUnsub = null;
    }
    if (this.execUnsub) {
      this.execUnsub();
      this.execUnsub = null;
    }
  }

  /**
   * Handle incoming spot tick.
   */
  private handleTick(price: number): void {
    const pos = this.persisted.position;

    // A. Check Take Profit for open position
    if (pos) {
      const hitTp = (pos.side === 'buy' && price >= pos.tp) || (pos.side === 'sell' && price <= pos.tp);

      if (hitTp && this.pendingCloseId !== pos.id) {
        this.pendingCloseId = pos.id;
        this.log(
          'close',
          `TP reached! Price ${price.toFixed(2)} hit ${pos.tp.toFixed(2)} (${pos.side.toUpperCase()}) — closing position`,
        );
        try {
          const pair = closePosition(this.accountId(), pos.id, 0, 100, pos.volume);
          liveEngine.execSend(pair.type, pair.payload);
        } catch (err) {
          this.pendingCloseId = null;
          this.log('error', `Close request failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    // B. Real-time forming 1-minute bar update
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000) * 60_000;

    if (!this.formingBar || this.formingBar.time !== currentMinute) {
      // Previous forming bar closed: push to historical bars
      if (this.formingBar) {
        this.bars.push(this.formingBar);
        if (this.bars.length > 250) this.bars.shift();

        // Evaluate signal on closed bar!
        this.evaluateAndTrade();
      }

      this.formingBar = {
        time: currentMinute,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 1,
      };
    } else {
      this.formingBar.high = Math.max(this.formingBar.high, price);
      this.formingBar.low = Math.min(this.formingBar.low, price);
      this.formingBar.close = price;
      this.formingBar.volume += 1;
    }
  }

  /**
   * Evaluate strategy signal and execute trade if criteria met.
   */
  private evaluateAndTrade(): void {
    if (this.persisted.state !== 'running' || this.persisted.position !== null) return;
    if (Date.now() - this.pendingEntryTime < 10_000) return; // Order in flight

    const allInds = calculateIndicators(this.bars);
    this.currentIndicators = allInds[allInds.length - 1] ?? this.currentIndicators;

    const signal: StrategySignal = evaluateSignal(this.bars, allInds);

    if (signal.action === 'buy' || signal.action === 'sell') {
      const equity = liveEngine.accountState().equity;
      const lots = calculateLots(equity, 0.05);

      this.pendingEntryTime = Date.now();
      this.log('signal', `${signal.reason} -> Placing ${signal.action.toUpperCase()} ${lots} lots (TP: ${signal.tp.toFixed(2)})`);

      try {
        const pair = placeMarketOrder(this.accountId(), {
          symbolId: this.persisted.symbolId,
          side: signal.action,
          volumeLots: lots,
          label: `${BOT_LABEL_PREFIX}_${signal.action}`,
          unitsPerLot: XAUUSD_UNITS_PER_LOT,
        });
        liveEngine.execSend(pair.type, pair.payload);
      } catch (err) {
        this.pendingEntryTime = 0;
        this.log('error', `Order placement error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Handle broker execution events (fills and closes).
   */
  private handleExecution(payload: Record<string, unknown>): void {
    const order = payload.order as Record<string, unknown> | undefined;
    const deal = payload.deal as Record<string, unknown> | undefined;
    const position = payload.position as Record<string, unknown> | undefined;

    // 1. Order Fill -> Position Opened
    if (isFilledStatus(order?.orderStatus) || isFilledStatus(payload.executionType)) {
      const posId = Number(position?.positionId ?? deal?.positionId ?? order?.positionId);
      const executionPrice = Number(deal?.executionPrice ?? this.lastPrice ?? 0);
      const volume = Number(deal?.volume ?? position?.volume ?? 0);
      const side = asSide(order?.tradeSide ?? deal?.tradeSide);

      if (posId > 0 && executionPrice > 0 && this.persisted.position === null) {
        const lots = volume > 0 ? volume / (XAUUSD_UNITS_PER_LOT * 100) : calculateLots(liveEngine.accountState().equity);
        const tp = side === 'buy' ? executionPrice + STRATEGY_PARAMS.tpDelta : executionPrice - STRATEGY_PARAMS.tpDelta;

        this.persisted.position = {
          id: posId,
          side,
          entry: executionPrice,
          tp,
          volume,
          lots: Math.max(0.01, Math.round(lots * 100) / 100),
          openedAt: Date.now(),
        };
        this.pendingEntryTime = 0;
        this.pendingCloseId = null;

        this.log('fill', `Filled ${side.toUpperCase()} ${posId} @ ${executionPrice.toFixed(2)} (TP: ${tp.toFixed(2)})`);

        // Register broker-side TP as safety net
        try {
          const tpPair = amendPositionSLTP(this.accountId(), {
            positionId: posId,
            takeProfit: tp,
          });
          liveEngine.execSend(tpPair.type, tpPair.payload);
        } catch {
          // Client-side tick monitoring covers exit
        }

        void this.persist();
        this.emit();
      }
    }

    // 2. Position Closed
    if (deal?.closePositionDetail && deal.positionId !== undefined) {
      const closedPosId = Number(deal.positionId);
      if (this.persisted.position && this.persisted.position.id === closedPosId) {
        const detail = deal.closePositionDetail as { grossProfit?: number };
        const grossProfit = Number(detail.grossProfit ?? 0) / 100;

        this.persisted.position = null;
        this.pendingCloseId = null;
        this.log('close', `Position ${closedPosId} closed! P/L: ${grossProfit >= 0 ? '+' : ''}$${grossProfit.toFixed(2)}`);

        void this.persist();
        this.emit();
      }
    }
  }

  /**
   * Periodic bar synchronization with broker.
   */
  private async syncBars(): Promise<void> {
    if (this.persisted.state !== 'running') return;
    try {
      const bars = await this.fetchBars(this.persisted.symbolId, BAR_COUNT);
      if (bars.length >= MIN_BARS) {
        this.bars = bars;
        const allInds = calculateIndicators(this.bars);
        this.currentIndicators = allInds[allInds.length - 1] ?? this.currentIndicators;
        this.emit();

        // Check entry condition on sync
        if (this.persisted.position === null) {
          this.evaluateAndTrade();
        }
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Background tick for OS background reconcile.
   */
  async backgroundTick(): Promise<boolean> {
    if (this.persisted.state !== 'running') return true;
    try {
      if (!liveEngine.connected) return false;
      await this.syncBars();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Alias for auth.tsx logout compatibility.
   */
  async stop(): Promise<void> {
    return this.stopAll();
  }

  /**
   * Closes the managed position (or cancels nothing for orders scope).
   * Called by trades.tsx "close all" button.
   */
  async flattenAll(
    _managed: boolean,
    _side?: string,
    scope?: 'orders' | 'positions',
  ): Promise<void> {
    if (scope === 'orders') return; // No resting orders in this strategy
    const pos = this.persisted.position;
    if (!pos) return;
    this.log('close', `flattenAll: closing managed position ${pos.id}`);
    try {
      const pair = closePosition(this.accountId(), pos.id, 0, XAUUSD_UNITS_PER_LOT, pos.volume);
      liveEngine.execSend(pair.type, pair.payload);
    } catch (err) {
      throw new Error(`flattenAll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const botRunner = new BotRunner();

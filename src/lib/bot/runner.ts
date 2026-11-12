/**
 * Momentum Trend Bot Runner for cTrader.
 *
 * Implements the live real-time execution of the backtested strategy:
 * - Instrument: XAUUSD (Gold)
 * - Timeframe: 1-minute bars
 * - Indicators:
 *   - 5m EMA(50) (resampled from 1m closes, forward-filled)
 *   - 1m ADX(14) > 20
 *   - 1m Volume Delta Control(14): buyers >= +20%, sellers <= -20%
 * - Take Profit: live price at entry ± 2.5 (fixed $2.50 target on Gold)
 * - No stop loss is ever placed
 * - Fixed 0.01 lots, up to floor(equity / 20) concurrent positions.
 */

import { liveEngine } from '../ctrader/live';
import { money, scaleSpot } from '../ctrader/wire';
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
import { ensureNotifyPermissions, notify } from '../notify';
import {
  BOT_LOT_SIZE,
  calculateIndicators,
  evaluateSignal,
  maxOpenPositions,
  STRATEGY_PARAMS,
  takeProfitFor,
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
/** Retry a TP close if no close deal confirms it within this window. */
const CLOSE_RETRY_MS = 15_000;
/** Broker TP amendments are re-sent until the position shows a take profit. */
const TP_RETRY_MS = 3_000;
const TP_MAX_ATTEMPTS = 4;
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
  positions: ManagedPosition[];
  openManaged: number;
  maxManaged: number;
  startedAt: number | null;
  lastTick: number | null;
  lastPrice: number | null;
  logs: BotLogEntry[];
}

interface PersistedState {
  state: 'stopped' | 'running';
  symbol: string;
  symbolId: number;
  digits: number;
  volumeLots: number;
  positions: ManagedPosition[];
  startedAt: number | null;
}

/** Pre-multi-position state stored a single `position`; migrate it on load. */
type LegacyPersistedState = Partial<PersistedState> & { position?: ManagedPosition | null };

const DEFAULT_PERSISTED: PersistedState = {
  state: 'stopped',
  symbol: STRATEGY_PARAMS.symbol,
  symbolId: 0,
  digits: 2,
  volumeLots: BOT_LOT_SIZE,
  positions: [],
  startedAt: null,
};

function clockNow(): string {
  return new Date().toLocaleTimeString('en-GB');
}

/**
 * Execution-event fill check. ProtoOAExecutionType ORDER_FILLED is 3 (the JSON
 * transport usually sends the name), which is NOT the same as OrderStatus
 * 2 = ORDER_STATUS_FILLED, so it must be checked separately.
 */
function isFillExecution(value: unknown): boolean {
  return value === 'ORDER_FILLED' || value === 3 || value === '3';
}

/**
 * Normalize a price from a response payload. cTrader's JSON gateway returns
 * some prices as 1e5-scaled integers (spot quotes, trendbars); gold never
 * trades above 100k, so anything larger is a scaled integer.
 */
function toRealPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 100_000 ? value / 100_000 : value;
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
    adx: null,
    vdc: null,
  };

  // Subscriptions & timers
  private spotUnsub: (() => void) | null = null;
  private execUnsub: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private attached = false;
  /** Last close attempt per position id (retry gate for unconfirmed TPs). */
  private pendingCloseAt = new Map<number, number>();
  /** Pending broker-TP verification timers per position id. */
  private tpTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingEntryTime = 0;
  /** Last bar timestamp that produced an entry — one entry per closed bar. */
  private lastEntryBarTime = 0;

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
    const positions = this.persisted.positions;
    return {
      state: this.persisted.state,
      symbol: this.persisted.symbol,
      volumeLots: this.persisted.volumeLots,
      trendEma: this.currentIndicators.ema5m,
      indicators: this.currentIndicators,
      positions,
      openManaged: positions.length,
      maxManaged: maxOpenPositions(liveEngine.accountState().equity),
      startedAt: this.persisted.startedAt,
      lastTick: this.lastTickAt,
      lastPrice: this.lastPrice,
      logs: this.logs.slice(-50),
    };
  }

  managedPlAt(price: number): number {
    if (!Number.isFinite(price) || price <= 0) return 0;
    return this.persisted.positions.reduce((sum, pos) => {
      const units = pos.lots * XAUUSD_UNITS_PER_LOT;
      return sum + (pos.side === 'buy' ? (price - pos.entry) * units : (pos.entry - price) * units);
    }, 0);
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
        const parsed = JSON.parse(raw) as LegacyPersistedState;
        const { position: legacyPosition, positions: storedPositions, ...rest } = parsed;
        const stored = Array.isArray(storedPositions)
          ? storedPositions
          : legacyPosition
            ? [legacyPosition]
            : [];
        const digits = Math.min(8, Math.max(0, typeof rest.digits === 'number' ? rest.digits : 2));
        this.persisted = {
          ...DEFAULT_PERSISTED,
          ...rest,
          // Sizing is fixed now; ignore pre-upgrade equity-scaled values.
          volumeLots: BOT_LOT_SIZE,
          // Re-anchor every restored TP to entry ± 2.50 (older builds stored 2.00
          // or, in the worst case, no TP at all).
          positions: stored.map((p) =>
            Number.isFinite(p.entry) && p.entry > 0
              ? { ...p, tp: Number(takeProfitFor(p.side, p.entry).toFixed(digits)) }
              : p,
          ),
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

  /** Symbol price digits (XAUUSD is usually 2). */
  private symbolDigits(): number {
    const info = liveEngine.getSnapshot().symbols.get(this.persisted.symbolId);
    return info?.digits ?? this.persisted.digits ?? 2;
  }

  /**
   * Take profit for a new entry, anchored to the live price so every fill gets
   * one (buy = live + 2.50, sell = live - 2.50). The fill price is only a
   * fallback when no tick is available.
   */
  private entryTakeProfit(side: 'buy' | 'sell', fillPrice: number): number {
    const live = this.lastPrice;
    let anchor = fillPrice;
    if (live !== null && Number.isFinite(live) && live > 0) {
      // Ignore a 1e5-scaled or otherwise mismatched fill price.
      if (!(fillPrice > 0) || Math.abs(live - fillPrice) <= Math.max(10, live * 0.01)) {
        anchor = live;
      }
    }
    const digits = this.symbolDigits();
    return Number(takeProfitFor(side, anchor).toFixed(digits));
  }

  /** Broker-side take profit for a position, normalized to a real price. */
  private brokerTakeProfit(positionId: number): number | null {
    const pos = liveEngine
      .getSnapshot()
      .positions.find((p) => Number(p.positionId) === positionId);
    const raw = pos?.takeProfit;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return toRealPrice(raw);
  }

  /**
   * Push the managed TP to the broker and verify it. cTrader sends no direct
   * response for ProtoOAAmendPositionSLTPReq, so a short timer re-checks the
   * position and retries (the amend is idempotent). No stop loss is ever sent.
   */
  private applyBrokerTakeProfit(pos: ManagedPosition, attempt = 0): void {
    const existing = this.tpTimers.get(pos.id);
    if (existing) clearTimeout(existing);

    try {
      const pair = amendPositionSLTP(this.accountId(), {
        positionId: pos.id,
        takeProfit: pos.tp,
      });
      liveEngine.execSend(pair.type, pair.payload);
      if (attempt === 0) {
        this.log('info', `TP ${pos.tp.toFixed(2)} set on position ${pos.id} (no stop loss)`);
      }
    } catch (err) {
      this.log(
        'error',
        `TP amend failed for ${pos.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const timer = setTimeout(() => {
      this.tpTimers.delete(pos.id);
      if (this.persisted.state !== 'running') return;
      if (!this.persisted.positions.some((p) => p.id === pos.id)) return;
      const brokerTp = this.brokerTakeProfit(pos.id);
      if (brokerTp !== null && Math.abs(brokerTp - pos.tp) < 0.05) return;
      if (attempt + 1 >= TP_MAX_ATTEMPTS) {
        this.log(
          'error',
          `Position ${pos.id} has no TP ${pos.tp.toFixed(2)} after ${TP_MAX_ATTEMPTS} attempts`,
        );
        return;
      }
      this.applyBrokerTakeProfit(pos, attempt + 1);
    }, TP_RETRY_MS);
    this.tpTimers.set(pos.id, timer);
  }

  /** Re-apply TP to any managed position the broker shows without one. */
  private ensureBrokerTakeProfits(): void {
    this.adoptMissedFills();
    if (this.persisted.positions.length === 0) return;
    const open = new Set(liveEngine.getSnapshot().positions.map((p) => Number(p.positionId)));
    for (const pos of this.persisted.positions) {
      // A stale snapshot right after a fill has no rows yet; only skip when the
      // broker reports positions but not this one.
      if (open.size > 0 && !open.has(pos.id)) continue;
      if (this.tpTimers.has(pos.id)) continue;
      const brokerTp = this.brokerTakeProfit(pos.id);
      if (brokerTp !== null && Math.abs(brokerTp - pos.tp) < 0.05) continue;
      this.applyBrokerTakeProfit(pos);
    }
  }

  /**
   * Safety net for a missed fill event: adopt bot-labelled broker positions
   * that the runner does not track yet, so they get their TP too.
   */
  private adoptMissedFills(): void {
    if (this.persisted.state !== 'running') return;
    for (const p of liveEngine.getSnapshot().positions) {
      const label = p.tradeData?.label ?? '';
      if (!label.startsWith(BOT_LABEL_PREFIX)) continue;
      if (Number(p.tradeData?.symbolId) !== this.persisted.symbolId) continue;
      const id = Number(p.positionId);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (this.persisted.positions.some((m) => m.id === id)) continue;

      const side = asSide(p.tradeData.tradeSide);
      const entry = toRealPrice(Number(p.price ?? 0)) || this.lastPrice || 0;
      if (entry <= 0) continue;

      const volume = Number(p.tradeData.volume ?? 0);
      const lots = volume > 0 ? volume / (XAUUSD_UNITS_PER_LOT * 100) : BOT_LOT_SIZE;
      const opened: ManagedPosition = {
        id,
        side,
        entry,
        tp: this.entryTakeProfit(side, entry),
        volume,
        lots: Math.max(BOT_LOT_SIZE, Math.round(lots * 100) / 100),
        openedAt: Number(p.tradeData.openTimestamp ?? Date.now()),
      };
      this.persisted.positions = [...this.persisted.positions, opened];
      this.log(
        'fill',
        `Recovered ${side.toUpperCase()} ${id} @ ${entry.toFixed(2)} (TP: ${opened.tp.toFixed(2)})`,
      );
      this.applyBrokerTakeProfit(opened);
      void this.persist();
    }
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
    // A persisted `running` state means the app was restarted (or reconnected)
    // mid-session: reattach live events/history instead of silently doing nothing.
    if (this.persisted.state === 'running') {
      if (!liveEngine.connected) throw new Error('Connect cTrader account first');
      await this.resume();
      return;
    }
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

      void ensureNotifyPermissions();

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
   * Reattach a strategy that was already running before a restart/reconnect:
   * subscriptions, spot stream, bar timer and a history resync. Safe to call
   * repeatedly — the timer is created once and events detach/reattach.
   */
  async resume(): Promise<void> {
    await this.load();
    if (this.persisted.state !== 'running') return;
    if (!liveEngine.connected) return;

    const symbolId = this.persisted.symbolId || this.symbolId(this.persisted.symbol);
    this.persisted.symbolId = symbolId;
    // Without a spot subscription real-time entries and TP checks stay silent.
    liveEngine.ensureSpots([symbolId]);

    const wasAttached = this.attached;
    this.attachEvents();
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => void this.syncBars(), 60_000);
    }
    if (!wasAttached) {
      this.log('info', 'Bot resumed — reattached live events');
      void ensureNotifyPermissions();
    }
    await this.syncBars();
    this.ensureBrokerTakeProfits();
    this.emit();
  }

  /** Called after login/restore and on the bot screen mount. */
  async resumeIfRunning(): Promise<void> {
    await this.load();
    if (this.persisted.state !== 'running') return;
    if (!liveEngine.connected) return;
    await this.resume();
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

      // Close every managed position.
      if (this.persisted.positions.length > 0) {
        this.log('close', `Closing ${this.persisted.positions.length} managed position(s) on bot stop`);
        for (const pos of this.persisted.positions) {
          try {
            const pair = closePosition(this.accountId(), pos.id, 0, 100, pos.volume);
            liveEngine.execSend(pair.type, pair.payload);
          } catch (err) {
            this.log(
              'error',
              `Failed to close position ${pos.id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      this.persisted.positions = [];
      this.persisted.state = 'stopped';
      this.persisted.startedAt = null;
      this.pendingCloseAt.clear();
      for (const timer of this.tpTimers.values()) clearTimeout(timer);
      this.tpTimers.clear();
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
    this.attached = true;

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
    this.attached = false;
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
    // A. Check Take Profit for every open position.
    if (this.persisted.positions.length > 0) {
      const now = Date.now();
      for (const pos of this.persisted.positions) {
        const hitTp = (pos.side === 'buy' && price >= pos.tp) || (pos.side === 'sell' && price <= pos.tp);
        const lastAttempt = this.pendingCloseAt.get(pos.id) ?? 0;
        if (!hitTp || now - lastAttempt < CLOSE_RETRY_MS) continue;

        this.pendingCloseAt.set(pos.id, now);
        this.log(
          'close',
          `TP reached! Price ${price.toFixed(2)} hit ${pos.tp.toFixed(2)} (${pos.side.toUpperCase()}) — closing position ${pos.id}`,
        );
        try {
          const pair = closePosition(this.accountId(), pos.id, 0, 100, pos.volume);
          liveEngine.execSend(pair.type, pair.payload);
        } catch (err) {
          this.pendingCloseAt.delete(pos.id);
          this.log('error', `Close request failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // B. Real-time forming 1-minute bar update (runs with or without positions,
    // so bar history stays continuous for the next signal).
    const now = Date.now();
    const currentMinute = Math.floor(now / 60_000) * 60_000;

    if (!this.formingBar || this.formingBar.time !== currentMinute) {
      // Previous forming bar closed: push to historical bars
      if (this.formingBar) {
        this.bars.push(this.formingBar);
        if (this.bars.length > BAR_COUNT) this.bars.shift();

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
    if (this.persisted.state !== 'running') return;
    const equity = liveEngine.accountState().equity;
    const maxPositions = maxOpenPositions(equity);
    if (this.persisted.positions.length >= maxPositions) return;
    if (Date.now() - this.pendingEntryTime < 10_000) return; // Order in flight

    const allInds = calculateIndicators(this.bars);
    this.currentIndicators = allInds[allInds.length - 1] ?? this.currentIndicators;

    const signal: StrategySignal = evaluateSignal(this.bars, allInds);

    if (signal.action === 'buy' || signal.action === 'sell') {
      // One entry per closed bar: the timer sync and the tick loop can both
      // observe the same latest bar.
      const barTime = this.bars[this.bars.length - 1]?.time ?? 0;
      if (barTime === this.lastEntryBarTime) return;

      this.lastEntryBarTime = barTime;
      this.pendingEntryTime = Date.now();
      const previewTp = this.entryTakeProfit(signal.action, signal.price);
      this.log(
        'signal',
        `${signal.reason} -> Placing ${signal.action.toUpperCase()} ${BOT_LOT_SIZE} lots (${this.persisted.positions.length + 1}/${maxPositions}, TP: ${previewTp.toFixed(2)})`,
      );

      try {
        const pair = placeMarketOrder(this.accountId(), {
          symbolId: this.persisted.symbolId,
          side: signal.action,
          volumeLots: BOT_LOT_SIZE,
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
    if (isFilledStatus(order?.orderStatus) || isFillExecution(payload.executionType)) {
      const posId = Number(position?.positionId ?? deal?.positionId ?? order?.positionId);
      const executionPrice = toRealPrice(Number(deal?.executionPrice ?? this.lastPrice ?? 0));
      const volume = Number(deal?.volume ?? position?.volume ?? 0);
      const side = asSide(order?.tradeSide ?? deal?.tradeSide);

      if (posId > 0 && executionPrice > 0 && !this.persisted.positions.some((p) => p.id === posId)) {
        const lots = volume > 0 ? volume / (XAUUSD_UNITS_PER_LOT * 100) : BOT_LOT_SIZE;
        // Every entry gets a TP 2.50 away from the live price (no stop loss).
        const tp = this.entryTakeProfit(side, executionPrice);

        const opened: ManagedPosition = {
          id: posId,
          side,
          entry: executionPrice,
          tp,
          volume,
          lots: Math.max(BOT_LOT_SIZE, Math.round(lots * 100) / 100),
          openedAt: Date.now(),
        };
        this.persisted.positions = [...this.persisted.positions, opened];
        this.pendingEntryTime = 0;
        this.pendingCloseAt.delete(posId);

        this.log(
          'fill',
          `Filled ${side.toUpperCase()} ${posId} @ ${executionPrice.toFixed(2)} (TP: ${tp.toFixed(2)}, ${this.persisted.positions.length} open)`,
        );
        void notify(
          'Bot filled',
          `${side.toUpperCase()} ${this.persisted.symbol} @ ${executionPrice.toFixed(2)} (TP ${tp.toFixed(2)})`,
        );

        // Guarantee the TP reaches the broker: send + verify + retry.
        this.applyBrokerTakeProfit(opened);

        void this.persist();
        this.emit();
      }
    }

    // 2. Position Closed
    if (deal?.closePositionDetail && deal.positionId !== undefined) {
      const closedPosId = Number(deal.positionId);
      const closed = this.persisted.positions.find((p) => p.id === closedPosId);
      if (closed) {
        const detail = deal.closePositionDetail as { grossProfit?: number; moneyDigits?: number };
        const traderDigits = liveEngine.getSnapshot().trader?.moneyDigits ?? 2;
        // Close details are integer-scaled by moneyDigits (often 2), same as balance.
        const grossProfit = money(
          typeof detail.grossProfit === 'number' ? detail.grossProfit : undefined,
          typeof detail.moneyDigits === 'number' ? detail.moneyDigits : traderDigits,
        );

        this.persisted.positions = this.persisted.positions.filter((p) => p.id !== closedPosId);
        this.pendingCloseAt.delete(closedPosId);
        this.log(
          'close',
          `Position ${closedPosId} closed! P/L: ${grossProfit >= 0 ? '+' : ''}$${grossProfit.toFixed(2)} (${this.persisted.positions.length} open)`,
        );
        void notify(
          'Bot closed',
          `${this.persisted.symbol} P/L ${grossProfit >= 0 ? '+' : ''}$${grossProfit.toFixed(2)}`,
        );

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

        // Any managed position the broker shows without a TP gets one again.
        this.ensureBrokerTakeProfits();

        // Check entry condition on sync (evaluateAndTrade enforces the slot cap).
        this.evaluateAndTrade();
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
}

export const botRunner = new BotRunner();

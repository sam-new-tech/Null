import * as Notifications from 'expo-notifications';

import { liveEngine, LiveEngine } from '../ctrader/live';
import { Payload } from '../ctrader/protocol';
import { CTraderClient } from '../ctrader/client';
import { loadSession } from '../ctrader/session';
import {
  cancelOrder,
  closePosition,
  isCancelRejectedStatus,
  isFilledStatus,
  isRejectedStatus,
  mapTrendbars,
  placeLimitOrder,
  placeMarketOrder,
  TrendbarPeriod,
  unitsPerLot,
} from '../ctrader/orders';
import { storeGet, storeSet } from '../storage';
import {
  buildGrid,
  crossedLevel,
  dcaAvg,
  dcaNextAdd,
  dcaTarget,
  isUpBar,
  lotsFor,
  planTick,
  type Bar,
  type GridSetup,
} from './engine';

export const BOT_LABEL_PREFIX = 'null-grid';
export const XAUUSD_UNITS_PER_LOT = 100;
const STATE_KEY = 'nullgrid.state';
const LOG_KEY = 'nullgrid.logs';

/**
 * Strategy rules — the bot cannot do anything outside these, no matter
 * what ticks arrive. Mirrors the verified sim (ATR10 x1.9 n10, TP 1 step,
 * disaster SL 8 steps). Change only after re-running app-sim.ts green.
 */
export const STRATEGY_RULES = {
  symbol: 'XAUUSD',
  atrLen: 14,
  gridMult: 1.9,
  levels: 10,
  tpSteps: 1,
  disasterSteps: 8,
  /** DCA books: adds per book, basket exit at avg ± basketSteps. */
  maxAdds: 6,
  basketSteps: 0.5,
  maxBooksPerSide: 3,
  maxOrders: 20,
  maxPositions: 20,
  maxRiskPct: 3,
  maxLotsPerLevel: 0.05,
  maxDrawdownPct: 5,
  maxEscapesPerHour: 3,
} as const;

export interface BotLogEntry {
  time: string;
  kind: 'info' | 'fill' | 'close' | 'escape' | 'error';
  message: string;
}

export interface BotStatus {
  state: 'stopped' | 'running';
  symbol: string;
  riskPct: number;
  volumeLots: number;
  atr: number | null;
  step: number | null;
  base: number | null;
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
  riskPct: number;
  volumeLots: number;
  leverage: number;
  grid: GridSetup | null;
  atr: number | null;
  managedOrders: { id: string; side: 'buy' | 'sell'; price: number }[];
  managedPositions: { id: number; side: 'buy' | 'sell'; entry: number }[];
  /** DCA books: legs of one averaged position sharing an anchor level. */
  books: { side: 'buy' | 'sell'; anchor: number; legIds: number[] }[];
  startedAt: number | null;
  startEquity: number | null;
  escapeTimes: number[];
}

const DEFAULT_PERSISTED: PersistedState = {
  state: 'stopped',
  symbol: 'XAUUSD',
  symbolId: 0,
  digits: 2,
  riskPct: 2,
  volumeLots: 0.02,
  leverage: 100,
  grid: null,
  atr: null,
  managedOrders: [],
  managedPositions: [],
  books: [],
  startedAt: null,
  startEquity: null,
  escapeTimes: [],
};

function clockNow(): string {
  return new Date().toLocaleTimeString('en-GB');
}

async function notify(title: string, body: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch {
    // Notifications unavailable — logs still persist in-app.
  }
}

/**
 * Grid bot runner. Foreground loop + background ticks share one reconcile core.
 * All trading state persists on-device; restarts resume cleanly.
 */
class BotRunner {
  private persisted: PersistedState = DEFAULT_PERSISTED;
  private listeners = new Set<() => void>();
  /** Tick listeners: fired on EVERY spot tick (price only, no status work). */
  private tickListeners = new Set<() => void>();
  private logs: BotLogEntry[] = [];
  private revision = 0;
  private lastEmitAt: number | null = null;
  private lastPrice: number | null = null;
  private lastUiEmit = 0;
  private barDir: 'up' | 'down' | null = null;
  private lastBarTime = 0;
  private lastEscapeAt = 0;
  private failures = 0;
  private coolUntil = 0;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private spotUnsub: (() => void) | null = null;
  private execUnsub: (() => void) | null = null;
  private orderErrUnsub: (() => void) | null = null;
  private loaded = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Per-tick subscription for price/P-L widgets (bypasses the 1s status throttle). */
  subscribeTick = (listener: () => void): (() => void) => {
    this.tickListeners.add(listener);
    return () => {
      this.tickListeners.delete(listener);
    };
  };

  getTickPrice = (): number | null => this.lastPrice;

  /** Instant managed P/L at a price (no snapshot, no floats): Σ dir·Δ·lots·100oz. */
  managedPlAt(price: number): number {
    if (!Number.isFinite(price)) return 0;
    let pl = 0;
    for (const m of this.persisted.managedPositions) {
      if (!Number.isFinite(m.entry)) continue;
      const dir = m.side === 'buy' ? 1 : -1;
      pl += dir * (price - m.entry) * this.persisted.volumeLots * 100;
    }
    return pl;
  }

  private emit(): void {
    this.revision += 1;
    this.lastEmitAt = Date.now();
    this.listeners.forEach((listener) => listener());
  }

  getRevision = (): number => this.revision;

  private async persist(): Promise<void> {
    try {
      await storeSet(STATE_KEY, JSON.stringify(this.persisted));
      await storeSet(LOG_KEY, JSON.stringify(this.logs.slice(0, 60)));
    } catch {
      // Best effort.
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await storeGet(STATE_KEY);
      if (raw) this.persisted = { ...DEFAULT_PERSISTED, ...(JSON.parse(raw) as Partial<PersistedState>) };
      const logs = await storeGet(LOG_KEY);
      if (logs) this.logs = JSON.parse(logs) as BotLogEntry[];
    } catch {
      // Fresh start.
    }
    this.emit();
  }

  private log(kind: BotLogEntry['kind'], message: string): void {
    this.logs = [{ time: clockNow(), kind, message }, ...this.logs].slice(0, 60);
    void this.persist();
    this.emit();
    if (kind === 'fill' || kind === 'close' || kind === 'escape') {
      void notify(kind === 'escape' ? 'Grid escaped — re-anchored' : 'Grid bot', message);
    }
  }

  getStatus(): BotStatus {
    const p = this.persisted;
    return {
      state: p.state,
      symbol: p.symbol,
      riskPct: p.riskPct,
      volumeLots: p.volumeLots,
      atr: p.atr,
      step: p.grid?.step ?? null,
      base: p.grid?.base ?? null,
      openManaged: p.managedPositions.length,
      restingCount: p.managedOrders.length,
      startedAt: p.startedAt,
      lastTick: this.lastEmitAt,
      lastPrice: this.lastPrice,
      coolingDown: Date.now() < this.coolUntil,
      logs: this.logs,
    };
  }

  get running(): boolean {
    return this.persisted.state === 'running';
  }

  private accountId(): number {
    const id = liveEngine.getAccountId();
    if (!id) throw new Error('Trading account is not connected');
    return id;
  }

  private symbolId(symbol: string): number {
    const snapshot = liveEngine.getSnapshot();
    for (const [id, s] of snapshot.symbols) {
      if (s.symbolName === symbol) return id;
    }
    throw new Error(`Symbol ${symbol} is not known — reconnect first`);
  }

  private async fetchBars(symbolId: number, count = 130): Promise<Bar[]> {
    const res = await liveEngine.execRequest(Payload.GetTrendbarsReq, {
      ctidTraderAccountId: this.accountId(),
      symbolId,
      period: TrendbarPeriod.M30,
      count,
    });
    const bars = mapTrendbars(res.trendbar ?? res);
    if (bars.length < 25) throw new Error('Not enough M30 history for ATR(14)');
    // Drop the forming bar — anchor on the last CLOSED bar.
    const closed = bars.slice(0, -1);
    return closed.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  }

  /** Start the bot: build the grid from live ATR and place the 20 limits. */
  async start(riskPct: number): Promise<void> {
    await this.load();
    if (this.persisted.state === 'running') return;
    if (!liveEngine.connected) throw new Error('Connect the trading account first');
    if (this.persisted.symbol !== STRATEGY_RULES.symbol) {
      throw new Error(`Strategy allows ${STRATEGY_RULES.symbol} only`);
    }
    if (!(riskPct > 0) || riskPct > STRATEGY_RULES.maxRiskPct) {
      throw new Error(`Risk per level capped at ${STRATEGY_RULES.maxRiskPct}%`);
    }

    const account = liveEngine.accountState();
    const snapshot = liveEngine.getSnapshot();
    const leverage = snapshot.trader?.leverageInCents ? snapshot.trader.leverageInCents / 100 : 100;
    const symbolId = this.symbolId(this.persisted.symbol);
    let digits = 2;
    try {
      const res = await liveEngine.execRequest(Payload.SymbolByIdReq, {
        ctidTraderAccountId: liveEngine.getAccountId(),
        symbolId: [symbolId],
      });
      const list = (res.symbol ?? []) as { digits?: number }[];
      if (typeof list[0]?.digits === 'number') digits = list[0].digits;
    } catch {
      // Fall back to 2 decimals.
    }
    try {
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') await Notifications.requestPermissionsAsync();
    } catch {
      // Notifications are optional.
    }

    const bars = await this.fetchBars(symbolId);
    const lastBar = bars[bars.length - 1];
    const grid = buildGrid(bars, STRATEGY_RULES.atrLen, STRATEGY_RULES.gridMult, STRATEGY_RULES.levels);
    // Width guard: refuse grids narrower than one M30 bar (escape-churn trap).
    if (lastBar.high - lastBar.low > grid.step * STRATEGY_RULES.levels) {
      throw new Error(
        `Grid too narrow for current volatility (bar $${(lastBar.high - lastBar.low).toFixed(2)} > range $${(grid.step * STRATEGY_RULES.levels).toFixed(2)}) — try again later`,
      );
    }
    const atr = grid.step / STRATEGY_RULES.gridMult;
    const marginPerLevel = (account.equity * riskPct) / 100;
    let volumeLots = lotsFor(marginPerLevel, lastBar.close, leverage, XAUUSD_UNITS_PER_LOT);
    // Hard cap: 20 max-open levels must fit in free margin with headroom.
    const maxByMargin =
      account.freeMargin / (STRATEGY_RULES.levels * 2 * ((lastBar.close * XAUUSD_UNITS_PER_LOT) / leverage));
    volumeLots = Math.max(
      0.01,
      Math.min(volumeLots, STRATEGY_RULES.maxLotsPerLevel, Math.floor(maxByMargin * 100) / 100),
    );
    if (volumeLots < 0.01) throw new Error('Free margin too low for one level');

    this.persisted = {
      ...this.persisted,
      state: 'running',
      symbolId,
      digits,
      riskPct,
      volumeLots,
      leverage,
      grid,
      atr,
      managedOrders: [],
      managedPositions: [],
      books: [],
      startedAt: Date.now(),
      startEquity: account.equity,
      escapeTimes: [],
    };
    this.barDir = isUpBar(lastBar) ? 'up' : 'down';
    this.lastBarTime = lastBar.time;
    this.lastPrice = null;
    await this.persist();
    this.log('info', `DCA armed: step ${grid.step.toFixed(2)}, ${volumeLots.toFixed(2)} lots/leg, ${STRATEGY_RULES.maxAdds} adds, basket ${STRATEGY_RULES.basketSteps} step, risk ${riskPct}%`);

    liveEngine.execSend(Payload.SubscribeSpotsReq, {
      ctidTraderAccountId: this.accountId(),
      symbolId: [symbolId],
    });
    liveEngine.ensureSpots([symbolId]);
    if (this.spotUnsub) this.spotUnsub();
    this.spotUnsub = liveEngine.onEvent(Payload.SpotEvent, (payload) => {
      if (payload.symbolId !== symbolId) return;
      const bid = payload.bid as number | undefined;
      const ask = payload.ask as number | undefined;
      if (bid === undefined && ask === undefined) return;
      const mid = ((bid ?? ask ?? 0) + (ask ?? bid ?? 0)) / 2 / 100000;
      void this.onSpot(mid);
    });
    if (this.execUnsub) this.execUnsub();
    this.execUnsub = liveEngine.onEvent(Payload.ExecutionEvent, (payload) => this.onExecution(payload));
    if (this.orderErrUnsub) this.orderErrUnsub();
    this.orderErrUnsub = liveEngine.onEvent(Payload.OrderErrorEvent, (payload) => {
      const code = payload.errorCode as string | undefined;
      const desc = payload.description as string | undefined;
      this.log('error', `Order error: ${code ?? 'UNKNOWN'}${desc ? ` — ${desc}` : ''}`);
    });
    await this.placeFullGrid();
    this.startReconcileLoop();
    this.emit();
    // Verify against the broker: reconcile once and report what is resting.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    try {
      await this.reconcile();
      const resting = this.persisted.managedOrders.length;
      this.log('info', resting > 0 ? `${resting}/20 resting confirmed at broker` : 'Broker shows no resting limits — check rejections above');
      this.emit();
    } catch {
      // Reconcile loop covers it.
    }
  }

  /** Stop: cancel ALL our limits and close ALL our positions. Manual trades are untouched. */
  /** Wait for an ExecutionEvent matching a predicate, with timeout. */
  private awaitExecution(
    match: (payload: Record<string, unknown>) => boolean,
    timeoutMs = 10000,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const off = liveEngine.onEvent(Payload.ExecutionEvent, (payload) => {
        try {
          if (match(payload)) {
            off();
            resolve(true);
          }
        } catch {
          // Ignore malformed events.
        }
      });
      setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
    });
  }

  /** Close ALL open positions + cancel ALL resting orders. No state change. */
  async flattenAll(): Promise<{ positions: number; orders: number }> {
    await this.load();
    let positions = 0;
    let orders = 0;
    try {
      const accountId = this.accountId();
      const res = await liveEngine.execRequest(Payload.ReconcileReq, { ctidTraderAccountId: accountId });
      const snapshot = liveEngine.getSnapshot();
      const nameOf = (id: number) => snapshot.symbols.get(id)?.symbolName ?? '';
      const open = ((res.position ?? []) as {
        positionId: number;
        tradeData: { symbolId: number; volume: number };
        positionStatus?: string;
      }[]).filter((pos) => pos.positionStatus === 'POSITION_STATUS_OPEN' || pos.positionStatus === undefined);
      const resting = ((res.order ?? []) as { orderId: number }[]).filter(Boolean);
      for (const pos of open) {
        try {
          // Echo the exact protocol volume back — no unit math, always exact.
          const pair = closePosition(accountId, pos.positionId, 0, 100000, pos.tradeData.volume);
          liveEngine.execSend(pair.type, pair.payload);
          const confirmed = await this.awaitExecution((payload) => {
            const deal = payload.deal as { positionId?: number; closePositionDetail?: object } | undefined;
            return (
              !!deal?.closePositionDetail && Number(deal.positionId) === Number(pos.positionId)
            );
          });
          if (confirmed) {
            positions += 1;
          } else {
            this.log('error', `Close ${pos.positionId} not confirmed — retry Close all`);
          }
        } catch {
          // Best effort per position.
        }
      }
      for (const o of resting) {
        try {
          const pair = cancelOrder(accountId, o.orderId);
          liveEngine.execSend(pair.type, pair.payload);
          const confirmed = await this.awaitExecution((payload) => {
            const order = payload.order as { orderId?: number; orderStatus?: number | string } | undefined;
            return (
              Number(order?.orderId) === Number(o.orderId) &&
              (order?.orderStatus === 'ORDER_STATUS_CANCELLED' || order?.orderStatus === 5)
            );
          }, 8000);
          if (confirmed) {
            orders += 1;
          } else {
            this.log('error', `Cancel ${o.orderId} not confirmed — retry Close all`);
          }
        } catch {
          // Best effort per order.
        }
      }
      this.log('info', `Flattened ${positions}/${open.length} positions, cancelled ${orders}/${resting.length} limits`);
    } catch (err) {
      this.log('error', `Flatten incomplete: ${err instanceof Error ? err.message : 'connection failed'} — retry`);
      throw err;
    }
    await this.persist();
    this.emit();
    return { positions, orders };
  }

  /** Stop everything: flatten all, then mark stopped. */
  async stopAll(): Promise<{ positions: number; orders: number }> {
    await this.load();
    const p = this.persisted;
    let result = { positions: 0, orders: 0 };
    try {
      this.accountId();
      result = await this.flattenAll();
    } catch (err) {
      this.log('error', `Stop incomplete: ${err instanceof Error ? err.message : 'connection failed'} — retry Stop`);
    }
    if (this.spotUnsub) this.spotUnsub();
    if (this.execUnsub) this.execUnsub();
    if (this.orderErrUnsub) this.orderErrUnsub();
    this.spotUnsub = null;
    this.execUnsub = null;
    this.orderErrUnsub = null;
    this.persisted = { ...p, state: 'stopped', managedOrders: [], managedPositions: [], books: [] };
    this.stopReconcileLoop();
    await this.persist();
    this.emit();
    return result;
  }

  /** Legacy managed-only stop (kept for logout path). */
  async stop(): Promise<void> {
    await this.stopAll();
  }

  private async placeFullGrid(): Promise<void> {
    const p = this.persisted;
    if (!p.grid) return;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // Stagger placements ~250ms apart: 20 at once trips the server rate limit.
    for (const L of p.grid.lower) {
      await this.place('buy', L, L + STRATEGY_RULES.tpSteps * p.grid.step, L - STRATEGY_RULES.disasterSteps * p.grid.step);
      await sleep(250);
    }
    for (const U of p.grid.upper) {
      await this.place('sell', U, U - STRATEGY_RULES.tpSteps * p.grid.step, U + STRATEGY_RULES.disasterSteps * p.grid.step);
      await sleep(250);
    }
  }

  private labelFor(side: 'buy' | 'sell', level: number): string {
    return `${BOT_LABEL_PREFIX}-${side}-${Math.round(level * 100)}`;
  }

  private round(n: number): number {
    const f = Math.pow(10, this.persisted.digits);
    return Math.round(n * f) / f;
  }

  private async place(side: 'buy' | 'sell', level: number, _tp: number, sl: number): Promise<void> {
    const p = this.persisted;
    if (p.state !== 'running' || !p.grid) return;
    // Rule: nothing outside the strategy book.
    if (p.managedOrders.length >= STRATEGY_RULES.maxOrders) {
      this.log('error', `Order cap ${STRATEGY_RULES.maxOrders} hit — placement blocked`);
      return;
    }
    if (p.managedPositions.length >= STRATEGY_RULES.maxPositions) {
      this.log('error', `Position cap ${STRATEGY_RULES.maxPositions} hit — placement blocked`);
      return;
    }
    if (!(p.volumeLots > 0) || p.volumeLots > STRATEGY_RULES.maxLotsPerLevel) {
      this.log('error', 'Lot size outside strategy limits — placement blocked');
      return;
    }
    // DCA: first entries carry the disaster SL only — exits are basket-driven.
    const step = p.grid.step;
    const expectSl =
      side === 'buy' ? level - STRATEGY_RULES.disasterSteps * step : level + STRATEGY_RULES.disasterSteps * step;
    if (Math.abs(sl - expectSl) > step * 0.01) {
      this.log('error', 'Order shape outside strategy (SL mismatch) — placement blocked');
      return;
    }
    const lv = this.round(level);
    const pair = placeLimitOrder(this.accountId(), {
      symbolId: p.symbolId,
      side,
      volumeLots: p.volumeLots,
      limitPrice: lv,
      stopLoss: this.round(sl),
      label: this.labelFor(side, lv),
      unitsPerLot: unitsPerLot(p.symbol),
    });
    liveEngine.execSend(pair.type, pair.payload);
    this.log('info', `Limit ${side.toUpperCase()} ${p.volumeLots.toFixed(2)} @ ${level.toFixed(2)} SL ${sl.toFixed(2)}`);
  }

  /** DCA add: market order at the touch (sim fills adds on cross). Capped. */
  private async placeAdd(side: 'buy' | 'sell', anchor: number): Promise<void> {
    const p = this.persisted;
    if (p.state !== 'running') return;
    if (p.managedOrders.length >= STRATEGY_RULES.maxOrders) return;
    if (p.managedPositions.length >= STRATEGY_RULES.maxPositions) {
      this.log('error', `Position cap ${STRATEGY_RULES.maxPositions} hit — add blocked`);
      return;
    }
    const book = p.books.find((b) => b.side === side && Math.abs(b.anchor - anchor) < (p.grid?.step ?? 0) * 0.49);
    if (!book || book.legIds.length - 1 >= STRATEGY_RULES.maxAdds) return;
    const pair = placeMarketOrder(this.accountId(), {
      symbolId: p.symbolId,
      side,
      volumeLots: p.volumeLots,
      label: this.labelForAdd(side, anchor),
      unitsPerLot: unitsPerLot(p.symbol),
    });
    liveEngine.execSend(pair.type, pair.payload);
    this.log('info', `DCA add ${side.toUpperCase()} leg ${book.legIds.length + 1} @ anchor ${anchor.toFixed(2)}`);
  }

  private labelForAdd(side: 'buy' | 'sell', anchor: number): string {
    return `${BOT_LABEL_PREFIX}-add-${side}-${Math.round(anchor * 100)}`;
  }

  /** Parse our labels → { kind, side, anchor }. Null when foreign. */
  private parseLabel(label: string): { kind: 'open' | 'add'; side: 'buy' | 'sell'; anchor: number } | null {
    const parts = label.split('-');
    // null-grid-{buy|sell}-{anchor} | null-grid-add-{buy|sell}-{anchor}
    if (parts.length < 4 || parts[0] !== 'null' || parts[1] !== 'grid') return null;
    if (parts[2] === 'add' && parts.length >= 5 && (parts[3] === 'buy' || parts[3] === 'sell')) {
      const anchor = Number(parts[4]) / 100;
      if (!Number.isFinite(anchor)) return null;
      return { kind: 'add', side: parts[3], anchor };
    }
    if ((parts[2] === 'buy' || parts[2] === 'sell') && parts.length >= 4) {
      const anchor = Number(parts[3]) / 100;
      if (!Number.isFinite(anchor)) return null;
      return { kind: 'open', side: parts[2], anchor };
    }
    return null;
  }

  /** Drop legs that no longer exist; drop books left with none. */
  private pruneBooks(): void {
    const alive = new Set(this.persisted.managedPositions.map((m) => m.id));
    for (const book of this.persisted.books) {
      book.legIds = book.legIds.filter((id) => alive.has(id));
    }
    this.persisted.books = this.persisted.books.filter((b) => b.legIds.length > 0);
  }

  /** Close every leg of one book at market (basket win or disaster). */
  private async closeBook(side: 'buy' | 'sell', anchor: number, reason: 'basket' | 'disaster'): Promise<void> {
    const p = this.persisted;
    const tol = (p.grid?.step ?? 0) * 0.49;
    const book = p.books.find((b) => b.side === side && Math.abs(b.anchor - anchor) < tol);
    if (!book || book.legIds.length === 0) {
      this.pruneBooks();
      await this.persist();
      return;
    }
    try {
      const accountId = this.accountId();
      const res = await liveEngine.execRequest(Payload.ReconcileReq, { ctidTraderAccountId: accountId });
      const vols = new Map<number, number>();
      ((res.position ?? []) as { positionId: number; tradeData: { volume: number } }[]).forEach((pos) =>
        vols.set(Number(pos.positionId), pos.tradeData.volume),
      );
      for (const id of [...book.legIds]) {
        const raw = vols.get(id);
        if (raw === undefined) continue;
        const pair = closePosition(accountId, id, 0, 100000, raw);
        liveEngine.execSend(pair.type, pair.payload);
      }
      this.log(
        reason === 'basket' ? 'close' : 'escape',
        `${reason === 'basket' ? 'Basket' : 'Disaster'} ${side.toUpperCase()} x${book.legIds.length} @ ${anchor.toFixed(2)} — closing`,
      );
    } catch (err) {
      this.log('error', `Book close failed: ${err instanceof Error ? err.message : 'connection failed'} — retry`);
    }
  }

  private async cancelManagedOrders(): Promise<void> {
    const p = this.persisted;
    for (const order of p.managedOrders) {
      try {
        const pair = cancelOrder(this.accountId(), order.id);
        liveEngine.execSend(pair.type, pair.payload);
      } catch {
        // Best effort per order.
      }
    }
  }

  /** Escape: close everything managed, drop limits, re-anchor at market. */
  private async escape(price: number): Promise<void> {
    const p = this.persisted;
    // Cooldown: never escape twice within 60s (protects against bad data storms).
    if (Date.now() - this.lastEscapeAt < 60000) return;
    this.lastEscapeAt = Date.now();
    // Circuit breaker: too many escapes in a rolling hour = wrong regime — halt.
    const recent = [...(p.escapeTimes ?? []), Date.now()].filter((t) => Date.now() - t < 3600000);
    if (recent.length > STRATEGY_RULES.maxEscapesPerHour) {
      this.log('error', `Circuit breaker: ${recent.length} escapes/hour — stopping, restart manually when calm`);
      await this.stopAll();
      return;
    }
    this.persisted = { ...p, escapeTimes: recent };
    this.log('escape', `Price left the grid at ${price.toFixed(2)} — flattening and re-anchoring`);
    try {
      const res = await liveEngine.execRequest(Payload.ReconcileReq, {
        ctidTraderAccountId: this.accountId(),
      });
      const open = ((res.position ?? []) as {
        positionId: number;
        tradeData: { volume: number };
      }[]).filter((pos) => p.managedPositions.some((m) => m.id === Number(pos.positionId)));
      for (const pos of open) {
        try {
          // Echo exact protocol volume — no unit math (same as flattenAll).
          const pair = closePosition(this.accountId(), pos.positionId, 0, 100000, pos.tradeData.volume);
          liveEngine.execSend(pair.type, pair.payload);
        } catch {
          // Best effort per position.
        }
      }
    } catch {
      // Best effort — limits below still get cancelled.
    }
    await this.cancelManagedOrders();
    const bars = await this.fetchBars(p.symbolId);
    const lastBar = bars[bars.length - 1];
    // Widen until the grid covers one M30 bar (max mult 3.0), else keep old grid.
    let grid = buildGrid(bars, STRATEGY_RULES.atrLen, STRATEGY_RULES.gridMult, STRATEGY_RULES.levels);
    for (const mult of [2.2, 2.6, 3.0]) {
      if (lastBar.high - lastBar.low <= grid.step * STRATEGY_RULES.levels) break;
      grid = buildGrid(bars, STRATEGY_RULES.atrLen, mult, STRATEGY_RULES.levels);
    }
    if (lastBar.high - lastBar.low > grid.step * STRATEGY_RULES.levels) {
      this.log('error', 'Volatility too high — keeping old grid instead of churning');
      return;
    }
    this.persisted = {
      ...this.persisted,
      grid,
      atr: grid.step / STRATEGY_RULES.gridMult,
      managedOrders: [],
      managedPositions: [],
      books: [],
    };
    this.barDir = isUpBar(lastBar) ? 'up' : 'down';
    this.lastBarTime = lastBar.time;
    await this.persist();
    await this.placeFullGrid();
    this.log('escape', `Re-anchored @ ${grid.base.toFixed(2)}, step ${grid.step.toFixed(2)}`);
  }

  /** One reconcile pass: returns true when it did meaningful work. */
  async reconcile(): Promise<boolean> {
    const p = this.persisted;
    if (p.state !== 'running' || !p.grid) return false;
    if (!liveEngine.connected) return false;
    // Back off after repeated failures (e.g. rate limiting): pause 2 minutes.
    if (Date.now() < this.coolUntil) return false;
    let accountId: number;
    try {
      accountId = this.accountId();
    } catch {
      return false;
    }

    try {
      const res = await liveEngine.execRequest(Payload.ReconcileReq, {
        ctidTraderAccountId: accountId,
      });
      // Rule: max drawdown from start equity — halt before deeper damage.
      const startEq = this.persisted.startEquity;
      const liveEq = liveEngine.accountState().equity;
      if (startEq && startEq > 0 && liveEq < startEq * (1 - STRATEGY_RULES.maxDrawdownPct / 100)) {
        this.log(
          'error',
          `Drawdown cap ${STRATEGY_RULES.maxDrawdownPct}% hit — stopping, restart manually when calm`,
        );
        await this.stopAll();
        return true;
      }
    const positions = ((res.position ?? []) as {
      positionId: number;
      tradeData: { label?: string; tradeSide: number | string; volume: number };
      positionStatus?: string;
    }[]).filter((pos) => pos.positionStatus === 'POSITION_STATUS_OPEN' || pos.positionStatus === undefined);
    const orders = ((res.order ?? []) as {
      orderId: number;
      tradeData: { label?: string; tradeSide: number | string };
      orderStatus?: string;
      limitPrice?: number;
    }[]).filter((o) => o.orderStatus === 'ORDER_STATUS_ACCEPTED' || o.orderStatus === undefined);

    const mine = (label?: string) => typeof label === 'string' && label.startsWith(BOT_LABEL_PREFIX);
    const sideOf = (v: number | string) => (v === 2 || v === 'SELL' ? 'sell' : 'buy') as 'buy' | 'sell';
    const myPositionIds = new Set(p.managedPositions.map((m) => m.id));
    const myPositions = positions.filter((pos) => myPositionIds.has(Number(pos.positionId)));
    const myOrders = orders.filter((o) => mine(o.tradeData.label));

    // Track resting limits so the UI + stale-cancel logic see reality.
    const tracked = myOrders.map((o) => ({
      id: String(o.orderId),
      side: sideOf(o.tradeData.tradeSide),
      price: o.limitPrice ?? 0,
    }));
    if (JSON.stringify(tracked) !== JSON.stringify(p.managedOrders)) {
      p.managedOrders = tracked;
      await this.persist();
    }

    // Drop tracking for anything that vanished (TP hit / manual close).
    const openIds = new Set(positions.map((pos) => Number(pos.positionId)));
    const kept = p.managedPositions.filter((m) => openIds.has(m.id));
    if (kept.length !== p.managedPositions.length) {
      p.managedPositions = kept;
      this.pruneBooks();
      await this.persist();
    }

    const price = this.lastPrice;
    if (price === null) return false;
    const intents = planTick({
      grid: p.grid,
      price,
      prevPrice: null,
      barDir: this.barDir,
      positions: myPositions.map((pos) => ({
        id: String(pos.positionId),
        side: sideOf(pos.tradeData.tradeSide),
        entry: p.managedPositions.find((m) => m.id === Number(pos.positionId))?.entry ?? 0,
      })),
      orders: myOrders.map((o) => ({
        id: String(o.orderId),
        side: sideOf(o.tradeData.tradeSide),
        price: o.limitPrice ?? 0,
      })),
      volumeLots: p.volumeLots,
    });

    let acted = false;
    for (const intent of intents) {
      if (intent.type === 'escape') {
        await this.escape(price);
        return true;
      }
      if (intent.type === 'place') {
        await this.place(intent.side, intent.level, intent.tp, intent.sl);
        acted = true;
      }
    }

    // Cancel stale limits: ours but not near any same-side level.
    const tol = 0.49 * p.grid.step;
    const near = (side: 'buy' | 'sell', price: number) => {
      const levels = side === 'buy' ? p.grid!.lower : p.grid!.upper;
      return levels.some((L) => Math.abs(L - price) < tol);
    };
    for (const o of myOrders) {
      const side = o.tradeData.tradeSide === 2 || o.tradeData.tradeSide === 'SELL' ? 'sell' : 'buy';
      if (!near(side, o.limitPrice ?? 0)) {
        try {
          const pair = cancelOrder(accountId, o.orderId);
          liveEngine.execSend(pair.type, pair.payload);
          acted = true;
        } catch {
          // Best effort.
        }
      }
    }
    if (acted) await this.persist();
    this.failures = 0;
    return acted;
    } catch {
      this.failures += 1;
      if (this.failures >= 3) {
        this.coolUntil = Date.now() + 120000;
        this.failures = 0;
        this.log('error', 'Wait a moment — resting, then resuming on its own');
      }
      return false;
    }
  }

  /** Spot-tick entry point (foreground). */
  async onSpot(price: number): Promise<void> {
    try {
      const p = this.persisted;
      if (p.state !== 'running' || !p.grid || !Number.isFinite(price)) return;
      const prev = this.lastPrice;
      this.lastPrice = price;
      // Tick-fast path: price widgets render every tick, zero status work.
      this.tickListeners.forEach((listener) => listener());
      if (prev === null) return; // need two ticks to detect a touch — no burst on subscribe
      // Throttled UI heartbeat so the screen visibly ticks with the market.
      if (Date.now() - this.lastUiEmit > 1000) {
        this.lastUiEmit = Date.now();
        this.emit();
      }
      const intents = planTick({
      grid: p.grid,
      price,
      prevPrice: prev,
      barDir: this.barDir,
      positions: p.managedPositions.map((m) => ({ id: String(m.id), side: m.side, entry: m.entry })),
      orders: p.managedOrders.map((m) => ({ id: String(m.id), side: m.side, price: m.price })),
      volumeLots: p.volumeLots,
    });
    for (const intent of intents) {
      if (intent.type === 'escape') {
        await this.escape(price);
        return;
      }
      if (intent.type === 'place') {
        await this.place(intent.side, intent.level, intent.tp, intent.sl);
      }
    }
    await this.runDca(price, prev);
    } catch (err) {
      this.log('error', err instanceof Error ? err.message : 'Tick failed');
    }
  }

  /** DCA pass per spot tick: basket exits, disaster stops, adds. */
  private async runDca(price: number, prevPrice: number | null): Promise<void> {
    const p = this.persisted;
    if (p.state !== 'running' || !p.grid) return;
    const step = p.grid.step;
    for (const book of [...p.books]) {
      const legs = p.managedPositions.filter((m) => book.legIds.includes(m.id) && Number.isFinite(m.entry));
      if (legs.length === 0) continue;
      const avg = legs.reduce((s, m) => s + m.entry, 0) / legs.length;
      const target = dcaTarget(avg, book.side, step, STRATEGY_RULES.basketSteps);
      const stop =
        book.side === 'buy'
          ? book.anchor - STRATEGY_RULES.disasterSteps * step
          : book.anchor + STRATEGY_RULES.disasterSteps * step;
      if (book.side === 'buy' ? price >= target : price <= target) {
        await this.closeBook(book.side, book.anchor, 'basket');
      } else if (book.side === 'buy' ? price <= stop : price >= stop) {
        await this.closeBook(book.side, book.anchor, 'disaster');
      } else if (legs.length - 1 < STRATEGY_RULES.maxAdds) {
        const next = dcaNextAdd(avg, book.side, step);
        if (crossedLevel(book.side, next, prevPrice, price)) {
          await this.placeAdd(book.side, book.anchor);
        }
      }
    }
  }

  /** ExecutionEvent entry point (foreground): track fills/closes, log them. */
  onExecution(payload: Record<string, unknown>): void {
    if (this.persisted.state !== 'running') return;
    const order = payload.order as
      | { orderId?: number; orderStatus?: string; tradeData?: { label?: string; tradeSide?: number | string } }
      | undefined;
    const deal = payload.deal as
      | { positionId?: number; executionPrice?: number; closePositionDetail?: { grossProfit?: number } }
      | undefined;
    const position = payload.position as { positionId?: number } | undefined;
    const label = order?.tradeData?.label;
    const mine =
      (typeof label === 'string' && label.startsWith(BOT_LABEL_PREFIX)) ||
      (order?.orderId !== undefined &&
        this.persisted.managedOrders.some((o) => o.id === String(order.orderId)));

    if (
      order &&
      (isRejectedStatus(order.orderStatus) || isCancelRejectedStatus(order.orderStatus))
    ) {
      const code = (payload.errorCode as string | undefined) ?? order.orderStatus;
      this.log('error', `Order ${String(order.orderId ?? '?')} rejected: ${code}`);
      void this.persist();
      this.emit();
    }

    if (order && mine && isFilledStatus(order.orderStatus) && order.orderId !== undefined) {
      this.log('fill', `Filled ${String(order.orderId)} (${label})`);
      const pid = position?.positionId ?? deal?.positionId;
      const side = order.tradeData?.tradeSide === 2 || order.tradeData?.tradeSide === 'SELL' ? 'sell' : 'buy';
      if (pid !== undefined && !this.persisted.managedPositions.some((m) => m.id === Number(pid))) {
        this.persisted.managedPositions.push({
          id: Number(pid),
          side,
          entry: deal?.executionPrice ?? 0,
        });
        // File the leg into its DCA book (anchor from our label).
        const parsed = typeof label === 'string' ? this.parseLabel(label) : null;
        const anchor = parsed?.anchor ?? deal?.executionPrice ?? 0;
        const tol = (this.persisted.grid?.step ?? 0) * 0.49;
        let book = this.persisted.books.find((b) => b.side === side && Math.abs(b.anchor - anchor) < tol);
        if (!book) {
          if (this.persisted.books.filter((b) => b.side === side).length >= STRATEGY_RULES.maxBooksPerSide) {
            this.log('error', 'Book cap hit — leg untracked, close it manually if needed');
          } else {
            book = { side, anchor, legIds: [] };
            this.persisted.books.push(book);
          }
        }
        book?.legIds.push(Number(pid));
      }
      this.pruneBooks();
      void this.persist();
      this.emit();
    }
    if (deal?.closePositionDetail && deal.positionId !== undefined) {
      const id = Number(deal.positionId);
      if (this.persisted.managedPositions.some((m) => m.id === id)) {
        this.persisted.managedPositions = this.persisted.managedPositions.filter((m) => m.id !== id);
        this.pruneBooks();
        const net = Number(deal.closePositionDetail.grossProfit ?? 0) / 100;
        this.log('close', `Position ${id} closed ${net >= 0 ? '+' : ''}$${net.toFixed(2)}`);
        void this.persist();
        this.emit();
      }
    }
    // Any execution may change the book — reconcile shortly after.
    void this.reconcile();
  }

  /** Refresh bar direction from the latest closed M30 bar. */
  async refreshBar(): Promise<void> {
    const p = this.persisted;
    if (p.state !== 'running') return;
    try {
      const bars = await this.fetchBars(p.symbolId, 4);
      const last = bars[bars.length - 1];
      if (last.time > this.lastBarTime) {
        this.lastBarTime = last.time;
        this.barDir = isUpBar(last) ? 'up' : 'down';
      }
    } catch {
      // Next cycle retries.
    }
  }

  private startReconcileLoop(): void {
    this.stopReconcileLoop();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
      void this.refreshBar();
    }, 30000);
  }

  private stopReconcileLoop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /** Single background-tick: connect, reconcile once, disconnect. */
  async backgroundTick(): Promise<boolean> {
    await this.load();
    if (this.persisted.state !== 'running') return true;
    try {
      const session = await loadSession();
      if (!session) return false;
      const client = new CTraderClient();
      const budget = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Background budget exceeded')), 25000);
      });
      const work = (async () => {
        const { accountId } = await LiveEngine.prepareConnection(client, session);
        const res = await client.request(Payload.ReconcileReq, { ctidTraderAccountId: accountId });
        const open = ((res.position ?? []) as { positionId: number }[]).length;
        this.log('info', `Background check: ${open} open, book OK`);
        client.close();
      })();
      await Promise.race([work, budget]);
      return true;
    } catch {
      return false;
    }
  }
}

export const botRunner = new BotRunner();

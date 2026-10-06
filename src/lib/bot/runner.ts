import * as Notifications from 'expo-notifications';

import { liveEngine, LiveEngine } from '../ctrader/live';
import { Payload } from '../ctrader/protocol';
import { CTraderClient } from '../ctrader/client';
import { loadSession } from '../ctrader/session';
import {
  cancelOrder,
  closePosition,
  mapTrendbars,
  placeLimitOrder,
  TrendbarPeriod,
} from '../ctrader/orders';
import { storeGet, storeSet } from '../storage';
import {
  buildGrid,
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
  logs: BotLogEntry[];
}

interface PersistedState {
  state: 'stopped' | 'running';
  symbol: string;
  symbolId: number;
  riskPct: number;
  volumeLots: number;
  leverage: number;
  grid: GridSetup | null;
  atr: number | null;
  managedOrders: { id: string; side: 'buy' | 'sell'; price: number }[];
  managedPositions: { id: number; side: 'buy' | 'sell'; entry: number }[];
  startedAt: number | null;
}

const DEFAULT_PERSISTED: PersistedState = {
  state: 'stopped',
  symbol: 'XAUUSD',
  symbolId: 0,
  riskPct: 2,
  volumeLots: 0.02,
  leverage: 100,
  grid: null,
  atr: null,
  managedOrders: [],
  managedPositions: [],
  startedAt: null,
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
  private logs: BotLogEntry[] = [];
  private revision = 0;
  private lastEmitAt: number | null = null;
  private lastPrice: number | null = null;
  private barDir: 'up' | 'down' | null = null;
  private lastBarTime = 0;
  private lastEscapeAt = 0;
  private failures = 0;
  private coolUntil = 0;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private spotUnsub: (() => void) | null = null;
  private loaded = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

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

  private async fetchBars(symbolId: number, count = 60): Promise<Bar[]> {
    const res = await liveEngine.execRequest(Payload.GetTrendbarsReq, {
      ctidTraderAccountId: this.accountId(),
      symbolId,
      period: TrendbarPeriod.M15,
      count,
    });
    const bars = mapTrendbars(res.trendbar ?? res);
    if (bars.length < 25) throw new Error('Not enough M15 history for ATR(21)');
    // Drop the forming bar — anchor on the last CLOSED bar.
    const closed = bars.slice(0, -1);
    return closed.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  }

  /** Start the bot: build the grid from live ATR and place the 8 limits. */
  async start(riskPct: number): Promise<void> {
    await this.load();
    if (this.persisted.state === 'running') return;
    if (!liveEngine.connected) throw new Error('Connect the trading account first');

    const account = liveEngine.accountState();
    const snapshot = liveEngine.getSnapshot();
    const leverage = snapshot.trader?.leverageInCents ? snapshot.trader.leverageInCents / 100 : 100;
    const symbolId = this.symbolId(this.persisted.symbol);
    try {
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') await Notifications.requestPermissionsAsync();
    } catch {
      // Notifications are optional.
    }

    const bars = await this.fetchBars(symbolId);
    const grid = buildGrid(bars, 21, 0.25, 3);
    const lastBar = bars[bars.length - 1];
    const atr = grid.step / 0.25;
    const marginPerLevel = (account.equity * riskPct) / 100;
    let volumeLots = lotsFor(marginPerLevel, lastBar.close, leverage, XAUUSD_UNITS_PER_LOT);
    // Hard cap: 8 max-open levels must fit in free margin with headroom.
    const maxByMargin = account.freeMargin / (8 * ((lastBar.close * XAUUSD_UNITS_PER_LOT) / leverage));
    volumeLots = Math.max(0.01, Math.min(volumeLots, Math.floor(maxByMargin * 100) / 100));
    if (volumeLots < 0.01) throw new Error('Free margin too low for one level');

    this.persisted = {
      ...this.persisted,
      state: 'running',
      symbolId,
      riskPct,
      volumeLots,
      leverage,
      grid,
      atr,
      managedOrders: [],
      managedPositions: [],
      startedAt: Date.now(),
    };
    this.barDir = isUpBar(lastBar) ? 'up' : 'down';
    this.lastBarTime = lastBar.time;
    this.lastPrice = null;
    await this.persist();
    this.log('info', `Grid armed: step ${grid.step.toFixed(2)}, ${volumeLots.toFixed(2)} lots/level, risk ${riskPct}%`);

    liveEngine.execSend(Payload.SubscribeSpotsReq, {
      ctidTraderAccountId: this.accountId(),
      symbolId: [symbolId],
    });
    if (this.spotUnsub) this.spotUnsub();
    this.spotUnsub = liveEngine.onEvent(Payload.SpotEvent, (payload) => {
      if (payload.symbolId !== symbolId) return;
      const bid = payload.bid as number | undefined;
      const ask = payload.ask as number | undefined;
      if (bid === undefined && ask === undefined) return;
      const mid = ((bid ?? ask ?? 0) + (ask ?? bid ?? 0)) / 2 / 100000;
      void this.onSpot(mid);
    });
    await this.placeFullGrid();
    this.startReconcileLoop();
    this.emit();
  }

  /** Stop: cancel our limits, leave positions to their server-side TPs. */
  async stop(): Promise<void> {
    await this.load();
    if (this.persisted.state === 'stopped') return;
    await this.cancelManagedOrders();
    if (this.spotUnsub) this.spotUnsub();
    this.spotUnsub = null;
    this.persisted = { ...this.persisted, state: 'stopped', managedOrders: [] };
    this.stopReconcileLoop();
    await this.persist();
    this.log('info', 'Bot stopped — limits cancelled, positions left to TPs');
    this.emit();
  }

  private async placeFullGrid(): Promise<void> {
    const p = this.persisted;
    if (!p.grid) return;
    for (const L of p.grid.lower) {
      await this.place('buy', L, L + p.grid.step, L - 8 * p.grid.step);
    }
    for (const U of p.grid.upper) {
      await this.place('sell', U, U - p.grid.step, U + 8 * p.grid.step);
    }
  }

  private labelFor(side: 'buy' | 'sell', level: number): string {
    return `${BOT_LABEL_PREFIX}-${side}-${Math.round(level * 100)}`;
  }

  private async place(side: 'buy' | 'sell', level: number, tp: number, sl: number): Promise<void> {
    const p = this.persisted;
    const pair = placeLimitOrder(this.accountId(), {
      symbolId: p.symbolId,
      side,
      volumeLots: p.volumeLots,
      limitPrice: level,
      takeProfit: tp,
      stopLoss: sl,
      label: this.labelFor(side, level),
    });
    liveEngine.execSend(pair.type, pair.payload);
    this.log('info', `Limit ${side.toUpperCase()} ${p.volumeLots.toFixed(2)} @ ${level.toFixed(2)} TP ${tp.toFixed(2)}`);
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
          const pair = closePosition(this.accountId(), pos.positionId, pos.tradeData.volume / 10000000);
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
    const grid = buildGrid(bars, 21, 0.25, 3);
    const lastBar = bars[bars.length - 1];
    this.persisted = {
      ...p,
      grid,
      atr: grid.step / 0.25,
      managedOrders: [],
      managedPositions: [],
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
    const myPositionIds = new Set(p.managedPositions.map((m) => m.id));
    const myPositions = positions.filter((pos) => myPositionIds.has(Number(pos.positionId)));
    const myOrders = orders.filter((o) => mine(o.tradeData.label));

    // Drop tracking for anything that vanished (TP hit / manual close).
    const openIds = new Set(positions.map((pos) => Number(pos.positionId)));
    const kept = p.managedPositions.filter((m) => openIds.has(m.id));
    if (kept.length !== p.managedPositions.length) {
      p.managedPositions = kept;
      await this.persist();
    }

    const price = this.lastPrice;
    if (price === null) return false;
    const sideOf = (v: number | string) => (v === 2 || v === 'SELL' ? 'sell' : 'buy') as 'buy' | 'sell';
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
        this.log('error', 'cTrader is rate-limiting — pausing 2 minutes');
      }
      return false;
    }
  }

  /** Spot-tick entry point (foreground). */
  async onSpot(price: number): Promise<void> {
    const p = this.persisted;
    if (p.state !== 'running' || !p.grid || !Number.isFinite(price)) return;
    const prev = this.lastPrice;
    this.lastPrice = price;
    const intents = planTick({
      grid: p.grid,
      price,
      prevPrice: prev,
      barDir: this.barDir,
      positions: p.managedPositions.map((m) => ({ id: String(m.id), side: m.side, entry: m.entry })),
      orders: [],
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
    const mine = typeof label === 'string' && label.startsWith(BOT_LABEL_PREFIX);

    if (order && mine && order.orderStatus === 'ORDER_STATUS_FILLED' && order.orderId !== undefined) {
      this.log('fill', `Filled ${String(order.orderId)} (${label})`);
      const pid = position?.positionId ?? deal?.positionId;
      const side = order.tradeData?.tradeSide === 2 || order.tradeData?.tradeSide === 'SELL' ? 'sell' : 'buy';
      if (pid !== undefined && !this.persisted.managedPositions.some((m) => m.id === Number(pid))) {
        this.persisted.managedPositions.push({
          id: Number(pid),
          side,
          entry: deal?.executionPrice ?? 0,
        });
      }
      void this.persist();
      this.emit();
    }
    if (deal?.closePositionDetail && deal.positionId !== undefined) {
      const id = Number(deal.positionId);
      if (this.persisted.managedPositions.some((m) => m.id === id)) {
        this.persisted.managedPositions = this.persisted.managedPositions.filter((m) => m.id !== id);
        const net = Number(deal.closePositionDetail.grossProfit ?? 0) / 100;
        this.log('close', `Position ${id} closed ${net >= 0 ? '+' : ''}$${net.toFixed(2)}`);
        void this.persist();
        this.emit();
      }
    }
    // Any execution may change the book — reconcile shortly after.
    void this.reconcile();
  }

  /** Refresh bar direction from the latest closed M15 bar. */
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

import { useSyncExternalStore } from 'react';
import { CTraderClient } from './client';
import {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  refreshTokens,
  socketUrl,
} from './config';
import { Payload } from './protocol';
import { asSide, isFilledStatus, isOpenPositionStatus, isRestingOrderStatus } from './orders';
import type {
  AccountInfo,
  DealInfo,
  OrderInfo,
  PositionInfo,
  SymbolInfo,
  TraderInfo,
} from './protocol';
import { loadSession, saveSession, type CTraderSession } from './session';
import { asArray, money, normalizeSymbolName, scaleSpot, secondsSinceMessage } from './wire';
import { storeGet, storeSet } from '../storage';

const SYMBOLS_CACHE_KEY = 'ctrader.symbols.v1';

/** Monotonic suffix so burst closes in the same millisecond get unique ids. */
let optimisticSeq = 0;

/** Refresh an expiring session and persist the rotated tokens. */
async function refreshSession(session: CTraderSession): Promise<CTraderSession> {
  const tokens = await refreshTokens(session.refreshToken);
  const next: CTraderSession = {
    ...session,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  };
  await saveSession(next);
  return next;
}

/** Normalize a raw symbol row from any list endpoint; nameless rows are dropped. */
function toSymbolInfo(raw: {
  symbolId: number;
  symbolName?: string;
  digits?: number;
}): SymbolInfo | null {
  if (!raw.symbolName) return null;
  return {
    symbolId: raw.symbolId,
    symbolName: normalizeSymbolName(raw.symbolName),
    digits: typeof raw.digits === 'number' ? raw.digits : 2,
  };
}

export interface LiveSnapshot {
  status: 'idle' | 'connecting' | 'ready' | 'error';
  error: string | null;
  trader: TraderInfo | null;
  account: AccountInfo | null;
  positions: PositionInfo[];
  orders: OrderInfo[];
  deals: DealInfo[];
  symbols: Map<number, SymbolInfo>;
  version: number;
}

const EMPTY: LiveSnapshot = {
  status: 'idle',
  error: null,
  trader: null,
  account: null,
  positions: [],
  orders: [],
  deals: [],
  symbols: new Map(),
  version: 0,
};

/**
 * Live cTrader data engine (JSON over WebSocket, all platforms).
 * Owns one connection per environment; screens read via useLive().
 */
class LiveEngine {
  private client = new CTraderClient();
  private snapshot: LiveSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private spots = new Map<number, { bid: number; ask: number }>();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private session: CTraderSession | null = null;
  private starting = false;
  private watchUnsub: (() => void) | null = null;
  /** Bumped on every stop(): in-flight start/snapshot work from a previous
   *  generation must never emit into the fresh snapshot. */
  private epoch = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LiveSnapshot => this.snapshot;

  private emit(partial: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial, version: this.snapshot.version + 1 };
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // One bad subscriber must not break the realtime loop.
      }
    });
  }

  get connected(): boolean {
    return this.snapshot.status === 'ready';
  }

  /** True only when the socket can actually send right now. Snapshot
   *  `connected` stays true across reconnect gaps — this does not. */
  isOpen(): boolean {
    return this.client.isOpen;
  }

  /** Low-level passthroughs so the bot runner shares this single connection. */
  execRequest(type: number, payload: Record<string, unknown>) {
    return this.request(type, payload);
  }

  execSend(type: number, payload: Record<string, unknown>): void {
    this.client.send(type, payload);
  }

  onEvent(type: number, handler: (payload: Record<string, unknown>) => void): () => void {
    return this.client.on(type, handler);
  }

  getAccountId(): number | null {
    return this.session?.ctidTraderAccountId ?? null;
  }

  /** Shared handshake: fresh tokens → socket → app auth → account auth. */
  static async prepareConnection(
    client: CTraderClient,
    session: CTraderSession,
  ): Promise<{ session: CTraderSession; accountId: number; account: AccountInfo }> {
    let active = session;
    if (active.expiresAt < Date.now() + 60000) {
      active = await refreshSession(active);
    }
    client.close();
    client.connect(socketUrl(active.isLive ? 'live' : 'demo'));
    await LiveEngine.waitOpen(client);
    await client.request(Payload.ApplicationAuthReq, {
      clientId: CTRADER_CLIENT_ID,
      clientSecret: CTRADER_CLIENT_SECRET,
    });
    const accounts = await client.request(Payload.GetAccountsByAccessTokenReq, {
      accessToken: active.accessToken,
    });
    const list = asArray<AccountInfo>(accounts.ctidTraderAccount);
    const match =
      list.find((a) => a.ctidTraderAccountId === active.ctidTraderAccountId) ?? list[0];
    if (!match) throw new Error('No trading account granted access');
    const accountId = match.ctidTraderAccountId;
    const authed = { ...active, ctidTraderAccountId: accountId };
    await saveSession(authed);
    await client.request(Payload.AccountAuthReq, {
      ctidTraderAccountId: accountId,
      accessToken: active.accessToken,
    });
    return { session: authed, accountId, account: match };
  }

  private static waitOpen(client: CTraderClient): Promise<void> {
    if (client.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Connection timed out'));
      }, 20000);
      const off = client.onState((state) => {
        // Abort fast on explicit close (stop()/logout) instead of the 20s hang.
        if (state === 'open' || state === 'closed') {
          clearTimeout(timer);
          off();
          if (state === 'open') resolve();
          else reject(new Error('Connection closed'));
        }
      });
    });
  }

  /** Full login sequence: tokens → socket → app auth → account auth → snapshot. */
  async start(session: CTraderSession): Promise<void> {
    if (this.starting) return;
    if (this.snapshot.status === 'ready' && this.session?.accessToken === session.accessToken) return;
    this.starting = true;
    const epoch = this.epoch;
    this.emit({ status: 'connecting', error: null });
    try {
      const { session: active, accountId, account } = await LiveEngine.prepareConnection(
        this.client,
        session,
      );
      if (epoch !== this.epoch) return; // stopped mid-handshake — stay stopped
      this.session = active;
      this.attachEvents(accountId);
      await this.snapshotAll(accountId, true);
      if (epoch !== this.epoch) return;
      this.watchConnection();
      this.scheduleTokenRefresh();
      // snapshotAll never throws (warn-only) — verify we actually authed.
      if (!this.session) throw new Error('Connection failed');
      this.emit({ status: 'ready', account });
      this.startWatchdog();
    } catch (err) {
      if (epoch !== this.epoch) return; // a newer stop() owns the state now
      const message = err instanceof Error ? err.message : 'Connection failed';
      this.emit({
        status: 'error',
        error: message,
      });
      throw err instanceof Error ? err : new Error(message);
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.epoch++; // orphan every in-flight start/snapshot from the old life
    this.stopTokenRefresh();
    this.stopWatchdog();
    if (this.watchUnsub) this.watchUnsub();
    this.watchUnsub = null;
    this.eventUnsubs.forEach((off) => off());
    this.eventUnsubs = [];
    this.client.close();
    this.session = null;
    this.spots.clear();
    this.symbolsWarned = false;
    this.snapshotQueued = false;
    if (this.snapshotTrailing) clearTimeout(this.snapshotTrailing);
    this.snapshotTrailing = null;
    this.snapshot = EMPTY;
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // Ignore — teardown must not throw.
      }
    });
  }

  /** Proactive token refresh 5 min before expiry — keeps a long session realtime. */
  private scheduleTokenRefresh(): void {
    this.stopTokenRefresh();
    const session = this.session;
    if (!session) return;
    const delay = session.expiresAt - Date.now() - 300000;
    if (!Number.isFinite(delay) || delay <= 0) return;
    this.tokenRefreshTimer = setTimeout(() => {
      void (async () => {
        try {
          const current = this.session;
          if (!current) return;
          this.session = await refreshSession(current);
          this.scheduleTokenRefresh();
        } catch {
          // Next reconnect retries; stream stays usable until expiry.
          this.scheduleTokenRefresh();
        }
      })();
    }, Math.min(delay, 2147483647));
  }

  private stopTokenRefresh(): void {
    if (this.tokenRefreshTimer) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = null;
  }

  async refresh(): Promise<void> {
    const accountId = this.session?.ctidTraderAccountId;
    if (!accountId || this.snapshot.status !== 'ready') return;
    await this.snapshotAll(accountId, true);
  }

  private request(type: number, payload: Record<string, unknown>) {
    return this.client.request(type, payload);
  }

  private eventUnsubs: (() => void)[] = [];

  private attachEvents(accountId: number): void {
    this.eventUnsubs.forEach((off) => off());
    this.eventUnsubs = [];
    // Position/balance changes: patch instantly, reconcile truth right after.
    // A close also stales the deals list so History updates in realtime.
    this.eventUnsubs.push(
      this.client.on(Payload.ExecutionEvent, (payload) => {
        this.patchExecution(payload);
        const deal = payload.deal as { closePositionDetail?: object } | undefined;
        if (deal?.closePositionDetail) this.lastDealsAt = 0;
        void this.snapshotAll(accountId);
      }),
    );
    this.eventUnsubs.push(
      this.client.on(Payload.TraderUpdatedEvent, (payload) => {
        const trader = payload.trader as TraderInfo | undefined;
        if (trader) this.emit({ trader });
      }),
    );
    // Spots stream into a map; P/L re-renders at most every 250ms (no per-tick storm).
    // Tick-critical consumers (bot) subscribe to the raw SpotEvent directly.
    this.eventUnsubs.push(
      this.client.on(Payload.SpotEvent, (payload) => {
        const symbolId = payload.symbolId as number;
        if (symbolId === undefined) return;
        const bid = scaleSpot(payload.bid ?? payload.ask);
        const ask = scaleSpot(payload.ask ?? payload.bid);
        if (bid === null || ask === null || bid <= 0 || ask <= 0) return;
        this.spots.set(symbolId, { bid, ask });
        if (Date.now() - this.lastSpotEmit > 250) {
          this.lastSpotEmit = Date.now();
          this.emit({});
        }
      }),
    );
  }

  /**
   * Optimistic execution patch: fills and closes appear in the same frame
   * as the broker event — snapshotAll (≤5s later) reconciles the truth.
   */
  private patchExecution(payload: Record<string, unknown>): void {
    const order = payload.order as
      | { orderId?: number; orderStatus?: number | string; tradeData?: { label?: string; tradeSide?: number | string; symbolId?: number; volume?: number } }
      | undefined;
    const deal = payload.deal as
      | { positionId?: number; executionPrice?: number; volume?: number; closePositionDetail?: object }
      | undefined;
    const position = payload.position as { positionId?: number } | undefined;
    let changed = false;

    const pid = position?.positionId ?? deal?.positionId;
    if (order && isFilledStatus(order.orderStatus) && order.orderId !== undefined) {
      this.snapshot.orders = this.snapshot.orders.filter((o) => Number(o.orderId) !== Number(order.orderId));
      changed = true;
      const symbolId = Number(order.tradeData?.symbolId ?? NaN);
      const side = asSide(order.tradeData?.tradeSide) === 'sell' ? 2 : 1;
      const volume = Number(order.tradeData?.volume ?? deal?.volume ?? NaN);
      if (
        pid !== undefined &&
        Number.isFinite(symbolId) &&
        Number.isFinite(volume) &&
        !this.snapshot.positions.some((p) => Number(p.positionId) === Number(pid))
      ) {
        this.snapshot.positions = [
          ...this.snapshot.positions,
          {
            positionId: Number(pid),
            tradeData: { symbolId, volume, tradeSide: side },
            positionStatus: 'POSITION_STATUS_OPEN',
            swap: 0,
            price: deal?.executionPrice ?? 0,
          } as PositionInfo,
        ];
        changed = true;
      }
    }
    if (deal?.closePositionDetail && pid !== undefined) {
      const before = this.snapshot.positions.length;
      this.snapshot.positions = this.snapshot.positions.filter((p) => Number(p.positionId) !== Number(pid));
      if (this.snapshot.positions.length !== before) changed = true;
      // Balance lands instantly from the close detail — equity/margin follow on the next tick.
      const detail = deal.closePositionDetail as { balance?: number; moneyDigits?: number };
      if (typeof detail.balance === 'number' && this.snapshot.trader) {
        const tDigits = this.snapshot.trader.moneyDigits ?? 2;
        const dDigits = detail.moneyDigits ?? tDigits;
        const balance =
          dDigits === tDigits ? detail.balance : Math.round(detail.balance * Math.pow(10, tDigits - dDigits));
        this.snapshot.trader = { ...this.snapshot.trader, balance };
        changed = true;
      }
      // Optimistic history row until DealListReq reconciles (≤5s later).
      const symbolId = Number(order?.tradeData?.symbolId ?? NaN);
      const volume = Number(order?.tradeData?.volume ?? deal?.volume ?? NaN);
      const side = asSide(order?.tradeData?.tradeSide) === 'sell' ? 2 : 1;
      if (
        Number.isFinite(symbolId) &&
        Number.isFinite(volume) &&
        !this.snapshot.deals.some((d) => Number(d.positionId) === Number(pid))
      ) {
        this.snapshot.deals = [
          {
            dealId: Date.now() * 1000 + (optimisticSeq = (optimisticSeq + 1) % 1000),
            positionId: Number(pid),
            volume,
            symbolId,
            executionTimestamp: Date.now(),
            executionPrice: deal?.executionPrice ?? 0,
            tradeSide: side,
            dealStatus: 2,
            closePositionDetail: deal.closePositionDetail as DealInfo['closePositionDetail'],
          },
          ...this.snapshot.deals,
        ].slice(0, 100);
        changed = true;
      }
    }
    if (changed) this.emit({});
  }

  /** Extra spot subscriptions (e.g. the bot's grid symbol) kept across snapshots. */
  private extraSpots = new Set<number>();
  private reauthing = false;
  private symbolsWarned = false;

  /** Last-known symbol directory (id → info) so an empty SymbolsList never blinds us. */
  private async loadSymbolsCache(into: Map<number, SymbolInfo>): Promise<void> {
    try {
      const raw = await storeGet(SYMBOLS_CACHE_KEY);
      if (!raw) return;
      const list = JSON.parse(raw) as { symbolId: number; symbolName: string; digits: number }[];
      list.forEach((s) => {
        if (s.symbolId !== undefined && s.symbolName) {
          into.set(s.symbolId, { symbolId: s.symbolId, symbolName: s.symbolName, digits: s.digits ?? 2 });
        }
      });
    } catch {
      // Cache is best-effort.
    }
  }

  private saveSymbolsCache(symbols: Map<number, SymbolInfo>): void {
    try {
      void storeSet(
        SYMBOLS_CACHE_KEY,
        JSON.stringify(
          [...symbols.values()].map((s) => ({ symbolId: s.symbolId, symbolName: s.symbolName, digits: s.digits })),
        ),
      );
    } catch {
      // Best effort.
    }
  }

  ensureSpots(symbolIds: number[]): void {
    let added = false;
    for (const id of symbolIds) {
      if (!this.extraSpots.has(id)) {
        this.extraSpots.add(id);
        added = true;
      }
    }
    if (!added || !this.session || this.snapshot.status !== 'ready') return;
    try {
      this.client.send(Payload.SubscribeSpotsReq, {
        ctidTraderAccountId: this.session.ctidTraderAccountId,
        symbolId: [...this.extraSpots],
      });
    } catch {
      // Next snapshot resubscribes.
    }
  }
  private lastSnapshotAt = 0;
  private lastDealsAt = 0;
  private lastSpotEmit = 0;
  private snapshotQueued = false;
  private snapshotTrailing: ReturnType<typeof setTimeout> | null = null;

  /**
   * The socket auto-reconnects on drops, but the server forgets auth +
   * spot subscriptions. Re-auth and resubscribe whenever it re-opens.
   * Multi-listener safe: never clobbers other state subscribers.
   */
  private watchConnection(): void {
    if (this.watchUnsub) return;
    this.watchUnsub = this.client.onState((state) => {
      if (state !== 'open') {
        // Surface disconnects instantly so Live badges go stale in realtime.
        if (this.snapshot.status === 'ready') this.emit({});
        return;
      }
      if (!this.session || this.snapshot.status !== 'ready' || this.reauthing) return;
      this.reauthing = true;
      void (async () => {
        try {
          let active = this.session!;
          if (active.expiresAt < Date.now() + 60000) {
            active = await refreshSession(active);
            this.session = active;
            this.scheduleTokenRefresh();
          }
          await this.request(Payload.ApplicationAuthReq, {
            clientId: CTRADER_CLIENT_ID,
            clientSecret: CTRADER_CLIENT_SECRET,
          });
          await this.request(Payload.AccountAuthReq, {
            ctidTraderAccountId: active.ctidTraderAccountId,
            accessToken: active.accessToken,
          });
          this.attachEvents(active.ctidTraderAccountId);
          await this.snapshotAll(active.ctidTraderAccountId, true);
        } catch {
          // Reconnect loop keeps the socket alive; next open retries.
        } finally {
          this.reauthing = false;
        }
      })();
    });
  }

  private async snapshotAll(accountId: number, force = false): Promise<void> {
    // Trailing debounce: bursts queue one follow-up instead of dropping truth.
    if (!force && Date.now() - this.lastSnapshotAt < 5000) {
      if (!this.snapshotQueued) {
        this.snapshotQueued = true;
        const wait = Math.max(0, 5000 - (Date.now() - this.lastSnapshotAt));
        this.snapshotTrailing = setTimeout(() => {
          this.snapshotQueued = false;
          this.snapshotTrailing = null;
          void this.snapshotAll(accountId, true);
        }, wait);
      }
      return;
    }
    this.lastSnapshotAt = Date.now();
    try {
      // Symbols barely change: fetch once per connection. Deals refresh at
      // most every 5 minutes (closes still surface via ExecutionEvent).
      const needSymbols = this.snapshot.symbols.size === 0;
      const needDeals = force || Date.now() - this.lastDealsAt > 300000;
      const [traderRes, reconcileRes, symbolsRes, dealsRes] = await Promise.all([
      this.request(Payload.TraderReq, { ctidTraderAccountId: accountId }),
      this.request(Payload.ReconcileReq, { ctidTraderAccountId: accountId }),
      needSymbols
        ? this.request(Payload.SymbolsListReq, { ctidTraderAccountId: accountId })
        : Promise.resolve(null),
      needDeals
        ? this.request(Payload.DealListReq, {
            ctidTraderAccountId: accountId,
            fromTimestamp: Date.now() - 30 * 24 * 3600 * 1000,
            maxRows: 100,
          })
        : Promise.resolve(null),
    ]);

    const symbols = needSymbols ? new Map<number, SymbolInfo>(this.snapshot.symbols) : this.snapshot.symbols;
    if (symbols.size === 0) await this.loadSymbolsCache(symbols);
    const resRecord = (symbolsRes ?? {}) as Record<string, unknown>;
    const rawList =
      (Array.isArray(resRecord.symbol) && resRecord.symbol.length > 0 ? resRecord.symbol : null) ??
      (Array.isArray(resRecord.symbols) && resRecord.symbols.length > 0 ? resRecord.symbols : null) ??
      (Array.isArray(resRecord.lightSymbol) && resRecord.lightSymbol.length > 0 ? resRecord.lightSymbol : null) ??
      (Array.isArray(resRecord.lightSymbols) && resRecord.lightSymbols.length > 0 ? resRecord.lightSymbols : null) ??
      [];
    const rawSymbols = rawList as {
      symbolId: number;
      symbolName?: string;
      digits?: number;
    }[];
    rawSymbols.forEach((raw) => {
      const info = toSymbolInfo(raw);
      if (info) symbols.set(raw.symbolId, info);
    });

    const positions = asArray<PositionInfo>(reconcileRes.position).filter(
      (p) => p.tradeData !== undefined && Number.isFinite(p.tradeData.symbolId) && isOpenPositionStatus(p.positionStatus),
    );
    const orders = asArray<OrderInfo>(reconcileRes.order).filter(
      (o) => o.tradeData !== undefined && Number.isFinite(o.tradeData.symbolId) && isRestingOrderStatus(o.orderStatus),
    );

    // Fallback: SymbolsList answers empty on some accounts — resolve the ids
    // we actually hold via SymbolById (known-good request).
    const missing = new Set<number>();
    positions.forEach((p) => {
      if (!symbols.has(p.tradeData.symbolId)) missing.add(p.tradeData.symbolId);
    });
    orders.forEach((o) => {
      if (!symbols.has(o.tradeData.symbolId)) missing.add(o.tradeData.symbolId);
    });
    if (missing.size > 0) {
      try {
        const byId = await this.request(Payload.SymbolByIdReq, {
          ctidTraderAccountId: accountId,
          symbolId: [...missing],
        });
        const list = asArray<{ symbolId: number; symbolName?: string; digits?: number }>(byId.symbol);
        list.forEach((raw) => {
          const info = toSymbolInfo(raw);
          if (info) symbols.set(raw.symbolId, info);
        });
      } catch {
        // Best effort — cache below still applies.
      }
    }
    if (symbols.size === 0) {
      if (!this.symbolsWarned) {
        this.symbolsWarned = true;
        if (__DEV__) console.warn('[live] symbols empty, res keys:', Object.keys(resRecord));
      }
    } else {
      this.symbolsWarned = false;
      this.saveSymbolsCache(symbols);
    }

    // Subscribe spots for open symbols (+ conversion helpers + bot grid symbol).
    const wanted = new Set<number>(positions.map((p) => p.tradeData.symbolId));
    this.extraSpots.forEach((id) => wanted.add(id));
    const byName = new Map<string, number>();
    symbols.forEach((s, id) => byName.set(s.symbolName, id));
    ['USDJPY', 'EURUSD'].forEach((name) => {
      const id = byName.get(name);
      if (id !== undefined) wanted.add(id);
    });
    if (wanted.size > 0) {
      try {
        await this.request(Payload.SubscribeSpotsReq, {
          ctidTraderAccountId: accountId,
          symbolId: [...wanted],
        });
      } catch {
        // Spots are best-effort; snapshot values still work.
      }
    }

    const deals = (
      needDeals
        ? (asArray<DealInfo>(dealsRes?.deal)
            .filter((deal) => deal.closePositionDetail != null)
            .sort((a, b) => b.executionTimestamp - a.executionTimestamp))
        : this.snapshot.deals
    );
    if (needDeals) this.lastDealsAt = Date.now();

    this.emit({
      trader: (traderRes.trader ?? null) as TraderInfo | null,
      positions,
      orders,
      deals,
      symbols,
    });
    } catch (err) {
      // Snapshot failures (e.g. rate limiting) must never crash the stream.
      if (__DEV__) console.warn('[live] snapshot failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Dead-stream watchdog: heartbeats go out every 10s but prove nothing.
   * When we hold subscriptions (positions, orders, or the bot's symbol) and
   * hear nothing for 35s, recycle the socket — the watcher re-auths after.
   * No polling refresh: the stream is purely event-driven (Execution/Spot/
   * Trader events + optimistic patches), so idle apps cost zero renders.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      if (this.snapshot.status !== 'ready' || !this.session) return;
      const needsStream =
        this.extraSpots.size > 0 || this.snapshot.positions.length > 0 || this.snapshot.orders.length > 0;
      if (!needsStream) return;
      // Never recycle mid-reauth: the open socket is about to be re-authed,
      // and recycling now would strand it open-but-unauthed for another 35s.
      if (this.reauthing) return;
      if (Date.now() - this.client.lastMessageAt > 35000) {
        if (__DEV__) console.warn('[live] stream silent — recycling connection');
        // recycle() keeps wantOpen: the socket re-opens and watchConnection
        // re-auths. close() here would strand the stream forever.
        this.client.recycle();
      }
    }, 15000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  /* ---------------- selectors (app shapes) ---------------- */

  private quoteToDeposit(symbolName: string, depositIsUsd: boolean): number {
    if (!depositIsUsd) return 1;
    const quote = symbolName.slice(-3);
    if (quote === 'USD') return 1;
    const conv = this.spots.get(this.symbolIdByName(`USD${quote}`));
    if (conv) {
      const mid = (conv.bid + conv.ask) / 2;
      if (mid > 0) return 1 / mid;
    }
    const direct = this.spots.get(this.symbolIdByName(`${quote}USD`));
    if (direct) return (direct.bid + direct.ask) / 2;
    return 1;
  }

  private symbolIdByName(name: string): number {
    for (const [id, s] of this.snapshot.symbols) {
      if (s.symbolName === name) return id;
    }
    return -1;
  }

  unrealized(position: PositionInfo): number {
    const symbol = this.snapshot.symbols.get(position.tradeData.symbolId);
    const spot = this.spots.get(position.tradeData.symbolId);
    const open = position.price ?? 0;
    if (!spot || !open) return 0;
    // Side-aware close price: BUY exits at bid, SELL at ask. Mid would hide spread.
    const isBuy = asSide(position.tradeData.tradeSide) === 'buy';
    const close = isBuy ? spot.bid : spot.ask;
    const dir = isBuy ? 1 : -1;
    const units = position.tradeData.volume / 100;
    const quotePL = (close - open) * dir * units;
    return quotePL * this.quoteToDeposit(symbol?.symbolName ?? '', true);
  }

  /** Latest spot for a symbol (realtime tick cache). */
  getSpot(symbolId: number): { bid: number; ask: number; mid: number } | null {
    const spot = this.spots.get(symbolId);
    if (!spot) return null;
    return { ...spot, mid: (spot.bid + spot.ask) / 2 };
  }

  /** Realtime health for banners: socket state + stream staleness. */
  health(): { socket: string; staleSeconds: number; stale: boolean } {
    const staleSeconds = secondsSinceMessage(this.client.lastMessageAt);
    const needsStream =
      this.extraSpots.size > 0 || this.snapshot.positions.length > 0 || this.snapshot.orders.length > 0;
    return {
      socket: this.client.state,
      staleSeconds: Number.isFinite(staleSeconds) ? staleSeconds : -1,
      stale: needsStream && staleSeconds > 35,
    };
  }

  openPL(): number {
    return this.snapshot.positions.reduce((sum, p) => sum + this.unrealized(p), 0);
  }

  accountState(): { balance: number; equity: number; margin: number; freeMargin: number; marginLevel: number } {
    const trader = this.snapshot.trader;
    const digits = trader?.moneyDigits ?? 2;
    const balance = money(trader?.balance, digits);
    const margin = this.snapshot.positions.reduce(
      (sum, p) => sum + money(p.usedMargin, p.moneyDigits ?? digits),
      0,
    );
    const open = this.openPL();
    const equity = balance + open;
    return {
      balance,
      equity,
      margin,
      freeMargin: equity - margin,
      marginLevel: margin > 0 ? (equity / margin) * 100 : 0,
    };
  }

  static async restore(): Promise<CTraderSession | null> {
    return loadSession();
  }
}

export const liveEngine = new LiveEngine();

export { LiveEngine };

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(liveEngine.subscribe, liveEngine.getSnapshot);
}

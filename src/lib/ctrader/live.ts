import { useSyncExternalStore } from 'react';
import { CTraderClient } from './client';
import {
  CTRADER_CLIENT_ID,
  CTRADER_CLIENT_SECRET,
  refreshTokens,
  socketUrl,
} from './config';
import { Payload } from './protocol';
import { isOpenPositionStatus, isRestingOrderStatus } from './orders';
import type {
  AccountInfo,
  DealInfo,
  OrderInfo,
  PositionInfo,
  SymbolInfo,
  TraderInfo,
} from './protocol';
import { loadSession, saveSession, type CTraderSession } from './session';
import { storeGet, storeSet } from '../storage';

const SYMBOLS_CACHE_KEY = 'ctrader.symbols.v1';

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

function normalizeSymbolName(name: string): string {
  return name.replace('/', '').toUpperCase();
}

function money(value: number | undefined, digits: number | undefined): number {
  if (value === undefined) return 0;
  return value / Math.pow(10, digits ?? 2);
}

/**
 * Live cTrader data engine (JSON over WebSocket, all platforms).
 * Owns one connection per environment; screens read via useLive().
 */
class LiveEngine {
  private client = new CTraderClient();
  private snapshot: LiveSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private spots = new Map<number, { bid: number; ask: number }>();
  private lightTimer: ReturnType<typeof setInterval> | null = null;
  private session: CTraderSession | null = null;
  private starting = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LiveSnapshot => this.snapshot;

  private emit(partial: Partial<LiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial, version: this.snapshot.version + 1 };
    this.listeners.forEach((listener) => listener());
  }

  get connected(): boolean {
    return this.snapshot.status === 'ready';
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
  ): Promise<{ session: CTraderSession; accountId: number }> {
    let active = session;
    if (active.expiresAt < Date.now() + 60000) {
      const tokens = await refreshTokens(active.refreshToken);
      active = {
        ...active,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
      };
      await saveSession(active);
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
    const list = (accounts.ctidTraderAccount as AccountInfo[] | undefined) ?? [];
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
    return { session: authed, accountId };
  }

  private static waitOpen(client: CTraderClient): Promise<void> {
    if (client.state === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connection timed out')), 20000);
      client.onStateChange = (state) => {
        if (state === 'open') {
          clearTimeout(timer);
          client.onStateChange = null;
          resolve();
        }
      };
    });
  }

  /** Full login sequence: tokens → socket → app auth → account auth → snapshot. */
  async start(session: CTraderSession): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.emit({ status: 'connecting', error: null });
    try {
      const { session: active, accountId } = await LiveEngine.prepareConnection(
        this.client,
        session,
      );
      this.session = active;
      const accounts = await this.request(Payload.GetAccountsByAccessTokenReq, {
        accessToken: active.accessToken,
      });
      const match = ((accounts.ctidTraderAccount as AccountInfo[] | undefined) ?? []).find(
        (a) => a.ctidTraderAccountId === accountId,
      );
      this.attachEvents(accountId);
      await this.snapshotAll(accountId, true);
      this.watchConnection();
      this.emit({ status: 'ready', account: match ?? null });
      this.startLightRefresh();
    } catch (err) {
      this.emit({
        status: 'error',
        error: err instanceof Error ? err.message : 'Connection failed',
      });
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.stopLightRefresh();
    this.client.onStateChange = null;
    this.client.close();
    this.session = null;
    this.spots.clear();
    this.symbolsWarned = false;
    this.snapshot = EMPTY;
    this.listeners.forEach((listener) => listener());
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
    // Position/balance changes: refresh the snapshot (simple + robust).
    // A close also stales the deals list so History updates in realtime.
    this.eventUnsubs.push(
      this.client.on(Payload.ExecutionEvent, (payload) => {
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
    // Spots stream into a map; a 2s light tick re-renders P/L (no per-tick setState).
    this.eventUnsubs.push(
      this.client.on(Payload.SpotEvent, (payload) => {
        const symbolId = payload.symbolId as number;
        const bid = payload.bid as number | undefined;
        const ask = payload.ask as number | undefined;
        if (symbolId !== undefined && (bid !== undefined || ask !== undefined)) {
          this.spots.set(symbolId, {
            bid: (bid ?? ask ?? 0) / 100000,
            ask: (ask ?? bid ?? 0) / 100000,
          });
        }
      }),
    );
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

  /**
   * The socket auto-reconnects on drops, but the server forgets auth +
   * spot subscriptions. Re-auth and resubscribe whenever it re-opens.
   */
  private watchConnection(): void {
    this.client.onStateChange = (state) => {
      if (state !== 'open') return;
      if (!this.session || this.snapshot.status !== 'ready' || this.reauthing) return;
      this.reauthing = true;
      void (async () => {
        try {
          let active = this.session!;
          if (active.expiresAt < Date.now() + 60000) {
            const tokens = await refreshTokens(active.refreshToken);
            active = {
              ...active,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              expiresAt: Date.now() + tokens.expiresIn * 1000,
            };
            await saveSession(active);
            this.session = active;
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
    };
  }

  private async snapshotAll(accountId: number, force = false): Promise<void> {
    // Debounce event-driven refreshes: bursts of fills must not storm the server.
    if (!force && Date.now() - this.lastSnapshotAt < 5000) return;
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

    const symbols = needSymbols || force ? new Map<number, SymbolInfo>() : this.snapshot.symbols;
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
    rawSymbols.forEach((s) => {
      if (s.symbolName) symbols.set(s.symbolId, { symbolId: s.symbolId, symbolName: normalizeSymbolName(s.symbolName), digits: typeof s.digits === 'number' ? s.digits : 2 });
    });

    const positions = ((reconcileRes.position ?? []) as PositionInfo[]).filter((p) =>
      isOpenPositionStatus(p.positionStatus),
    );
    const orders = ((reconcileRes.order ?? []) as OrderInfo[]).filter((o) =>
      isRestingOrderStatus(o.orderStatus),
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
        const list = ((byId.symbol ?? []) as { symbolId: number; symbolName?: string; digits?: number }[]);
        list.forEach((s) => {
          if (s.symbolName) {
            symbols.set(s.symbolId, {
              symbolId: s.symbolId,
              symbolName: normalizeSymbolName(s.symbolName),
              digits: typeof s.digits === 'number' ? s.digits : 2,
            });
          }
        });
      } catch {
        // Best effort — cache below still applies.
      }
    }
    if (symbols.size === 0) {
      if (!this.symbolsWarned) {
        this.symbolsWarned = true;
        console.warn('[live] symbols empty, res keys:', Object.keys(resRecord));
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
        ? (((dealsRes?.deal ?? []) as DealInfo[])
            .filter((deal) => deal.closePositionDetail !== undefined)
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
      console.warn('[live] snapshot failed:', err instanceof Error ? err.message : err);
    }
  }

  private startLightRefresh(): void {
    this.stopLightRefresh();
    this.lightTimer = setInterval(() => {
      if (this.snapshot.status === 'ready') this.emit({});
    }, 2000);
  }

  private stopLightRefresh(): void {
    if (this.lightTimer) clearInterval(this.lightTimer);
    this.lightTimer = null;
  }

  /* ---------------- selectors (app shapes) ---------------- */

  private quoteToDeposit(symbolName: string, depositIsUsd: boolean): number {
    if (!depositIsUsd) return 1;
    const quote = symbolName.slice(-3);
    if (quote === 'USD') return 1;
    const conv = this.spots.get(this.symbolIdByName(`USD${quote}`));
    if (conv) return 1 / ((conv.bid + conv.ask) / 2);
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
    const mid = (spot.bid + spot.ask) / 2;
    const dir = position.tradeData.tradeSide === 1 ? 1 : -1;
    const units = position.tradeData.volume / 100;
    const quotePL = (mid - open) * dir * units;
    return quotePL * this.quoteToDeposit(symbol?.symbolName ?? '', true);
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

import { useMemo } from 'react';
import { useMockAccount } from '@/hooks/use-mock-account';
import type { MockAccount } from '@/lib/trading/types';
import { liveEngine, useLive } from '@/lib/ctrader/live';
import { asSide, unitsPerLot } from '@/lib/ctrader/orders';

/**
 * Single data source for all trading screens.
 * Live cTrader data when the engine is connected, mock feed otherwise,
 * identical shapes either way so screens never change.
 * Memoized: realtime spot ticks bump version at most every 250ms, and
 * derived arrays only rebuild when their inputs actually change.
 */
export function useTrading(): MockAccount & { live: boolean } {
  const live = useLive();
  const mock = useMockAccount();
  const isLive = live.status === 'ready' && live.trader !== null;

  const derived = useMemo(() => {
    if (!isLive) return null;
    const symbols = live.symbols;
    const nameOf = (id: number) => symbols.get(id)?.symbolName ?? `#${id}`;
    const numVol = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const lotsOf = (symbolId: number, volume: number) =>
      volume / (unitsPerLot(nameOf(symbolId)) * 100);
    const num = (v: unknown, fallback = 0): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    // Malformed broker rows are skipped, never thrown — one bad position
    // must not crash every screen (live.ts pre-filters, this is the net).
    const positions = live.positions.flatMap((p) => {
      const td = p.tradeData as
        | { symbolId?: unknown; volume?: unknown; tradeSide?: unknown }
        | undefined;
      if (typeof td?.symbolId !== 'number' || !Number.isFinite(td.symbolId)) return [];
      const rawVol = numVol(td?.volume);
      if (rawVol === null) return [];
      const volume = lotsOf(td.symbolId, rawVol);
      if (!Number.isFinite(volume)) return [];
      return [{
        id: Number(p.positionId),
        symbol: nameOf(td.symbolId),
        side: asSide(td.tradeSide),
        volume,
        rawVolume: rawVol,
        pl: num(liveEngine.unrealized(p)),
        openPrice: num(p.price),
        tp: num(p.takeProfit),
        sl: num(p.stopLoss),
      }];
    });
    const history = live.deals.flatMap((deal) => {
      const detail = deal.closePositionDetail as
        | { moneyDigits?: unknown; grossProfit?: unknown; swap?: unknown; commission?: unknown }
        | undefined
        | null;
      if (detail == null) return [];
      const digits = typeof detail.moneyDigits === 'number' ? detail.moneyDigits : 2;
      const scale = Math.pow(10, digits);
      const at = new Date(deal.executionTimestamp);
      if (!Number.isFinite(at.getTime())) return [];
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      const pl = (num(detail.grossProfit) + num(detail.swap) + num(detail.commission)) / scale;
      if (!Number.isFinite(pl)) return [];
      const rawVol = numVol(deal.volume);
      if (rawVol === null) return [];
      const volume = lotsOf(deal.symbolId, rawVol);
      if (!Number.isFinite(volume)) return [];
      return [{
        id: Number(deal.dealId),
        symbol: nameOf(deal.symbolId),
        side: asSide(deal.tradeSide),
        volume,
        pl,
        time: at.toLocaleTimeString('en-GB'),
        day,
      }];
    });
    const account = liveEngine.accountState();
    const orders = live.orders.flatMap((o) => {
      const td = o.tradeData as
        | { symbolId?: unknown; volume?: unknown; tradeSide?: unknown }
        | undefined;
      if (typeof td?.symbolId !== 'number' || !Number.isFinite(td.symbolId)) return [];
      const rawVol = numVol(td?.volume);
      if (rawVol === null) return [];
      const volume = lotsOf(td.symbolId, rawVol);
      if (!Number.isFinite(volume)) return [];
      return [{
        id: String(o.orderId),
        symbol: nameOf(td.symbolId),
        side: asSide(td.tradeSide),
        volume,
        limitPrice: num(o.limitPrice),
        stopLoss: num(o.stopLoss),
        takeProfit: num(o.takeProfit),
      }];
    });
    const trades = history.length;
    const wins = history.filter((t) => t.pl > 0).length;
    const realizedPL = history.reduce((sum, t) => sum + t.pl, 0);
    return {
      account,
      stats: {
        trades,
        wins,
        winRate: trades === 0 ? 0 : (wins / trades) * 100,
        openPL: liveEngine.openPL(),
        realizedPL,
      },
      positions,
      orders,
      history,
      live: true as const,
    };
    // Rebuild only when source data changes — version bumps from spot ticks
    // flow through unrealized() but keep array identities stable otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, live.positions, live.orders, live.deals, live.symbols, live.trader, live.version]);

  if (derived) return derived;

  return { ...mock, live: false };
}

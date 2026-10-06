import { useMockAccount, type MockAccount } from '@/hooks/use-mock-account';
import { liveEngine, useLive } from '@/lib/ctrader/live';

/**
 * Single data source for all trading screens.
 * Live cTrader data when the engine is connected, mock feed otherwise,
 * identical shapes either way so screens never change.
 */
export function useTrading(): MockAccount {
  const live = useLive();
  const mock = useMockAccount();

  if (live.status === 'ready' && live.trader) {
    const symbols = live.symbols;
    const nameOf = (id: number) => symbols.get(id)?.symbolName ?? `#${id}`;
    const positions = live.positions.map((p) => ({
      id: Number(p.positionId),
      symbol: nameOf(p.tradeData.symbolId),
      side: (p.tradeData.tradeSide === 1 ? 'buy' : 'sell') as 'buy' | 'sell',
      volume: p.tradeData.volume / 10000000,
      pl: liveEngine.unrealized(p),
      openPrice: p.price ?? 0,
      tp: p.takeProfit ?? 0,
      sl: p.stopLoss ?? 0,
    }));
    const history = live.deals.map((deal) => {
      const detail = deal.closePositionDetail!;
      const digits = detail.moneyDigits ?? 2;
      const scale = Math.pow(10, digits);
      const at = new Date(deal.executionTimestamp);
      const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      return {
        id: Number(deal.dealId),
        symbol: nameOf(deal.symbolId),
        side: (deal.tradeSide === 1 ? 'buy' : 'sell') as 'buy' | 'sell',
        volume: deal.volume / 10000000,
        pl: (detail.grossProfit + detail.swap + detail.commission) / scale,
        time: at.toLocaleTimeString('en-GB'),
        day,
      };
    });
    const account = liveEngine.accountState();
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
      history,
    };
  }

  return mock;
}

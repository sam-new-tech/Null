import { cancelOrders, closePositions, type TradeExecutor } from '@/lib/trading/actions';
import type { LiveOrder, Position } from '@/lib/trading/types';

interface Sent {
  type: number;
  payload: Record<string, unknown>;
}

function executor(accountId: number | null = 7): TradeExecutor & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    getAccountId: () => accountId,
    execSend: (type, payload) => sent.push({ type, payload }),
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    id: 11,
    symbol: 'XAUUSD',
    side: 'buy',
    volume: 0.02,
    rawVolume: 200,
    pl: 1,
    openPrice: 2400,
    tp: 2402,
    sl: 2398,
    ...overrides,
  };
}

function order(overrides: Partial<LiveOrder> = {}): LiveOrder {
  return {
    id: '42',
    symbol: 'EURUSD',
    side: 'buy',
    volume: 0.1,
    limitPrice: 1.1,
    stopLoss: 0,
    takeProfit: 0,
    ...overrides,
  };
}

describe('closePositions', () => {
  it('sends one close per position, echoing raw volume', () => {
    const exec = executor();
    const count = closePositions(exec, [
      position({ id: 1, symbol: 'XAUUSD', rawVolume: 250 }),
      position({ id: 2, symbol: 'EURUSD', rawVolume: 10_000 }),
    ]);

    expect(count).toBe(2);
    expect(exec.sent).toEqual([
      { type: 2111, payload: { ctidTraderAccountId: 7, positionId: 1, volume: 250 } },
      { type: 2111, payload: { ctidTraderAccountId: 7, positionId: 2, volume: 10_000 } },
    ]);
  });

  it('no-ops on an empty list and never needs an account', () => {
    const exec = executor(null);
    expect(closePositions(exec, [])).toBe(0);
    expect(exec.sent).toHaveLength(0);
  });

  it('requires a connected account before sending', () => {
    expect(() => closePositions(executor(null), [position()])).toThrow('Account not connected');
  });
});

describe('cancelOrders', () => {
  it('sends one cancel per order', () => {
    const exec = executor();
    const count = cancelOrders(exec, [order({ id: '42' }), order({ id: '43' })]);

    expect(count).toBe(2);
    expect(exec.sent).toEqual([
      { type: 2108, payload: { ctidTraderAccountId: 7, orderId: 42 } },
      { type: 2108, payload: { ctidTraderAccountId: 7, orderId: 43 } },
    ]);
  });

  it('no-ops on an empty list', () => {
    expect(cancelOrders(executor(null), [])).toBe(0);
  });
});

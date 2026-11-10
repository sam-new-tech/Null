/**
 * Bulk trade actions for the Trades screen.
 *
 * Kept engine-agnostic (a tiny executor interface) so request building is
 * unit-testable. `liveEngine` satisfies `TradeExecutor` at the call site.
 */

import { cancelOrder, closePosition, unitsPerLot } from '../ctrader/orders';
import type { LiveOrder, Position } from './types';

export interface TradeExecutor {
  getAccountId(): number | null;
  execSend(type: number, payload: Record<string, unknown>): void;
}

function requireAccountId(executor: TradeExecutor): number {
  const id = executor.getAccountId();
  if (!id) throw new Error('Account not connected');
  return id;
}

/**
 * Close every live position, echoing its raw protocol volume and using the
 * symbol's units-per-lot. Returns the number of close requests sent.
 *
 * cTrader confirms closes asynchronously via ExecutionEvent (see orders.ts),
 * so "sent" means queued for the broker, not filled.
 */
export function closePositions(executor: TradeExecutor, positions: readonly Position[]): number {
  if (positions.length === 0) return 0;
  const accountId = requireAccountId(executor);
  for (const position of positions) {
    const pair = closePosition(
      accountId,
      position.id,
      position.volume,
      unitsPerLot(position.symbol),
      position.rawVolume,
    );
    executor.execSend(pair.type, pair.payload);
  }
  return positions.length;
}

/** Cancel every resting order. Returns the number of cancel requests sent. */
export function cancelOrders(executor: TradeExecutor, orders: readonly LiveOrder[]): number {
  if (orders.length === 0) return 0;
  const accountId = requireAccountId(executor);
  for (const order of orders) {
    const pair = cancelOrder(accountId, order.id);
    executor.execSend(pair.type, pair.payload);
  }
  return orders.length;
}

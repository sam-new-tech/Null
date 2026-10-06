/**
 * Typed builders for cTrader trading ops (JSON transport).
 *
 * Each builder returns a `{ type, payload }` pair. It does NOT send anything;
 * the caller transmits it (e.g. `client.request(pair.type, pair.payload)` or
 * `client.send(...)`) and listens for confirmations documented below.
 *
 * Numbers verified against the official spec
 * (spotware/openapi-proto-messages, OpenApiMessages.proto +
 * OpenApiModelMessages.proto): payload-type ids, ProtoOAOrderType
 * (MARKET = 1, LIMIT = 2), ProtoOATradeSide (BUY = 1, SELL = 2),
 * ProtoOATrendbarPeriod (M1 = 1 .. MN1 = 14), ProtoOAOrderStatus (1..5).
 *
 * ---- HOW COMPLETION IS CONFIRMED, PER OPERATION ----
 *
 * 1. symbolsList — req 2114 (PROTO_OA_SYMBOLS_LIST_REQ).
 *    Direct response: 2115 (PROTO_OA_SYMBOLS_LIST_RES), resolved by
 *    `client.request()` via clientMsgId correlation. The payload carries
 *    `symbol` (ProtoOALightSymbol[]) and `archivedSymbol`.
 *
 * 2. trendbars — req 2137 (PROTO_OA_GET_TRENDBARS_REQ).
 *    Direct response: 2138 (PROTO_OA_GET_TRENDBARS_RES), resolved by
 *    `client.request()` via clientMsgId correlation. The payload carries the
 *    `trendbar` array (singular field name in the spec) — see `mapTrendbars`.
 *
 * 3-5. Trading ops (placeLimitOrder 2106 / cancelOrder 2108 /
 *    closePosition 2111) have NO direct *Res message. Verified: the
 *    ProtoOAPayloadType enum contains PROTO_OA_NEW_ORDER_REQ = 2106,
 *    PROTO_OA_CANCEL_ORDER_REQ = 2108 and PROTO_OA_CLOSE_POSITION_REQ = 2111
 *    but NO NewOrderRes / CancelOrderRes / ClosePositionRes. The spec's own
 *    doc comment on ProtoOAExecutionEvent states it "Acts as response to the
 *    ProtoOANewOrderReq, ProtoOACancelOrderReq, ProtoOAAmendOrderReq,
 *    ProtoOAAmendPositionSLTPReq, ProtoOAClosePositionReq requests."
 *    Consequence: `client.request()` will NOT resolve for these (no direct
 *    response is ever sent) — send with `client.send()` and subscribe with
 *    `client.on(2126 /* ExecutionEvent *\/, handler)`.
 *
 *    Correlate the async ExecutionEvent (2126) as follows:
 *    - placeLimitOrder: watch for executionType ORDER_ACCEPTED (= 2) then
 *      ORDER_FILLED (= 3). Match `event.order.tradeData.label` against the
 *      `label` sent in the request (the label echoes in
 *      ProtoOATradeData.label: "Text label specified during order request"),
 *      or match `event.order.clientOrderId` if one was supplied.
 *      `event.order.orderStatus` carries the OrderStatus string;
 *      `event.order.orderId` is the server-side order id; on fill,
 *      `event.deal` carries dealId/executionPrice and `event.position` the
 *      opened position. Rejection arrives as ORDER_REJECTED (= 7) with the
 *      event's `errorCode` string field set.
 *    - cancelOrder: watch for executionType ORDER_CANCELLED (= 5) and match
 *      `event.order.orderId` against the requested orderId. A failed cancel
 *      arrives as ORDER_CANCEL_REJECTED (= 8), or as a ProtoOAOrderErrorEvent
 *      (2132) carrying `{ errorCode, orderId, description }`.
 *    - closePosition: watch for an event whose `event.deal.positionId`
 *      equals the requested positionId. `event.deal.closePositionDetail` is
 *      present only on closing deals and carries entryPrice, grossProfit,
 *      swap, commission and balance. A partial close arrives as
 *      ORDER_PARTIAL_FILL (= 11); check `event.deal.filledVolume` vs the
 *      requested volume.
 *    Transport-level failures for any request surface as ProtoOAErrorRes
 *    (2142), which `client.request()` turns into a rejected promise.
 */

/** Request pair handed to the caller for transmission. */
export interface RequestPair {
  type: number;
  payload: Record<string, unknown>;
}

/**
 * Trend-bar periods. Values from ProtoOATrendbarPeriod in the spec:
 * M1 = 1, M5 = 5, M15 = 7, H1 = 9, H4 = 10, H12 = 11, D1 = 12
 * (full enum also covers M2/M3/M4/M10/M30/W1/MN1, included for completeness).
 * Requests must send these as NUMBERS.
 */
export const TrendbarPeriod = {
  M1: 1,
  M2: 2,
  M3: 3,
  M4: 4,
  M5: 5,
  M10: 6,
  M15: 7,
  M30: 8,
  H1: 9,
  H4: 10,
  H12: 11,
  D1: 12,
  W1: 13,
  MN1: 14,
} as const;

export type TrendbarPeriodId = (typeof TrendbarPeriod)[keyof typeof TrendbarPeriod];

/**
 * Order statuses. The JSON transport returns ProtoOAOrderStatus enum values
 * as their names (strings), so these are string consts, not numbers.
 * Spec: ORDER_STATUS_ACCEPTED = 1, FILLED = 2, REJECTED = 3, EXPIRED = 4,
 * CANCELLED = 5.
 */
export const OrderStatus = {
  Accepted: 'ORDER_STATUS_ACCEPTED',
  Filled: 'ORDER_STATUS_FILLED',
  Rejected: 'ORDER_STATUS_REJECTED',
  Expired: 'ORDER_STATUS_EXPIRED',
  Cancelled: 'ORDER_STATUS_CANCELLED',
} as const;

export type OrderStatusName = (typeof OrderStatus)[keyof typeof OrderStatus];

/**
 * Execution-event types relevant when correlating trading confirmations
 * (ProtoOAExecutionType; JSON transport delivers the names as strings).
 */
export const ExecutionType = {
  OrderAccepted: 'ORDER_ACCEPTED',
  OrderFilled: 'ORDER_FILLED',
  OrderReplaced: 'ORDER_REPLACED',
  OrderCancelled: 'ORDER_CANCELLED',
  OrderExpired: 'ORDER_EXPIRED',
  OrderRejected: 'ORDER_REJECTED',
  OrderCancelRejected: 'ORDER_CANCEL_REJECTED',
  OrderPartialFill: 'ORDER_PARTIAL_FILL',
} as const;

export type ExecutionTypeName = (typeof ExecutionType)[keyof typeof ExecutionType];

/** 1 lot = 100_000 units; proto volume is in 0.01 of a unit ("cents"). */
const VOLUME_PER_LOT = 10_000_000;

/**
 * Base-asset units in one lot. FX default 100_000; metals/crypto differ.
 * XAUUSD is the bot's market (1 lot = 100 oz); others best-effort.
 */
export function unitsPerLot(symbolName: string): number {
  const s = symbolName.toUpperCase().replace('/', '');
  if (s === 'XAUUSD') return 100;
  if (s === 'XAGUSD') return 5000;
  if (s === 'BTCUSD') return 1;
  return 100000;
}

function lotsToVolume(volumeLots: number, unitsPerLot = 100000): number {
  return Math.round(volumeLots * unitsPerLot * 100);
}

/** ProtoOASymbolsListReq (2114). Only field besides the account id is the
 *  optional includeArchivedSymbols (proto default false), so it is omitted. */
export function symbolsList(accountId: number): RequestPair {
  return { type: 2114, payload: { ctidTraderAccountId: accountId } };
}

export interface TrendbarsRange {
  fromTimestamp?: number;
  toTimestamp?: number;
  count?: number;
}

/** ProtoOAGetTrendbarsReq (2137). Timestamps are Unix ms; period is numeric. */
export function trendbars(
  accountId: number,
  symbolId: number,
  period: typeof TrendbarPeriod[keyof typeof TrendbarPeriod] | number,
  range: TrendbarsRange = {},
): RequestPair {
  const payload: Record<string, unknown> = {
    ctidTraderAccountId: accountId,
    symbolId,
    period,
  };
  if (range.fromTimestamp !== undefined) payload.fromTimestamp = range.fromTimestamp;
  if (range.toTimestamp !== undefined) payload.toTimestamp = range.toTimestamp;
  if (range.count !== undefined) payload.count = range.count;
  return { type: 2137, payload };
}

export interface LimitOrderParams {
  symbolId: number;
  side: 'buy' | 'sell';
  volumeLots: number;
  limitPrice: number;
  takeProfit?: number;
  stopLoss?: number;
  /** Echoed back in ExecutionEvent order.tradeData.label — used to correlate
   *  the async fill confirmation, so always set it. */
  label?: string;
  unitsPerLot?: number;
}

/**
 * ProtoOANewOrderReq (2106) for a LIMIT order.
 * Sends tradeSide (BUY = 1 / SELL = 2) and orderType LIMIT = 2 as NUMBERS.
 * limitPrice is a raw double. stopLoss/takeProfit are absolute-price doubles
 * (supported for LIMIT; unsupported only for MARKET orders).
 *
 * timeInForce finding: ProtoOANewOrderReq.timeInForce is OPTIONAL with a
 * proto default of GOOD_TILL_CANCEL, so it is OMITTED here — the server
 * applies GTC. LIMIT does not require it to be sent explicitly.
 */
export function placeLimitOrder(accountId: number, params: LimitOrderParams): RequestPair {
  const payload: Record<string, unknown> = {
    ctidTraderAccountId: accountId,
    symbolId: params.symbolId,
    orderType: 2,
    tradeSide: params.side === 'buy' ? 1 : 2,
    volume: lotsToVolume(params.volumeLots, params.unitsPerLot),
    limitPrice: params.limitPrice,
  };
  if (params.stopLoss !== undefined) payload.stopLoss = params.stopLoss;
  if (params.takeProfit !== undefined) payload.takeProfit = params.takeProfit;
  if (params.label !== undefined) payload.label = params.label;
  return { type: 2106, payload };
}

/** ProtoOACancelOrderReq (2108). Confirm via ExecutionEvent ORDER_CANCELLED
 *  matching order.orderId (see file header). */
export function cancelOrder(accountId: number, orderId: number | string): RequestPair {
  return {
    type: 2108,
    payload: { ctidTraderAccountId: accountId, orderId: Number(orderId) },
  };
}

/** ProtoOAClosePositionReq (2111). Pass the FULL position volume (in lots)
 *  to close the whole position. Confirm via the ExecutionEvent whose
 *  deal.positionId matches (see file header). */
export function closePosition(
  accountId: number,
  positionId: number | string,
  volumeLots: number,
  unitsPerLot = 100000,
): RequestPair {
  return {
    type: 2111,
    payload: {
      ctidTraderAccountId: accountId,
      positionId: Number(positionId),
      volume: lotsToVolume(volumeLots, unitsPerLot),
    },
  };
}

/**
 * Defensive trade-side parser for RESPONSE payloads. Requests always send
 * 1/2 (numbers), but responses may carry 1, 2, 'BUY' or 'SELL' depending on
 * the gateway. Unknown values default to 'buy'.
 */
export function asSide(value: unknown): 'buy' | 'sell' {
  if (value === 2 || value === '2') return 'sell';
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    if (upper === 'SELL') return 'sell';
    if (upper === 'BUY' || upper === '1') return 'buy';
  }
  if (value === 1) return 'buy';
  return 'buy';
}

function statusIs(value: unknown, name: string, num: number): boolean {
  return value === undefined || value === name || value === num || value === String(num);
}

/** Open positions: string names or numeric enum values both accepted. */
export function isOpenPositionStatus(value: unknown): boolean {
  return statusIs(value, 'POSITION_STATUS_OPEN', 1);
}

/** Resting (working) limit/stop orders. */
export function isRestingOrderStatus(value: unknown): boolean {
  return statusIs(value, 'ORDER_STATUS_ACCEPTED', 1);
}

export function isFilledStatus(value: unknown): boolean {
  return value === 'ORDER_STATUS_FILLED' || value === 2 || value === '2';
}

export function isRejectedStatus(value: unknown): boolean {
  return value === 'ORDER_REJECTED' || value === 7 || value === '7';
}

export function isCancelRejectedStatus(value: unknown): boolean {
  return value === 'ORDER_CANCEL_REJECTED' || value === 8 || value === '8';
}

export interface Trendbar {
  /** Bar open time, Unix milliseconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Tick volume when provided. */
  volume?: number;
}

function toNum(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract Trendbar[] from a ProtoOAGetTrendbarsRes (2138) payload. The spec
 * field name is `trendbar` (singular, repeated); a bare array is also
 * accepted, and `trendbars` (plural) as a fallback.
 *
 * Price form: ProtoOATrendbar declares `low` (int64) plus delta fields
 * deltaOpen/deltaClose/deltaHigh (uint64): open = low + deltaOpen, etc.
 * Verified live: these ints are 1/100000-scaled like spot quotes (XAUUSD
 * arrives as ~414613000 for ~4146.13). Rule: when every price field is an
 * integer, divide by 100000; pre-flattened doubles pass through untouched.
 * Time comes from utcTimestampInMinutes (minutes → ms).
 */
export function mapTrendbars(payload: unknown): Trendbar[] {
  let raw: unknown = payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.trendbar)) raw = payload.trendbar;
    else if (Array.isArray(payload.trendbars)) raw = payload.trendbars;
  }
  if (!Array.isArray(raw)) return [];
  const out: Trendbar[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const minutes = toNum(item.utcTimestampInMinutes);
    const time =
      minutes !== undefined
        ? minutes * 60_000
        : (toNum(item.timestamp) ?? toNum(item.time) ?? toNum(item.openTimestamp));
    if (time === undefined) continue;
    let open = toNum(item.open);
    let high = toNum(item.high);
    let low = toNum(item.low);
    let close = toNum(item.close);
    let scaled = false;
    if (open === undefined || high === undefined || low === undefined || close === undefined) {
      const base = toNum(item.low);
      const dOpen = toNum(item.deltaOpen);
      const dClose = toNum(item.deltaClose);
      const dHigh = toNum(item.deltaHigh);
      if (base === undefined || dOpen === undefined || dClose === undefined || dHigh === undefined) {
        continue;
      }
      low = base;
      open = base + dOpen;
      close = base + dClose;
      high = base + dHigh;
      scaled = true;
    } else if (
      Number.isInteger(open) &&
      Number.isInteger(high) &&
      Number.isInteger(low) &&
      Number.isInteger(close)
    ) {
      scaled = true;
    }
    if (scaled) {
      open /= 100000;
      high /= 100000;
      low /= 100000;
      close /= 100000;
    }
    const volume = toNum(item.volume);
    out.push(volume === undefined ? { time, open, high, low, close } : { time, open, high, low, close, volume });
  }
  return out;
}

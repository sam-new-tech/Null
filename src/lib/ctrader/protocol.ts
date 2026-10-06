/**
 * cTrader Open API JSON wire protocol.
 * Numbers from the official openapi-proto-messages spec; field names are the
 * camelCase JSON form from the Spotware JSON tutorial.
 */

export const Payload = {
  HeartbeatEvent: 51,
  ApplicationAuthReq: 2100,
  ApplicationAuthRes: 2101,
  AccountAuthReq: 2102,
  AccountAuthRes: 2103,
  TraderReq: 2121,
  TraderRes: 2122,
  TraderUpdatedEvent: 2123,
  ReconcileReq: 2124,
  ReconcileRes: 2125,
  ExecutionEvent: 2126,
  SubscribeSpotsReq: 2127,
  SubscribeSpotsRes: 2128,
  SpotEvent: 2131,
  OrderErrorEvent: 2132,
  DealListReq: 2133,
  DealListRes: 2134,
  ErrorRes: 2142,  GetAccountsByAccessTokenReq: 2149,
  GetAccountsByAccessTokenRes: 2150,
  AccountLogoutReq: 2162,
  AccountLogoutRes: 2163,
  RefreshTokenReq: 2173,
  RefreshTokenRes: 2174,
  SymbolsListReq: 2114,
  SymbolsListRes: 2115,
  GetTrendbarsReq: 2137,
  GetTrendbarsRes: 2138,
} as const;

export const TradeSide = { BUY: 1, SELL: 2 } as const;

export interface WireMessage {
  clientMsgId?: string;
  payloadType: number;
  payload?: Record<string, unknown>;
}

let msgSeq = 0;

export function nextMsgId(): string {
  msgSeq += 1;
  return `null-${Date.now().toString(36)}-${msgSeq}`;
}

export function encode(payloadType: number, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ clientMsgId: nextMsgId(), payloadType, payload });
}

export function decode(raw: string): WireMessage {
  return JSON.parse(raw) as WireMessage;
}

/* ---------------- payload shapes (request side) ---------------- */

export interface AccountInfo {
  ctidTraderAccountId: number;
  isLive?: boolean;
  traderLogin?: number;
  brokerTitleShort?: string;
}

export interface TraderInfo {
  ctidTraderAccountId: number;
  balance: number;
  moneyDigits: number;
  depositAssetId: number;
  leverageInCents?: number;
}

export interface PositionInfo {
  positionId: number;
  tradeData: { symbolId: number; volume: number; tradeSide: number; openTimestamp?: number };
  positionStatus: string;
  swap: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  commission?: number;
  usedMargin?: number;
  moneyDigits?: number;
}

export interface DealInfo {
  dealId: number;
  positionId: number;
  volume: number;
  symbolId: number;
  executionTimestamp: number;
  executionPrice?: number;
  tradeSide: number;
  dealStatus: number;
  closePositionDetail?: {
    entryPrice: number;
    grossProfit: number;
    swap: number;
    commission: number;
    balance: number;
    moneyDigits?: number;
  };
}

export interface SymbolInfo {
  symbolId: number;
  symbolName: string;
  digits: number;
  baseAssetId?: number;
  quoteAssetId?: number;
}

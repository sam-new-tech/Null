import {
  amendPositionSLTP,
  asSide,
  cancelOrder,
  closePosition,
  isCancelRejectedStatus,
  isFilledStatus,
  isOpenPositionStatus,
  isRejectedStatus,
  isRestingOrderStatus,
  mapTrendbars,
  OrderStatus,
  placeLimitOrder,
  placeMarketOrder,
  unitsPerLot,
} from '@/lib/ctrader/orders';

describe('unitsPerLot', () => {
  it('knows metals, crypto and FX', () => {
    expect(unitsPerLot('XAUUSD')).toBe(100);
    expect(unitsPerLot('XAU/USD')).toBe(100);
    expect(unitsPerLot('XAGUSD')).toBe(5000);
    expect(unitsPerLot('BTCUSD')).toBe(1);
    expect(unitsPerLot('EURUSD')).toBe(100000);
  });
});

describe('placeLimitOrder', () => {
  it('builds a LIMIT new-order payload', () => {
    const pair = placeLimitOrder(1, {
      symbolId: 2,
      side: 'buy',
      volumeLots: 0.02,
      limitPrice: 2400,
      takeProfit: 2402,
      stopLoss: 2398,
      label: 'bot',
      unitsPerLot: 100,
    });
    expect(pair).toEqual({
      type: 2106,
      payload: {
        ctidTraderAccountId: 1,
        symbolId: 2,
        orderType: 2,
        tradeSide: 1,
        volume: 200,
        limitPrice: 2400,
        takeProfit: 2402,
        stopLoss: 2398,
        label: 'bot',
      },
    });
  });

  it('maps sell to tradeSide 2 and omits optional fields', () => {
    const { payload } = placeLimitOrder(1, {
      symbolId: 2,
      side: 'sell',
      volumeLots: 0.01,
      limitPrice: 2400,
      unitsPerLot: 100,
    });
    expect(payload.tradeSide).toBe(2);
    expect(payload).not.toHaveProperty('takeProfit');
    expect(payload).not.toHaveProperty('stopLoss');
    expect(payload).not.toHaveProperty('label');
  });

  it('rejects invalid inputs', () => {
    expect(() => placeLimitOrder(0, { symbolId: 1, side: 'buy', volumeLots: 1, limitPrice: 1 })).toThrow(
      'Invalid account id',
    );
    expect(() => placeLimitOrder(1, { symbolId: 0, side: 'buy', volumeLots: 1, limitPrice: 1 })).toThrow(
      'Invalid symbol id',
    );
    expect(() => placeLimitOrder(1, { symbolId: 1, side: 'buy', volumeLots: 1, limitPrice: 0 })).toThrow(
      'Invalid limit price',
    );
    expect(() => placeLimitOrder(1, { symbolId: 1, side: 'buy', volumeLots: 0, limitPrice: 1 })).toThrow(
      'Invalid lots',
    );
  });
});

describe('placeMarketOrder', () => {
  it('builds a MARKET payload with no price', () => {
    const pair = placeMarketOrder(1, {
      symbolId: 3,
      side: 'sell',
      volumeLots: 0.05,
      label: 'x',
      unitsPerLot: 100,
    });
    expect(pair.type).toBe(2106);
    expect(pair.payload).toMatchObject({ orderType: 1, tradeSide: 2, volume: 500, label: 'x' });
    expect(pair.payload).not.toHaveProperty('limitPrice');
  });
});

describe('cancelOrder / closePosition / amendPositionSLTP', () => {
  it('builds a cancel request', () => {
    expect(cancelOrder(1, '42')).toEqual({
      type: 2108,
      payload: { ctidTraderAccountId: 1, orderId: 42 },
    });
  });

  it('closes by raw protocol volume when provided', () => {
    expect(closePosition(1, 7, 1, 100, 12345)).toEqual({
      type: 2111,
      payload: { ctidTraderAccountId: 1, positionId: 7, volume: 12345 },
    });
  });

  it('closes by lots when raw volume is omitted', () => {
    expect(closePosition(1, 7, 0.02, 100).payload.volume).toBe(200);
  });

  it('amends TP/SL with only the provided fields', () => {
    expect(amendPositionSLTP(1, { positionId: 7, takeProfit: 2500 })).toEqual({
      type: 2110,
      payload: { ctidTraderAccountId: 1, positionId: 7, takeProfit: 2500 },
    });
  });
});

describe('response parsers', () => {
  it('parses trade sides defensively', () => {
    expect(asSide(1)).toBe('buy');
    expect(asSide(2)).toBe('sell');
    expect(asSide('BUY')).toBe('buy');
    expect(asSide('SELL')).toBe('sell');
    expect(asSide('1')).toBe('buy');
    expect(asSide('2')).toBe('sell');
    expect(asSide(undefined)).toBe('buy');
  });

  it('normalizes statuses without inventing ghost rows', () => {
    expect(isOpenPositionStatus('POSITION_STATUS_OPEN')).toBe(true);
    expect(isOpenPositionStatus(1)).toBe(true);
    expect(isOpenPositionStatus(undefined)).toBe(false);
    expect(isOpenPositionStatus(0)).toBe(false);

    expect(isRestingOrderStatus(OrderStatus.Accepted)).toBe(true);
    expect(isRestingOrderStatus(2)).toBe(false);

    expect(isFilledStatus('ORDER_STATUS_FILLED')).toBe(true);
    expect(isFilledStatus('2')).toBe(true);
    expect(isRejectedStatus('ORDER_REJECTED')).toBe(true);
    expect(isRejectedStatus(7)).toBe(true);
    expect(isCancelRejectedStatus('ORDER_CANCEL_REJECTED')).toBe(true);
    expect(isCancelRejectedStatus(8)).toBe(true);
  });
});

describe('mapTrendbars', () => {
  it('maps utcTimestampInMinutes and 1e5-scaled delta fields', () => {
    const bars = mapTrendbars({
      trendbar: [
        {
          utcTimestampInMinutes: 100,
          low: 400_000_000,
          deltaOpen: 100_000,
          deltaClose: 200_000,
          deltaHigh: 300_000,
          volume: 5,
        },
      ],
    });
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ time: 6_000_000, open: 4001, high: 4003, low: 4000, close: 4002, volume: 5 });
  });

  it('passes pre-flattened doubles through', () => {
    const bars = mapTrendbars({
      trendbar: [{ timestamp: 1000, open: 1.2, high: 1.5, low: 1.1, close: 1.4 }],
    });
    expect(bars[0]).toEqual({ time: 1000, open: 1.2, high: 1.5, low: 1.1, close: 1.4 });
  });

  it('scales integer OHLC when no deltas are present', () => {
    const bars = mapTrendbars([
      { timestamp: 1000, open: 100_000, high: 150_000, low: 90_000, close: 140_000 },
    ]);
    expect(bars[0]).toEqual({ time: 1000, open: 1, high: 1.5, low: 0.9, close: 1.4 });
  });

  it('accepts the plural field and skips malformed rows', () => {
    const bars = mapTrendbars({
      trendbars: [{}, { timestamp: 1, open: 1, high: 1, low: 1, close: 1 }],
    });
    expect(bars).toHaveLength(1);
  });

  it('returns an empty array for non-array payloads', () => {
    expect(mapTrendbars(null)).toEqual([]);
    expect(mapTrendbars({})).toEqual([]);
  });
});

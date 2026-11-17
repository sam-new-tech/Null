/**
 * Exit-path tests for the momentum bot.
 *
 * These drive the real `BotRunner` exit handlers with a fake live engine so we
 * verify the production wiring, not just the indicator math:
 * - MACD line/signal flip closes every managed position and blocks entries
 *   until the book is flat.
 * - Stochastic divergence closes only the opposite side (bullish -> shorts,
 *   bearish -> longs).
 * - Both exits reuse the 15 s per-position close retry gate.
 * - A confirmed close deal removes the position and plays the exit sound.
 *
 * Indicator detection itself (all four divergence variants, warm-up, gap
 * bounds) is covered in `engine-test.ts`; here `detectStochDivergence` is
 * stubbed where we want to test routing.
 */

import { BotRunner, type ManagedPosition } from '@/lib/bot/runner';
import { liveEngine } from '@/lib/ctrader/live';
import { ensureNotifyPermissions, notify } from '@/lib/notify';
import { calculateIndicators, detectStochDivergence, type StrategyIndicators } from '@/lib/bot/engine';

jest.mock('@/lib/storage', () => ({
  storeGet: jest.fn(async () => null),
  storeSet: jest.fn(async () => undefined),
  storeDel: jest.fn(async () => undefined),
}));

jest.mock('@/lib/notify', () => ({
  notify: jest.fn(async () => undefined),
  ensureNotifyPermissions: jest.fn(async () => undefined),
}));

jest.mock('@/lib/ctrader/live', () => {
  const engine = {
    connected: true,
    getAccountId: jest.fn(() => 7),
    getSnapshot: jest.fn(() => ({
      symbols: new Map([[1, { symbolId: 1, symbolName: 'XAUUSD', digits: 2 }]]),
      positions: [],
      trader: { moneyDigits: 2 },
      deals: [],
    })),
    execSend: jest.fn(),
    execRequest: jest.fn(),
    onEvent: jest.fn(() => () => undefined),
    ensureSpots: jest.fn(),
    accountState: jest.fn(() => ({
      balance: 1000,
      equity: 1000,
      margin: 0,
      freeMargin: 1000,
      marginLevel: 0,
    })),
    getSpot: jest.fn(() => null),
  };
  return { liveEngine: engine, useLive: () => ({}) };
});

jest.mock('@/lib/bot/engine', () => {
  const actual = jest.requireActual('@/lib/bot/engine');
  return {
    ...actual,
    calculateIndicators: jest.fn(actual.calculateIndicators),
    detectStochDivergence: jest.fn(actual.detectStochDivergence),
  };
});

const actualEngine = jest.requireActual('@/lib/bot/engine') as typeof import('@/lib/bot/engine');
const calculateIndicatorsMock = calculateIndicators as unknown as jest.Mock;
const detectStochDivergenceMock = detectStochDivergence as unknown as jest.Mock;

const execSendMock = liveEngine.execSend as jest.Mock;
const notifyMock = notify as jest.Mock;
const ensureNotifyPermissionsMock = ensureNotifyPermissions as jest.Mock;

function position(overrides: Partial<ManagedPosition> = {}): ManagedPosition {
  return {
    id: 101,
    side: 'buy',
    entry: 2000,
    tp: 2002.5,
    volume: 100,
    lots: 0.01,
    openedAt: 0,
    ...overrides,
  };
}

function indicators(overrides: Partial<StrategyIndicators> = {}): StrategyIndicators {
  return {
    ema5m: 2000,
    macdLine: 1,
    macdSignal: 0.5,
    macdHist: 0.5,
    adx: 30,
    vdc: 25,
    ...overrides,
  };
}

interface RunnerInternals {
  persisted: {
    state: 'running' | 'stopped';
    symbol: string;
    symbolId: number;
    digits: number;
    volumeLots: number;
    positions: ManagedPosition[];
    startedAt: number | null;
  };
  currentIndicators: StrategyIndicators;
  bars: unknown[];
  handleMacdExit(): boolean;
  handleStochDivergence(div: { bullish: boolean; bearish: boolean }): boolean;
  handleExecution(payload: Record<string, unknown>): void;
  handleTick(price: number): void;
  evaluateAndTrade(): void;
}

function runnerWith(
  positions: ManagedPosition[],
  overrides: Partial<StrategyIndicators> = {},
): { runner: BotRunner; internals: RunnerInternals } {
  const runner = new BotRunner();
  const internals = runner as unknown as RunnerInternals;
  internals.persisted = {
    ...internals.persisted,
    state: 'running',
    symbol: 'XAUUSD',
    symbolId: 1,
    digits: 2,
    volumeLots: 0.01,
    positions,
    startedAt: Date.now(),
  };
  internals.currentIndicators = indicators(overrides);
  return { runner, internals };
}

/** payloads of close-position requests (2106 = market order, 2111 = close). */
function sent(type: number): Record<string, unknown>[] {
  return execSendMock.mock.calls
    .filter(([payloadType]) => payloadType === type)
    .map(([, payload]) => payload as Record<string, unknown>);
}

const closes = () => sent(2111);
const entries = () => sent(2106);

beforeEach(() => {
  jest.clearAllMocks();
  calculateIndicatorsMock.mockImplementation(actualEngine.calculateIndicators);
  detectStochDivergenceMock.mockImplementation(actualEngine.detectStochDivergence);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MACD directional exit', () => {
  it('closes managed shorts while MACD is bullish', () => {
    const { internals } = runnerWith([
      position({ id: 101, side: 'buy' }),
      position({ id: 102, side: 'sell' }),
    ]);
    internals.currentIndicators = indicators({ macdLine: 1, macdSignal: 0.2 });

    expect(internals.handleMacdExit()).toBe(true);
    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 102, volume: 100 }]);
  });

  it('closes managed longs while MACD is bearish', () => {
    const { internals } = runnerWith([
      position({ id: 201, side: 'buy' }),
      position({ id: 202, side: 'sell' }),
    ]);
    internals.currentIndicators = indicators({ macdLine: 0.2, macdSignal: 1 });

    expect(internals.handleMacdExit()).toBe(true);
    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 201, volume: 100 }]);
  });

  it('closes a restored position on the wrong side immediately (state rule, no cross needed)', () => {
    const { internals } = runnerWith([position({ id: 301, side: 'sell' })]);
    internals.currentIndicators = indicators({ macdLine: 1, macdSignal: 0.2 });

    expect(internals.handleMacdExit()).toBe(true);
    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 301, volume: 100 }]);
  });

  it('leaves positions on the matching side untouched', () => {
    const { internals } = runnerWith([position({ id: 401, side: 'buy' })]);
    internals.currentIndicators = indicators({ macdLine: 1, macdSignal: 0.2 });

    expect(internals.handleMacdExit()).toBe(false);
    expect(closes()).toEqual([]);
  });

  it('does nothing on flat or warming-up reads', () => {
    const { internals } = runnerWith([
      position({ id: 501, side: 'buy' }),
      position({ id: 502, side: 'sell' }),
    ]);
    internals.currentIndicators = indicators({ macdLine: 1, macdSignal: 1 });
    expect(internals.handleMacdExit()).toBe(false);

    internals.currentIndicators = indicators({ macdLine: null, macdSignal: null });
    expect(internals.handleMacdExit()).toBe(false);
    expect(closes()).toEqual([]);
  });

  it('runs before entries and blocks the burst while a mismatched side is open', () => {
    calculateIndicatorsMock.mockReturnValue([
      indicators({ macdLine: 1, macdSignal: 0.5, ema5m: 1990, adx: 30, vdc: 25 }),
    ]);
    detectStochDivergenceMock.mockReturnValue({ bullish: false, bearish: false });
    const { internals } = runnerWith([position({ id: 601, side: 'sell' })]);
    internals.bars = [{ time: 60_000, open: 2000, high: 2001, low: 1999, close: 2000, volume: 1 }];

    internals.evaluateAndTrade();

    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 601, volume: 100 }]);
    expect(entries()).toEqual([]);
    // MACD exit short-circuits the rest of the bar evaluation.
    expect(detectStochDivergenceMock).not.toHaveBeenCalled();
  });

  it('lets the entry burst through on the next bar once the wrong side is flat', () => {
    calculateIndicatorsMock.mockReturnValue([
      indicators({ macdLine: 1, macdSignal: 0.5, ema5m: 1990, adx: 30, vdc: 25 }),
    ]);
    detectStochDivergenceMock.mockReturnValue({ bullish: false, bearish: false });
    const { internals } = runnerWith([]);
    internals.bars = [{ time: 60_000, open: 2000, high: 2001, low: 1999, close: 2000, volume: 1 }];

    internals.evaluateAndTrade();

    expect(closes()).toEqual([]);
    expect(entries().length).toBeGreaterThan(0);
  });

  it('retries an unconfirmed close only after the 15 s gate', () => {
    jest.useFakeTimers();
    const { internals } = runnerWith([position({ id: 701, side: 'sell' })]);
    internals.currentIndicators = indicators({ macdLine: 1, macdSignal: 0.2 });

    expect(internals.handleMacdExit()).toBe(true);
    expect(closes()).toHaveLength(1);

    expect(internals.handleMacdExit()).toBe(true);
    expect(closes()).toHaveLength(1);

    jest.advanceTimersByTime(15_001);
    expect(internals.handleMacdExit()).toBe(true);
    expect(closes()).toHaveLength(2);
  });
});

describe('Stochastic divergence exit', () => {
  it('closes managed shorts on a bullish divergence', () => {
    const { internals } = runnerWith([
      position({ id: 101, side: 'buy' }),
      position({ id: 102, side: 'sell' }),
    ]);

    expect(internals.handleStochDivergence({ bullish: true, bearish: false })).toBe(true);
    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 102, volume: 100 }]);
  });

  it('closes managed longs on a bearish divergence', () => {
    const { internals } = runnerWith([
      position({ id: 201, side: 'buy' }),
      position({ id: 202, side: 'sell' }),
    ]);

    expect(internals.handleStochDivergence({ bullish: false, bearish: true })).toBe(true);
    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 201, volume: 100 }]);
  });

  it('handles both flags in one bar', () => {
    const { internals } = runnerWith([
      position({ id: 301, side: 'buy' }),
      position({ id: 302, side: 'sell' }),
    ]);

    expect(internals.handleStochDivergence({ bullish: true, bearish: true })).toBe(true);
    expect(closes().map((c) => c.positionId).sort()).toEqual([301, 302]);
  });

  it('does nothing without a divergence', () => {
    const { internals } = runnerWith([position()]);

    expect(internals.handleStochDivergence({ bullish: false, bearish: false })).toBe(false);
    expect(closes()).toEqual([]);
  });

  it('still reports the confirming bar even with no matching side (entries wait)', () => {
    const { internals } = runnerWith([position({ side: 'buy' })]);

    // Bullish divergence only closes shorts; the long stays and entries wait.
    expect(internals.handleStochDivergence({ bullish: true, bearish: false })).toBe(true);
    expect(closes()).toEqual([]);
  });

  it('routes a bearish divergence from evaluateAndTrade into long closes', () => {
    calculateIndicatorsMock.mockReturnValue([indicators({ macdLine: 1, macdSignal: 0.5 })]);
    detectStochDivergenceMock.mockReturnValue({ bullish: false, bearish: true });
    const { internals } = runnerWith([position({ id: 401, side: 'buy' })]);
    internals.bars = [{ time: 60_000, open: 2000, high: 2001, low: 1999, close: 2000, volume: 1 }];

    internals.evaluateAndTrade();

    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 401, volume: 100 }]);
    expect(entries()).toEqual([]);
  });
});

describe('close retry gate', () => {
  it('does not resend an exit within 15s, then retries', () => {
    jest.useFakeTimers();
    const { internals } = runnerWith([position({ id: 501, side: 'sell' })]);

    expect(internals.handleStochDivergence({ bullish: true, bearish: false })).toBe(true);
    expect(closes()).toHaveLength(1);

    // Same bar, immediate reconsideration: still gated.
    internals.handleStochDivergence({ bullish: true, bearish: false });
    expect(closes()).toHaveLength(1);

    jest.advanceTimersByTime(15_001);
    internals.handleStochDivergence({ bullish: true, bearish: false });
    expect(closes()).toHaveLength(2);
  });

  it('applies the same gate to the tick-based take-profit exit', () => {
    jest.useFakeTimers();
    const { internals } = runnerWith([position({ id: 601, side: 'buy', tp: 2002.5 })]);

    internals.handleTick(2003);
    expect(closes()).toEqual([{ ctidTraderAccountId: 7, positionId: 601, volume: 100 }]);

    internals.handleTick(2003);
    expect(closes()).toHaveLength(1);

    jest.advanceTimersByTime(15_001);
    internals.handleTick(2003);
    expect(closes()).toHaveLength(2);
  });
});

describe('close confirmation', () => {
  it('removes the managed position and plays the exit sound on the close deal', () => {
    const { internals } = runnerWith([position({ id: 701 })]);

    internals.handleExecution({
      deal: {
        positionId: 701,
        closePositionDetail: { grossProfit: 250, moneyDigits: 2 },
      },
    });

    expect(internals.persisted.positions).toEqual([]);
    expect(notifyMock).toHaveBeenCalledWith(
      'Bot closed',
      expect.stringContaining('+$2.50'),
      'exit',
    );
  });

  it('plays the entry sound when a bot order fills', () => {
    jest.useFakeTimers();
    const { internals } = runnerWith([]);

    internals.handleExecution({
      executionType: 'ORDER_FILLED',
      deal: { positionId: 901, executionPrice: 2000.5, volume: 100, tradeSide: 1 },
      position: { positionId: 901 },
    });

    expect(internals.persisted.positions).toHaveLength(1);
    expect(notifyMock).toHaveBeenCalledWith(
      'Bot filled',
      expect.stringContaining('BUY XAUUSD @ 2000.50'),
      'entry',
    );
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('does not alert on a fill it already manages', () => {
    const { internals } = runnerWith([position({ id: 902 })]);

    internals.handleExecution({
      executionType: 'ORDER_FILLED',
      deal: { positionId: 902, executionPrice: 2000.5, volume: 100, tradeSide: 1 },
      position: { positionId: 902 },
    });

    expect(internals.persisted.positions).toHaveLength(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('ignores a close deal for a position it does not manage', () => {
    const { internals } = runnerWith([position({ id: 801 })]);

    internals.handleExecution({
      deal: { positionId: 999, closePositionDetail: { grossProfit: 100, moneyDigits: 2 } },
    });

    expect(internals.persisted.positions).toHaveLength(1);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe('notification permissions', () => {
  it('requests notification permission when resuming a running bot', async () => {
    jest.useFakeTimers();
    const { runner } = runnerWith([]);

    await runner.resume();

    expect(ensureNotifyPermissionsMock).toHaveBeenCalled();
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

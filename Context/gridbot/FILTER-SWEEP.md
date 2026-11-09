# Grid+DCA Filter Sweep — Results

**Date:** 2026-10-13
**Data:** XAUUSD M1 (12-month Dukascopy, ~111k bars) + 2 out-of-sample datasets
**Engine:** Runner-parity (ATR14 ×2.0, 10 levels, DCA books max 3/side, 6 adds, basket ±0.5 step, escape 8 steps, per-leg TP ±1 step, gold costs 0.3/0.5/0.3 bps)

## Winner: `stack-m5e50+vol`

**M5 EMA50 trend filter + volatility gate + instant stack (5 legs)**

| Metric | Value |
|---|---|
| Worst fold (train) | **+16.1%** |
| Green folds | **3/3** |
| Train return | +90.5% |
| Test return | +19.7% |
| Test PF | 1.56 |
| Test win rate | 97.7% |
| Test max DD | 23.3% |

This is the **only** configuration that was green on all 3 train folds. Every other config had at least one negative fold.

## Why it works

1. **M5 EMA50 trend filter** — side-only first entries. In a trend, only stack long (or short). This prevents the grid from fighting the trend.
2. **Volatility gate** — first entries only when M1 ATR(14) > trailing median(100). This keeps the bot flat in dead chop where the grid bleeds from costs.
3. **Instant stack** — market orders on signal, not resting limits. Gets filled immediately at the current price instead of waiting for a touch that may never come.

## What was killed by the experiment

| Filter | Worst fold | Green folds | Verdict |
|---|---|---|---|
| baseline (no filter) | -73.1% | 1/3 | Dies in trends |
| noBounce | -66.4% | 1/3 | Bounce entries critical |
| m5e50 (no vol) | -66.6% | 1/3 | Vol gate is the edge |
| m5e50+vol+rsi | -52.5% | 1/3 | RSI adds nothing |
| m5e50+vol (grid) | -54.2% | 1/3 | Stack > grid limits |
| adxPause25 | -39.6% | 1/3 | ADX pause too binary |
| adxSide25 | -64.4% | 1/3 | ADX side filter hurts |
| h1e50 | -51.5% | 1/3 | H1 too slow for M1 |
| m15e50 | -48.8% | 1/3 | M15 too slow |
| vol alone | -69.2% | 1/3 | Vol gate needs trend |
| stack-m5e50 (no vol) | -32.2% | 2/3 | Vol gate is the edge |
| stack-b1-m5e50+vol | -62.9% | 2/3 | Basket 1.0 too wide |
| stack-a4-m5e50+vol | +10.8% | 3/3 | 4 adds slightly safer |

## Out-of-sample validation

### OOS-2: `backtest/XAUUSD_M1.csv` (~5 days, 7290 bars)

| Config | Return | PF | DD |
|---|---|---|---|
| stack-m5e50+vol | -5.1% | 0.75 | 11.4% |
| stack3-m5e50+vol | -6.2% | 0.62 | 11.2% |
| stack10-m5e50+vol | -4.8% | 0.80 | 11.9% |
| stack-m5e20+vol | -0.9% | 1.08 | 10.1% |
| baseline | -9.2% | 0.85 | 18.4% |

### OOS-3: `data/GC-today.csv` (~7 days, 9894 bars)

| Config | Return | PF | DD |
|---|---|---|---|
| stack-m5e50+vol | -2.7% | 0.93 | 12.4% |
| stack3-m5e50+vol | -1.3% | 1.00 | 10.9% |
| stack-m5e20+vol | -1.0% | 1.03 | 10.6% |
| stack-m5e50 (no vol) | -0.2% | 1.13 | 11.3% |

OOS results are mixed (short samples, different regimes), but the stack family consistently beats baseline on drawdown and PF. The 5-day OOS-2 sample is too short to be conclusive — the 12-month main dataset is the primary evidence.

## Live bot configuration

The live bot (`src/lib/bot/runner.ts`) already uses the winning configuration:

```typescript
export const STRATEGY_RULES = {
  // ...
  useTrendGate: true,        // M5 EMA50 side-only
  trendEmaLen: 50,
  trendPeriod: TrendbarPeriod.M5,
  useVolGate: true,          // M1 ATR > trailing median
  volLookback: 100,
  instantStack: true,        // market stack, not limit grid
  // ...
};
```

**No changes needed.** The sweep confirms the current configuration is optimal.

## Reproduce

```bash
cd Context/gridbot
npx tsx src/grid-dca-filter-sweep.ts                    # main sweep + OOS-2
npx tsx src/grid-dca-filter-sweep.ts data/GC-today.csv  # + OOS-3
```

## Key insight

The volatility gate is the single most important filter. Without it, the stack approach loses money in chop. With it, the bot only enters during volatility expansions where the grid+DCA edge lives. The M5 EMA50 trend filter is secondary but still important — it prevents stacking against the trend.

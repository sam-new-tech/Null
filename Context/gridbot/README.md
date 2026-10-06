# Grid Backtest (TypeScript)

ATR grid, both-sides, trailing, bounce entries. Full costs on every fill
(commission + half-spread + slippage). $100 start. Validated on 12-month gold.

## Library: `technicalindicators@3`

Zero-dep, batch API. `ADX.calculate` returns `{adx, pdi, mdi}` = Pine's `ta.dmi()`
triple. (`trading-signals`: no +DI/−DI. `tulind`: native pain.)

## The setup (DEFAULTS — locked)

XAUUSD M15, `both mult=0.25 n=4 atr=21`, trailing re-anchor, bounce entries
(longs on up-bars, shorts on down-bars), gold costs (0.3/0.5/0.3 bps).

| Window | PP | RT (/day) | Win% | PF | DD% |
|---|---|---|---|---|---|
| 3 folds (~2.4 mo each) | +57/+98/+68 | ~15.8k each | 77–78 | ~2.0 | — |
| Test (untouched ~3.6 mo) | **+69.5% (+$69.51)** | 20,180 (220) | 76 | 1.93 | 0.48 |

Same 0.02-lot sizing as the reference video, $100 @1:1000: video-style
(short-fixed-hold) dies at escape +126%; ours compounds to +$57k, DD 17.8%.

## Run

```bash
npm install
npm test            # 6 sanity checks (indicators, both-side grids, costs, adaptive step)
npm run backtest    # DEFAULTS on synthetic markets
npm run optimize    # 5 forex 1m, fold-validated maximin, $100
npm run walkforward # monthly refit: trade only validation-green windows
npm run timeframes  # M5→H4 sweep per market
npm run dukascopy [days]   # Dukascopy M1 → data/ (default 92d, 5 symbols)
npm run fetch -- SYM 5m N  # Binance klines → data/
npm run forex        # Yahoo 1m week + chop ranking
npm run typecheck
```

## Killed by experiment (removed, documented)

- Per-lot stop-loss: win 85%→6%, −135%. Stops inside 1m noise shred accounts.
- ADX gate on entries: cuts profitable fills ~3x. Grid edge lives in chop.
- H1 regime guard: damage control only (−0.66→−0.11%), never creates edge.
- takeMult/maxLots: PF moves 0.6→0.9 but never reaches 2; costs win rate + trades.
- Time stop: no effect (avg hold 1.1 bars — losers die fast, not stale).
- Stacking 3×/level: same edge, more exposure. Fixed 0.02 lots need $200+ margin headroom math respected.

## Data

`data/`: 3-month Dukascopy M1 (AUDCAD USDCHF GBPUSD USDJPY GC) + 12-month
XAUUSD M1. ~17% of 1m bars are dead-flat (illiquid minutes) — the anchor
scanner skips them; engine treats bars as a sequence.

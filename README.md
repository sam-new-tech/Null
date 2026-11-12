# Null

A mobile cTrader client and automated XAU/USD trading bot built with
Expo SDK 57 and React Native. It connects to the cTrader Open API over a
single WebSocket, streams positions, orders and deals in realtime, and can
run a 1-minute momentum strategy unattended. When no cTrader credentials are
configured the app runs on a live-shaped mock feed so every screen stays
usable.

> Trading involves risk. This app is not financial advice, and the strategy
> is provided as-is. Test on a demo account before using real funds.

## Strategy (what ships)

- Instrument: XAU/USD, 1-minute bars.
- Filters: 5-minute EMA(50) resampled from 1-minute closes, ADX(14) > 20, and
  Volume Delta Control(14) with candle split (buyers ≥ +20%, sellers ≤ −20%).
- Entries: long when price > EMA, ADX > 20 and VDC is in the buyers zone;
  short on the mirror condition (price < EMA, VDC ≤ −20%).
- Exit: every entry gets a fixed **$2.50** take profit measured from the live
  price at entry (buy = live + 2.50, sell = live − 2.50). The TP is pushed to
  the broker and retried until it is confirmed. There is **no stop loss**.
  Multiple managed positions can run at once.
- Sizing: fixed 0.01 lots per signal. Concurrent position slots =
  `floor(equity / $20)` (rounded down to a whole number).

The grid/DCA experiments under `Context/gridbot` are a separate, legacy
research sandbox and do **not** describe the shipped strategy.

## Requirements

- Node 20+ and npm (the repo uses `package-lock.json`).
- Expo Go for UI-only work; a development build once native modules are
  involved (`expo-secure-store`, `expo-notifications`, background tasks).
- A cTrader Open API application (client id/secret) for live data.

## Setup

```bash
npm install
cp .env.example .env.local     # fill in your cTrader + license values
npx expo start                 # or: npx expo run:ios / run:android
```

Environment variables are documented in `.env.example`. `EXPO_PUBLIC_*`
values are embedded in the app bundle; web login additionally needs the
server token proxy (`web.output: "server"`) or
`EXPO_PUBLIC_CTRADER_TOKEN_PROXY_URL`.

## Commands

```bash
npm start            # Expo dev server
npm run android      # local Android development build
npm run ios          # local iOS development build
npm run web          # web dev server
npm run lint         # expo lint
npm run typecheck    # tsc --noEmit
npm test             # Jest (jest-expo)
npm run test:watch   # Jest in watch mode
npx expo-doctor      # dependency/config health
```

Prefer `npx expo install <pkg>` over `npm install <pkg>` for Expo-managed
packages. `ios/` and `android/` are CNG-generated; configure native
behaviour in `app.json` and never edit those directories by hand.

## Project layout

```
src/
  app/                 Expo Router routes (auth, tabs, license)
  components/          shared UI atoms and screen sections
  constants/           theme, tabs, reference market data
  context/             auth provider
  hooks/               mock account feed, pull-to-refresh
  lib/
    bot/               momentum engine, runner, background task
    ctrader/           client, protocol, orders, wire helpers, live engine
    trading/           domain types + useTrading data source
    format.ts          display formatters
    license.ts         device-bound license activation
    storage.ts         SecureStore / localStorage / memory store
__tests__/             Jest unit tests for pure seams
docs/                  refactor spec and engineering best practices
Context/gridbot/       legacy grid/DCA research sandbox (own typecheck)
scripts/               license minting and project reset helpers
```

## Testing

The suite covers indicator math, order payloads and response parsers,
trendbar mapping, wire scaling and formatting:

```bash
npm test -- --ci
```

Run `cd Context/gridbot && npx tsc --noEmit && npm test` if you touch the
research sandbox.

## Documentation

- `docs/qa-refactor-spec.md` — requirements and acceptance criteria for the
  quality pass.
- `docs/best-practices.md` — stack-specific engineering checklist with
  versioned Expo links.

## License

See `LICENSE`.

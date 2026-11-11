# Feature Verification — Null

Status: complete for this pass
Branch: `qa/refactor`
Method: each user-facing feature was traced from UI → hook/lib → broker request/listener,
then checked against its stated intent. Pure logic is covered by Jest; broker-round-trip
paths are verified by code inspection plus the manual checks listed in `docs/qa-report.md`.

Legend: **Verified** = behaves as intended · **Fixed** = mismatch found and corrected ·
**Partial** = works only with an external dependency or documented limitation.

## 1. Onboarding, licensing and session

| Feature | Intended behaviour | Verdict | Evidence / gap |
|---|---|---|---|
| License gate | Unlicensed users only see the activation screen; licensed users reach login/tabs | Verified | `app/_layout.tsx` renders `LicenseScreen` directly while `!licensed`; `useLicense` re-verifies on launch |
| License activation | Minted `NULL-XXXX-XXXX-XXXX` key binds to this device and is re-checked every launch | Fixed | `lib/license.ts`: format now validated (`/^NULL[A-Z0-9]{12}$/`), device id uses `Crypto.getRandomBytes` instead of `Math.random`; tests in `license-test.ts` |
| License portability | Same key on another device is rejected | Partial | Local hash binding works, but validation is client-side only and the pepper ships in the app. Real enforcement needs a server; documented residual risk |
| Native cTrader login | Open grant page, user pastes the returned `?code=` link | Verified | `config.ts` `NEEDS_MANUAL_LINK`, `login.tsx` paste parser, `auth.completeWithCode` → `exchangeCode` |
| Web cTrader login | Hosted callback posts the session back | Partial | `auth.tsx` listens for `ctrader-oauth` from the same origin; requires a hosted callback page (not in this repo) or the paste field |
| Demo mode | Unconfigured build still opens every screen | Verified | `auth.login` marks connected without live engine; `useTrading` falls back to mock |
| Session restore | Stored session reconnects silently at launch | Verified | `auth.tsx` restore effect; `liveEngine.start` re-auths and rotates tokens |
| Token refresh | Expiring tokens rotate and persist | Verified | `refreshSession()` in `live.ts`, single helper reused by restore and scheduled refresh |
| Logout | Stop bot, unregister background task, wipe session | Verified | `auth.logout` calls `botRunner.stop()`, `unregisterGridTask()`, `liveEngine.stop()`, `clearSession()` |

## 2. Market data and screens

| Feature | Intended behaviour | Verdict | Evidence / gap |
|---|---|---|---|
| Connection banner | Warn only when a connection is expected and unhealthy | Fixed | `lib/connection-status.ts` + `connection-banner.tsx`: demo (`idle`) is silent, closed socket and stale stream warn, initial connect says "Connecting to cTrader…"; 3 tests |
| Home dashboard | Account, live positions and daily summary share one data source | Verified | `useTrading()` returns identical shapes for live/mock; `index.tsx` consumes account/stats/positions |
| Positions list | Show side, lots, P/L, open/TP/SL | Verified | `positions-card.tsx`; price digits from `decimalsForSymbol` |
| Close one position | Send full close, confirm via ExecutionEvent, reconcile | Verified | `positions-card.tsx` echoes `rawVolume` and waits ≤10 s for the matching close deal, then refreshes |
| Trades — positions | List live positions and offer "Close all" only when positions exist | Fixed | `trades.tsx`; close-all button now hidden with zero positions |
| Trades — close all | Close **every** live position, not just the bot's | Fixed | `lib/trading/actions.ts` `closePositions()`; 3 tests |
| Trades — orders | List resting orders and offer "Cancel all" | Verified | Orders tab renders only when `orders.length > 0` |
| Trades — cancel all | Cancel **every** resting order | Fixed | `actions.ts` `cancelOrders()` sends one `cancelOrder` (2108) per row; 2 tests |
| History | Closed trades, P/L total, pagination | Verified | `history.tsx`; rows derive from `closePositionDetail` with `moneyDigits` scaling in `useTrading` |
| Pull-to-refresh | Re-snapshot live data, surface errors, no double-trigger | Verified | `useRefresh`; `liveEngine.refresh()` is a no-op in demo by design |
| Demo feed | Flat start, opens/closes positions, display-compatible volumes | Fixed | `use-mock-account.ts` now derives `rawVolume` from `volume × unitsPerLot × 100` (was a constant 100) |
| Weekend warning | Warn that broker confirmations wait for the open | Verified | `market-hours.ts`; used in Trades and Bot dialogs. Public holidays are not modelled (gap) |

## 3. Momentum bot

| Feature | Intended behaviour | Verdict | Evidence / gap |
|---|---|---|---|
| Arm gate | Start only with a ready live account | Verified | `bot.tsx` disables Start unless `live.status === 'ready'`; start re-checks engine connection |
| Lot sizing | Fixed 0.01 lots per signal | Verified | `BOT_LOT_SIZE` + test; every order sends exactly 0.01 |
| Position slots | `floor(equity / 20)` concurrent managed positions, integer | Verified | `maxOpenPositions()` + tests (753.14 → 37, 19.99 → 0); start dialog shows the cap |
| Stoch trend tile | Bot screen shows StochRSI direction: BULLISH / BEARISH / FLAT, or NEUTRAL when K or D is at/beyond 80 or 20 | Verified (manual) | `stochTrend()` in `engine.ts` shared with the entry rule; tile maps it in `bot.tsx`. The numeric K/D tile was removed by request. Manual: K 85/D 70 → NEUTRAL, K 60/D 50 → BULLISH, K 40/D 55 → BEARISH |
| Bot screen layout | Status tiles plus Stop; no Strategy Activity feed | Verified (manual) | Activity card removed from `bot.tsx` by request; the runner still records `status.logs` for diagnostics |
| Indicators | 5m EMA(50) resampled, 1m Stochastic RSI/ADX, 1m Volume Delta Control(14) | Verified | `engine.ts`; tests cover EMA alignment, StochRSI warm-up (RSI 14 → stoch 27 → K 35 → D 37) and 0–100 bounds, VDC candle/range math, the 14-bar lookback and ±20 bands, signal gating |
| Signal rules | Long/short require price vs EMA, StochRSI K vs D inside 20–80, ADX > 20 and VDC ≥ +20% / ≤ −20%; each qualifying bar may add one 0.01-lot position until the slot cap | Verified | `evaluateSignal` + tests (overbought/oversold → neutral, ADX 20 boundary, VDC ±20 boundaries, no entry); `evaluateAndTrade` enforces `maxOpenPositions` |
| VDC tile | Bot screen shows the VDC(14) control percentage, coloured green (buyers), red (sellers) or neutral | Verified (manual) | `calculateVDC()` + `vdcControl()` in `engine.ts` shared with the entry rule; tile renders `formatVdc`/`vdcClass` in `bot.tsx` |
| History warm-up | Fetch enough bars for EMA50 and warn when still warming | Verified | `BAR_COUNT = 600`, `MIN_BARS`, explicit error log |
| Fill handling | Recognise both order status and execution-event names; size from broker volume | Fixed | `isFilledStatus` now accepts `ORDER_FILLED`; `ORDER_STATUS_FILLED`/numeric still work; test added |
| Take profit size | Every entry gets TP = live price ± $2.50 | Verified | `takeProfitFor()` in `engine.ts` + tests; the runner anchors it to the live tick (fill price only as fallback) and rounds to symbol digits; no stop loss is ever sent |
| Broker TP safety net | Amend position with TP after fill, retry until confirmed | Verified | `applyBrokerTakeProfit` sends `amendPositionSLTP` (no SL), re-checks the broker position every 3 s up to 4 attempts; a 60 s sync also re-applies TP to any managed position missing one |
| Client TP exit | Close each position at TP, retry if no confirmation | Fixed | Per-position retry map (`CLOSE_RETRY_MS`, 15 s); closes every position whose TP is hit |
| Close P/L log | Respect `moneyDigits` | Fixed | `runner.handleExecution` uses shared `money()` with `closePositionDetail.moneyDigits` |
| Stop bot | Detach events, clear timer, close all managed positions, persist stopped | Verified | `stopAll()` loops every managed position; manual trades stay |
| Restart resume | A persisted `running` bot reattaches after relaunch/reconnect | Fixed | `BotRunner.resume()/resumeIfRunning()` reattaches events, ensures spots, restarts the 60 s timer and resyncs; called from `auth` restore/adopt and `bot.tsx` when the account becomes ready |
| Background tick | Periodic reconcile while backgrounded | Partial | `background.ts` registers an OS task (~15 min minimum); foreground stream is the realtime path. OS throttling is documented |
| Notifications | Notify on fills/closes | Fixed | `notify.ts` was dead code; now called on fill/close and permissions are requested on start. Best-effort and disabled in Expo Go/web |
| Activity log | Show recent strategy events | Verified | `runner.log()` persists the last 100 entries; `bot.tsx` renders the last 5 |
| Dead status fields | Do not expose controls/fields that can never change | Fixed | Removed `coolingDown` (permanent false banner) and `restingCount` (always 0) |

## 4. Infrastructure

| Feature | Intended behaviour | Verdict | Evidence / gap |
|---|---|---|---|
| Order builders | Correct payload types, sides, volumes, optionals | Verified | `orders-test.ts` covers limit/market/cancel/close/amend and invalid inputs |
| Status parsers | Never invent ghost positions/orders | Verified | `isOpenPositionStatus`, `isRestingOrderStatus`, `isFilledStatus`, rejection parsers + tests |
| Trendbar mapping | Handle delta fields, 1e5 scaling, pre-flattened doubles | Verified | `mapTrendbars` + tests |
| Symbol mapping | XAU/XAG/BTC/FX units per lot | Verified | `unitsPerLot` + tests; single source used by bot and bulk actions |
| Formatting | Signed money, plain money, symbol-aware prices, lots | Verified | `format-test.ts` |
| Tabs/navigation | Four tabs, auth redirects settle once | Verified | Expo Router `(tabs)` layout; `AuthGuard` de-dupes replaces |
| Research sandbox | Legacy grid scripts compile but are clearly not the shipped strategy | Verified | `legacy-app-engine.ts`, gridbot typecheck + 6 checks, README labels it legacy |

## 5. Verification commands

```bash
npm test -- --ci        # 8 suites, 79 tests
npx tsc --noEmit
npx expo lint
npx expo-doctor
cd Context/gridbot && npx tsc --noEmit && npm test
```

## 6. Known gaps (accepted)

1. **License enforcement is client-side.** A shared key is stopped by the device
   binding only until someone patches the app; server validation is the real fix.
2. **Web login needs an external callback page.** Without it the paste flow works.
3. **Holidays are not modelled** — only Saturday/Sunday market closure.
4. **Background execution is best-effort** (~15 min OS minimum); broker-side TP is
   the safety net.
5. **No component/E2E suite yet** — pure logic is covered; manual smoke checks are
   listed in `docs/qa-report.md`.
6. **Slot cap is a count, not a margin check.** `floor(equity / 20)` can allow
   more 0.01-lot positions than free margin supports at low leverage; the broker
   will reject the excess orders. A margin-aware cap is a future hardening step.

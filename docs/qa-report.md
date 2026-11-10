# QA Report — refactor and quality pass

Status: complete
Branch: `qa/refactor`
Baseline: `521f9bd` on `master`
Spec: `docs/qa-refactor-spec.md`

## What changed

| Commit | Concern |
|---|---|
| `b09c5ff` | `chore(deps)`: aligned 10 Expo SDK 57 packages via `expo install --fix`; added `jest-expo`/`jest`/`@types/jest`, `test`/`test:watch`/`typecheck` scripts, coverage ignore. |
| `98e07e9` | `refactor(lib)`: extracted pure formatters (`format.ts`), trading types (`trading/types.ts`) and cTrader wire helpers (`ctrader/wire.ts`); removed the duplicated helpers from the mock hook and live engine. |
| `0ae5fbf` | `test`: jest-expo harness plus 47 tests for wire scaling, formatters, order payloads/parsers, trendbar mapping and indicator math; added the QA spec. |
| `dd2cdb4` | `refactor(app)`: shared `SideLabel`, `EmptyCard`, `useRefresh`, `isWeekendMarketClosed`, `formatIndicator`; fixed malformed formatting and JSX indentation; guarded positions-card early returns; widened indicator period types; typed Jest globals in tsconfig. |
| `30528ef` | `refactor(ctrader)`: single `refreshSession()` token-rotation helper, single `toSymbolInfo()` mapper, single `adoptSession()` auth step. |
| `c049fd3` | `fix(research)`: archived the removed grid engine as `legacy-app-engine.ts`, repointed the three stale scripts, fixed the stray `x` and the boolean row type. |
| `6867b02` | `fix`: feature-verification pass — bulk close/cancel actions, banner state, bot resume, `ORDER_FILLED` fills, `moneyDigits` P/L, TP-close retry, notification wiring, mock volume, license key/randomness. |
| `78e69be` | `feat(bot)`: fixed 0.01-lot sizing and `floor(equity / 20)` concurrent position slots; multi-position fills, TPs and stop handling. |
| `cc5300f` | `feat(bot)`: TradingView-style Stochastic RSI (K 9, D 3, RSI 14, Stoch 14) replaces MACD; status tile and warm-up tests updated. |
| `f633cae` | `feat(bot)`: bot screen now shows the StochRSI K-vs-D trend (BULLISH/BEARISH/FLAT) in place of the position count. |
| `c297a21` | `feat(bot)`: removed the K/D value tile and lowered the ADX(14) filter to strictly above 20. |
| `1ff2ea9` | `revert(bot)`: restored the ADX(14) filter to strictly above 25 before the preview build. |
| `8610650` | `feat(bot)`: StochRSI trend (and entries) become NEUTRAL while K or D is overbought/oversold (≥ 80 or ≤ 20). |
| `465ee9a` | `feat(bot)`: removed the Strategy Activity feed from the bot screen. |

Documentation: replaced the stock Expo README, added
`docs/best-practices.md`, and labelled the grid sandbox + filter-sweep
results as legacy.

## Evidence

| Check | Command | Result |
|---|---|---|
| App typecheck | `npx tsc --noEmit` | pass |
| Lint | `npx expo lint` | pass |
| Unit tests | `npm test -- --ci` | 8 suites, 72 tests pass |
| Dependency/config health | `npx expo-doctor` | 21/21 checks pass |
| Research typecheck | `cd Context/gridbot && npx tsc --noEmit` | pass |
| Research sanity | `cd Context/gridbot && npm test` | 6/6 checks pass |
| Research runtime | `cd Context/gridbot && npx tsx src/app-sim.ts` | runs, produces train/test results |

## Requirement traceability

- **R1 dependency alignment** — done; doctor is clean.
- **R2 project boundaries** — `Context/**` stays excluded from the app
  typecheck; gridbot has its own passing typecheck. No suppressions added.
- **R3 pure utilities** — formatters, types and wire helpers extracted and
  imported by call sites; no behavior change.
- **R4 test harness** — jest-expo configured; pure seams covered.
- **R5 app readability** — duplicated UI/hook/formatting logic consolidated,
  formatting defects fixed, auth/live/positions duplication reduced.
- **R6 research consistency** — legacy engine isolated and labelled; scripts
  compile and one full simulator run was exercised.
- **R7 review standard** — commits split by concern; no mixed reformatting.
- **R8 documentation** — README, best practices, spec and QA report present.

## Residual risks and follow-ups

1. **Manual smoke tests still required.** Jest covers pure logic, not the RN
   runtime. Before release verify: login/deep-link flows, bot start/stop,
   TP amend and close confirmation, pull-to-refresh, license activation and
   relaunch re-verification.
2. **Bulk trade actions were fixed.** Trades → "Close all"/"Cancel all" now
   send one request per row through `lib/trading/actions.ts` (previously only
   the bot-managed position closed and order cancellation was a no-op). See
   `docs/feature-verification.md`.
3. **No component/E2E tests yet.** Recommended next step: React Native
   Testing Library for the row/dialog components and Maestro for the login →
   bot → close flow.
4. **Dependency advisories.** `npm audit` still reports transitive
   advisories (11 moderate, 4 high at last install). Do not run
   `npm audit fix --force`; triage per package instead.
5. **Client secret is bundled.** Spotware requires the secret for app-auth,
   so `EXPO_PUBLIC_CTRADER_CLIENT_SECRET` ships in the binary. The server
   token proxy exists for web; moving native token exchange behind a backend
   remains the hardening step.
6. **Dead template UI.** `AnimatedIcon` (native/web) is exported but unused;
   `Spacing`/`BottomTabInset`/`MaxContentWidth` in `constants/theme.ts` are
   also unused. Harmless, left for a separate cleanup.
7. **No CI workflow committed.** The four commands above should run in CI;
   adding `.github/workflows/ci.yml` is the next infrastructure step.
8. **Research results are stale by design.** Grid/filter findings no longer
   describe the shipped momentum strategy; they are clearly labelled legacy.

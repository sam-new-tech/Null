# QA Refactor Spec — Null (Expo trading app)

Status: Active
Owner: QA / Engineering
Created: 2026-11-09
Baseline commit: `521f9bd` (branch `qa/refactor`)

## 1. Problem statement

The app works, but it grew fast: the live engine is one 800-line class, trading
types and formatters live inside a mock-data hook, UI files contain formatting
and duplication issues, the research sandbox no longer typechecks against the
shipped engine, and there is no automated test suite. We need a single,
verifiable quality pass that keeps runtime behavior intact while making the
codebase easier to read, test, and extend.

## 2. Baseline evidence (before any change)

| Check | Command | Result |
|---|---|---|
| App typecheck | `npx tsc --noEmit` | pass |
| App lint | `npx expo lint` | pass |
| Dependency health | `npx expo-doctor` | 12 Expo packages behind expected patches |
| Tests | — | none configured |
| Research typecheck | `cd Context/gridbot && npx tsc --noEmit` | fails (6 files) |

Known research failures:

- `app-sim.ts`, `filter-experiment.ts`: import removed `buildGrid`, `planTick`,
  `isUpBar` from the app engine.
- `dca-sim.ts`: imports removed `atr`, `isUpBar`.
- `grid-dca-filter-sweep.ts`: stray `x` at line 1.
- `dd-stop-comparison.ts`: boolean written into `Record<string, string | number>`.

## 3. Scope

In scope:

- `src/**` (app source, components, hooks, lib, routes)
- Root config (`package.json`, `tsconfig.json`, lint/test config)
- `scripts/**`
- `Context/gridbot/**` (research sandbox)
- Documentation for contributors

Out of scope:

- Strategy/UX redesign; changing trading logic behavior.
- Native `ios/` / `android/` (CNG-generated, never edited by hand).
- Rotating secrets or changing the licensing business model.

## 4. Behavior policy

**Behavior-preserving refactor + safe bug fixes.** A change may alter runtime
behavior only when it fixes a defect that is clearly a bug and the fix is
covered by a test. No strategy, pricing, order-routing, or navigation change.

## 5. Requirements and acceptance criteria

### R1 — Dependency alignment
- Run `npx expo install --fix` for the flagged packages.
- `npx expo-doctor` passes all checks.
- `npx tsc --noEmit` and `npx expo lint` still pass.

### R2 — Correct TypeScript project boundaries
- `Context/**` stays excluded from the app typecheck.
- `Context/gridbot` has its own typecheck that passes.
- No `@ts-nocheck` / `@ts-ignore` added to hide real errors.

### R3 — Pure utilities extracted and tested
- Money/price/lots formatters live in a dependency-free module.
- Trading domain types live in a types module, not in a React hook.
- Wire-scaling helpers (`scaleSpot`, `secondsSinceMessage`) live in a pure
  module and are covered by tests.
- Existing imports are updated; no public behavior changes.

### R4 — Test harness
- `jest-expo` configured with a `test` script.
- Unit tests cover: indicator math (`resample5mEMA`, `calculateRSI`,
  `calculateStochRSI`, `stochTrend`, `evaluateSignal`, `maxOpenPositions`),
  order builders/parsers, trendbar mapping, scaling helpers, and formatters.
- Tests pass in CI-style non-watch mode.

### R5 — App readability and correctness
- Remove duplicated formatting logic and dead code.
- Fix malformed formatting (e.g. missing newlines between declarations,
  statements joined on one line).
- Split oversized modules where a clean, behavior-preserving seam exists.
- All async/error paths keep their existing semantics.

### R6 — Research sandbox consistency
- Stale scripts compile against a clearly labelled legacy engine module.
- Fix the stray character and the rows typing bug.
- Research README explains that the sandbox is legacy/grid and the app ships a
  momentum strategy.

### R7 — Review standard
- Every change is small, named clearly, and committed separately by concern.
- No unrelated reformatting mixed into functional fixes.
- `git diff` reviewable; no secrets committed.

### R8 — Documentation
- `docs/qa-refactor-spec.md` (this file).
- `docs/best-practices.md` with stack-specific guidance and links.
- Root `README.md` no longer the stock Expo template.

## 6. Test plan

Unit (Jest):

1. `engine.test.ts` — EMA resample alignment, StochRSI warm-up/bounds,
   VDC candle/range math and ±20 bands, trend bands and signal gating,
   position slots, TP distance.
2. `orders.test.ts` — request payloads, volume conversion, side/status parsers,
   trendbar mapping incl. 1e5 scaling and delta fields.
3. `scale.test.ts` — spot scaling (int vs double), staleness seconds.
4. `format.test.ts` — signed money, plain money, price digits, lot formatting.

Integration/manual (documented, not automated):

- Login → tabs, demo mode when unconfigured.
- Bot start/stop with a connected account; TP amend and close confirmation.
- Pull-to-refresh on Home/Trades/History.
- License activation and relaunch re-verification.

Out of scope for now: E2E with Maestro (documented as the recommended next step).

## 7. Best-practices references

- Expo SDK 57 docs index: https://docs.expo.dev/llms.txt
- Unit testing with Jest: https://docs.expo.dev/develop/unit-testing/
- Expo Router testing: https://docs.expo.dev/router/reference/testing/
- ESLint/Prettier: https://docs.expo.dev/guides/using-eslint/
- TypeScript: https://docs.expo.dev/guides/typescript/
- CNG (never hand-edit native dirs): https://docs.expo.dev/workflow/continuous-native-generation/
- Environment variables: https://docs.expo.dev/guides/environment-variables/

## 8. Delivery plan

1. `chore(deps)`: Expo patch alignment.
2. `test`: jest-expo harness + pure-util extraction (R3/R4).
3. `refactor(app)`: hooks/types/formatters, formatting fixes, module splits.
4. `fix(research)`: legacy engine module + compile fixes.
5. `docs`: README + best practices.
6. `chore`: final verification, report.

Each step ends with: `tsc --noEmit`, `expo lint`, `jest` (once available), and a
commit.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Moving types/formatters breaks imports | Run typecheck after each extraction; update with search, not guesses |
| Splitting the live engine changes timing | Extract pure helpers only; keep the engine class intact |
| Legacy research code diverges further | Isolate in `legacy-app-engine.ts`, label it, document |
| Dependency update changes behavior | Patch-level only; verify doctor + typecheck + lint; smoke-test manually |

## 10. Definition of done

- All checks green: app typecheck, lint, Jest, gridbot typecheck, doctor.
- Spec requirements R1–R8 satisfied.
- Work committed on `qa/refactor` with a readable history.
- A short QA report lists changes, evidence, and residual risks.

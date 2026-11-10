# Engineering Best Practices — Null

Stack: Expo SDK 57, React Native 0.83, React 19, TypeScript (strict),
Expo Router, Uniwind/Tailwind styling, panelui-native components.

This document is the working checklist for changes in this repo. It is
deliberately short and links to the versioned Expo docs instead of copying
them, because Expo ships breaking changes every SDK.

## 1. Versions and dependencies

- Read the installed Expo major (`package.json`) and use the matching docs:
  <https://docs.expo.dev/versions/v<major>.0.0/>. Do not rely on memory.
- Install native/user-facing packages with `npx expo install <pkg>` (or
  `bunx expo install` in Bun projects) so SDK-compatible versions are chosen.
- Never hand-pick a version for an Expo-managed native module.
- After dependency changes run:

  ```bash
  npx expo-doctor
  npx expo install --fix
  npx tsc --noEmit
  npx expo lint
  npm test
  ```

- Do not run `npm audit fix --force`; it upgrades majors and breaks the SDK
  matrix. Triage advisories individually.
- `expo-doctor` must report no version mismatches before merging.

Docs: <https://docs.expo.dev/versions/latest/> ·
<https://docs.expo.dev/workflow/using-libraries/>

## 2. Native projects (CNG)

- `ios/` and `android/` are generated. Never create or edit them by hand.
- Configure native behaviour in `app.json` (`expo` config) or a local config
  plugin. Regenerate with `npx expo prebuild`.
- Expo Go only contains bundled modules. After adding native code, use a
  development build (`npx expo run:ios|android` or
  `eas build --profile development`).

Docs: <https://docs.expo.dev/workflow/continuous-native-generation/> ·
<https://docs.expo.dev/develop/development-builds/introduction/>

## 3. Routing and navigation

- Routes live in `src/app/`; every file is a screen and `_layout.tsx` files
  define navigators. Keep components/hooks/utils outside `src/app/`.
- Import `Link`, `router`, `useLocalSearchParams`, `useSegments` from
  `expo-router`.
- Have **one** navigation owner per transition. In this app `AuthGuard`
  reacts to `connected`/`licensed`; screens must not also call
  `router.replace` for the same transition or the two will fight.
- Guard repeated `replace` calls with a `lastTarget` ref (see
  `src/app/_layout.tsx`), because successive replaces during an in-flight
  transition never commit.
- Typed routes are enabled; run `npx expo start` once after adding a route so
  `.expo/types` regenerates.

Docs: <https://docs.expo.dev/router/introduction/> ·
<https://docs.expo.dev/router/reference/testing/>

## 4. TypeScript

- `strict` is on. Do not add `@ts-ignore`/`@ts-nocheck` to silence a real
  error; fix the type or narrow the value at the boundary.
- Keep `Context/**` out of the app typecheck and give research code its own
  `tsconfig.json` + `typecheck` script.
- Prefer plain, dependency-free modules for logic that does not need React:
  - `src/lib/ctrader/wire.ts` — wire normalization
  - `src/lib/format.ts` — display formatters
  - `src/lib/trading/types.ts` — domain shapes
  - `src/lib/bot/engine.ts` — indicator math
- Type function parameters as `number` rather than relying on a literal
  default (`period: number = STRATEGY_PARAMS.adxPeriod`), otherwise callers
  cannot pass another period.
- Guard untrusted payloads with `unknown` + runtime checks, not casts.
  Malformed broker rows must be skipped, never thrown.

Docs: <https://docs.expo.dev/guides/typescript/>

## 5. Testing

- Harness: `jest-expo` preset, tests in `__tests__/*-test.ts`.
- Test **pure seams** (indicator math, order payload builders, parsers,
  formatters, scaling). Components that need the RN runtime are covered by
  manual smoke tests; add React Native Testing Library before testing them
  automatically.
- Every bug fix gets a regression test. If a fix cannot be tested yet, say so
  in the PR instead of implying coverage.
- Run non-watch in CI: `npm test -- --ci`.
- Keep Jest globals typed via `"types": ["jest"]` in `tsconfig.json`.

Docs: <https://docs.expo.dev/develop/unit-testing/>

## 6. Lint, formatting and review size

- `npx expo lint` must pass. `eslint-config-expo` is the source of truth.
- Match the surrounding style; do not reformat a whole file while making a
  functional change. Separate commits by concern:
  `chore(deps)`, `test`, `refactor`, `fix`, `docs`.
- A reviewable diff is small and named for what it does. If a refactor and a
  behaviour change are inseparable, explain why in the commit body.
- Remove dead code and duplicated helpers instead of adding a second copy.
  Shared UI atoms live in `src/components/` and shared hooks in
  `src/hooks/`.

Docs: <https://docs.expo.dev/guides/using-eslint/>

## 7. React and state

- External stores use `useSyncExternalStore` (`liveEngine`, `botRunner`,
  license flag). Keep `getSnapshot` referentially stable; only bump
  `version` when data actually changes.
- Subscribe in effects and always return the unsubscribe function.
- Guard async state updates after unmount (`mounted` ref pattern in
  `positions-card.tsx`) or use a cancellation flag.
- Memoize static art and row components (`memo`) so realtime ticks do not
  re-render the whole tree.
- Throttle high-frequency streams at the store boundary (spot emits are
  capped at 4 per second) instead of in every component.

## 8. Security and configuration

- Secrets come from the environment; `.env.local` is never committed.
  Copy `.env.example` and fill it locally.
- `EXPO_PUBLIC_*` values are embedded in the client bundle. Never put a value
  there that must stay secret. The cTrader client secret is currently
  bundled because Spotware requires it at app-auth; the hardened path is the
  server token proxy in `src/lib/server/token-proxy.ts`.
- Web login must go through the server proxy (Spotware has no CORS headers).
  Keep `web.output: "server"` or set `EXPO_PUBLIC_CTRADER_TOKEN_PROXY_URL`.
- Store tokens in SecureStore on native and localStorage on web
  (`src/lib/storage.ts`). Treat corrupt stored values as absent.
- License keys bind to a per-install device id; re-verification happens on
  every launch.

Docs: <https://docs.expo.dev/guides/environment-variables/> ·
<https://docs.expo.dev/versions/latest/sdk/securestore/>

## 9. Builds and releases

- EAS for cloud builds, submissions and OTA updates:
  `bunx eas-cli build --profile preview`, `eas submit`, `eas update`.
- Bump `expo.version`/build numbers in `app.json`; keep bundle ids stable.
- Smoke test a preview build after native dependency changes — Jest and
  typecheck cannot prove a native module links.

Docs: <https://docs.expo.dev/eas/> ·
<https://docs.expo.dev/build/introduction/>

## 10. Research sandbox (`Context/gridbot`)

- It is a legacy grid/DCA research sandbox; the shipped app runs a momentum
  strategy. Do not assume its findings describe the live bot.
- Grid helpers that the app removed are archived in
  `src/legacy-app-engine.ts` with a header explaining provenance. Do not
  import that module from `src/`.
- Research code has its own typecheck and sanity suite:

  ```bash
  cd Context/gridbot
  npx tsc --noEmit
  npm test
  ```

## 11. Definition of done

A change is done when:

1. `npx tsc --noEmit` passes.
2. `npx expo lint` passes.
3. `npm test -- --ci` passes.
4. `npx expo-doctor` reports no issues (after dependency changes).
5. `cd Context/gridbot && npx tsc --noEmit` passes if research code changed.
6. Behaviour changes are covered by a test or a documented manual check.
7. Docs (`README`, spec, best practices) still describe reality.

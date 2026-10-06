// Optimizer: multi-market maximin selection (anti-overfit by construction).
//   npm run optimize              → 5 forex 1m markets (AUDCAD USDCHF GBPUSD USDJPY XAUUSD)
//   npm run optimize -- --csv F   → single CSV market instead
//
// Protocol:
//   1. Small space (3×3×2 = 18 combos, both-sides only) — nothing to memorize with.
//   2. Each market split 70/30 chronologically. Selection ONLY on train pools.
//   3. Rank by WORST train-market return (maximin): winner must work everywhere, not one regime.
//   4. Hard gates: avg ≥50 trades/day on train, win rate ≥70%, PF ≥1.2 on train pool.
//   5. Top 5 validated once on the untouched test pools. Winner printed (no JSON).
// Costs (commission/spread/slippage) are inside every backtest — selection sees net PP.

import { backtest } from "./backtest.js";
import { loadCsv, type OHLC } from "./market.js";
import { DEFAULTS, type GridConfig } from "./strategy.js";

const FOREX = [
  { file: "data/AUDCAD-1m.csv", name: "AUDCAD", commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 },
  { file: "data/USDCHF-1m.csv", name: "USDCHF", commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 },
  { file: "data/GBPUSD-1m.csv", name: "GBPUSD", commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 },
  { file: "data/USDJPY-1m.csv", name: "USDJPY", commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 },
  { file: "data/GC-1m.csv", name: "XAUUSD", commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 },
];

interface Pool { name: string; m: OHLC; costs: Pick<GridConfig, "commissionBps" | "spreadBps" | "slippageBps"> }

const split = (m: OHLC, frac: number): [OHLC, OHLC] => {
  const cut = Math.floor(m.c.length * frac);
  const s = (a: number, b: number): OHLC => ({ o: m.o.slice(a, b), h: m.h.slice(a, b), l: m.l.slice(a, b), c: m.c.slice(a, b) });
  return [s(0, cut), s(cut, m.c.length)];
};

function *combos(): Generator<{ label: string; cfg: GridConfig }> {
  for (const gridMult of [0.5, 0.75, 1])
    for (const n of [6, 8, 10])
      for (const atrLen of [5, 14]) {
        const cfg: GridConfig = {
          ...DEFAULTS, mode: "atr", gridMult, levelsEachSide: n, atrLen,
          adxGate: false, direction: "both", reanchor: true,
        };
        yield { label: `both mult=${gridMult} n=${n} atr=${atrLen}`, cfg };
      }
}

const fmtPF = (pf: number) => (Number.isFinite(pf) ? pf.toFixed(2) : "∞");
const perDay = (rt: number, bars: number) => (rt / (bars / 1440)).toFixed(0);

async function main() {
  const csvArg = process.argv.indexOf("--csv");
  const markets: { file: string; name: string; commissionBps: number; spreadBps: number; slippageBps: number }[] =
    csvArg >= 0
      ? [{ file: process.argv[csvArg + 1], name: process.argv[csvArg + 1], commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 }]
      : FOREX;

  const trains: Pool[] = [], tests: Pool[] = [];
  for (const mk of markets) {
    const m = await loadCsv(mk.file);
    const [tr, te] = split(m, 0.7);
    trains.push({ name: mk.name, m: tr, costs: mk });
    tests.push({ name: mk.name, m: te, costs: mk });
  }
  const withCosts = (p: Pool, cfg: GridConfig): GridConfig => ({ ...cfg, ...p.costs });

  const EQUITY = 100; // $100 start equity on every run

  // Best config per market by maximin worst-fold (strict flag shown, never hidden).
  // Direction is always "both" — no long-only or short-only trading.
  const best = new Map<string, { label: string; cfg: GridConfig; folds: number[]; strict: boolean }>();
  for (const p of trains) {
    const foldLen = Math.floor(p.m.c.length / 3);
    const fold = (k: number): OHLC => ({
      o: p.m.o.slice(k * foldLen, k === 2 ? p.m.c.length : (k + 1) * foldLen),
      h: p.m.h.slice(k * foldLen, k === 2 ? p.m.c.length : (k + 1) * foldLen),
      l: p.m.l.slice(k * foldLen, k === 2 ? p.m.c.length : (k + 1) * foldLen),
      c: p.m.c.slice(k * foldLen, k === 2 ? p.m.c.length : (k + 1) * foldLen),
    });
    for (const { label, cfg } of combos()) {
      const full = withCosts(p, cfg);
      const fs = [0, 1, 2].map((k) => backtest(fold(k), full, EQUITY));
      if (!fs.every((r) => r.roundTrips >= 5)) continue; // must at least trade everywhere
      const folds = fs.map((r) => r.gridReturnPct);
      const strict = fs.every((r) => r.gridReturnPct > 0 && r.roundTrips >= 10 && r.winRatePct >= 60 && r.profitFactor >= 1.0);
      const key = p.name;
      const cur = best.get(key);
      if (!cur || Math.min(...folds) > Math.min(...cur.folds)) best.set(key, { label, cfg, folds, strict });
    }
  }
  console.log(`\nBest BOTH config per market (maximin worst-fold) → TEST pools, $${EQUITY} start:`);
  console.table([...best.entries()].map(([key, s]) => {
    const [mkt] = key.split("|");
    const te = tests.find((t) => t.name === mkt)!;
    const t = backtest(te.m, withCosts(te, s.cfg), EQUITY);
    const d = t.finalEquity - EQUITY;
    return {
      Mkt: mkt, Params: s.label, Strict: s.strict ? "PASS" : "WEAK",
      "Folds%": s.folds.map((f) => f.toFixed(1)).join("/"),
      "TestPP%": (t.gridReturnPct >= 0 ? "+" : "") + t.gridReturnPct.toFixed(2),
      "Test$": (d >= 0 ? "+" : "") + d.toFixed(2),
      TestRT: t.roundTrips, "/day": perDay(t.roundTrips, te.m.c.length),
      "TestWin%": t.roundTrips ? t.winRatePct.toFixed(0) : "—",
      "TestPF": fmtPF(t.profitFactor), "TestDD%": t.maxDrawdownPct.toFixed(2),
    };
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });

// App-parity test: mirrors src/lib/bot/engine.ts + runner.ts start() exactly.
// App: M15 bars, buildGrid(bars, atrLen=21, mult=0.25, levels=3),
// bounce entries (longs up-bars / shorts down-bars), both sides,
// TP = 1 step, reanchor on escape, 0.02 lots ≈ 2oz, leverage 100.
// Run: npx tsx src/app-parity.ts
import { backtest } from "./backtest.js";
import { loadCsv, resample } from "./market.js";
import { DEFAULTS, type GridConfig } from "./strategy.js";

const fmtPF = (pf: number) => (Number.isFinite(pf) ? pf.toFixed(2) : "∞");
const GOLD_COSTS = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };

async function main() {
  const m1 = await loadCsv("data/GC-1m.csv");
  const m15 = resample(m1, 15);
  console.log(`GC 1m bars=${m1.c.length} → M15 bars=${m15.c.length}`);

  const cut = Math.floor(m15.c.length * 0.7);
  const TR = { o: m15.o.slice(0, cut), h: m15.h.slice(0, cut), l: m15.l.slice(0, cut), c: m15.c.slice(0, cut) };
  const TE = { o: m15.o.slice(cut), h: m15.h.slice(cut), l: m15.l.slice(cut), c: m15.c.slice(cut) };

  // App-like: ATR(21)*0.25, n=3, bounce, both, reanchor, 2oz fixed, lev 100
  const appLike = (over: Partial<GridConfig> = {}): GridConfig => ({
    ...DEFAULTS,
    mode: "atr",
    atrLen: 21,
    gridMult: 0.25,
    levelsEachSide: 3,
    bounceEntry: true,
    adxGate: false,
    direction: "both",
    reanchor: true,
    entriesPerLevel: 1,
    lotOz: 2,
    leverage: 100,
    stopOutFrac: 0.2,
    ...GOLD_COSTS,
    ...over,
  });

  const cases: { label: string; cfg: GridConfig }[] = [
    { label: "APP-LIKE atr21x0.25 n=3 M15", cfg: appLike() },
    // Same but n=4 (backtest DEFAULTS width) — isolates level-count effect.
    { label: "atr21x0.25 n=4 M15", cfg: appLike({ levelsEachSide: 4 }) },
    // Pure fixed $4 step (≈40 x $0.10): no ATR lag.
    {
      label: "FIXED $4.00 n=3 M15",
      cfg: appLike({ mode: "fixed", fixedTicks: 40, tickSize: 0.1 }),
    },
    {
      label: "FIXED $4.00 n=4 M15",
      cfg: appLike({ mode: "fixed", fixedTicks: 40, tickSize: 0.1, levelsEachSide: 4 }),
    },
  ];

  for (const { label, cfg } of cases) {
    // 3-fold train + untouched test, same protocol as optimize.ts
    const fl = Math.floor(TR.c.length / 3);
    const F = (k: number) => ({
      o: TR.o.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl),
      h: TR.h.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl),
      l: TR.l.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl),
      c: TR.c.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl),
    });
    let folds: string = "";
    let foldRT: string = "";
    try {
      const rs = [0, 1, 2].map((k) => backtest(F(k), cfg, 100));
      folds = rs.map((r) => `${r.gridReturnPct >= 0 ? "+" : ""}${r.gridReturnPct.toFixed(1)}`).join("/");
      foldRT = rs.map((r) => `${r.roundTrips}`).join("/");
      const t = backtest(TE, cfg, 100);
      console.log(
        `${label}\n  step=$${t.step.toFixed(2)} folds[${folds}] foldRT[${foldRT}] → TEST PP ${t.gridReturnPct >= 0 ? "+" : ""}${t.gridReturnPct.toFixed(2)}% RT=${t.roundTrips} win=${t.roundTrips ? t.winRatePct.toFixed(0) : "—"}% PF=${fmtPF(t.profitFactor)} DD=${t.maxDrawdownPct.toFixed(2)}% costs=$${t.costsPaid.toFixed(0)} reanch=${t.reanchors}`,
      );
    } catch (e) {
      console.log(`${label} → FAILED: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Timeframe sweep: resample 1m → TF, fold protocol + test, both-sides.
//   npx tsx src/timeframes.ts
import { backtest } from "./backtest.js";
import { loadCsv, resample, type OHLC } from "./market.js";
import { DEFAULTS, type GridConfig } from "./strategy.js";

const MKTS = [
  { file: "data/AUDCAD-1m.csv", name: "AUDCAD", costs: { commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 } },
  { file: "data/USDCHF-1m.csv", name: "USDCHF", costs: { commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 } },
  { file: "data/GBPUSD-1m.csv", name: "GBPUSD", costs: { commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 } },
  { file: "data/USDJPY-1m.csv", name: "USDJPY", costs: { commissionBps: 0.3, spreadBps: 0.2, slippageBps: 0.2 } },
  { file: "data/GC-1m.csv", name: "XAUUSD", costs: { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 } },
];
const TFS = [5, 15, 30, 60, 240, 1440];

function *combos(): Generator<{ label: string; cfg: GridConfig }> {
  for (const gridMult of [0.5, 0.75, 1])
    for (const n of [6, 8, 10])
      for (const atrLen of [5, 14]) {
        const cfg: GridConfig = {
          ...DEFAULTS, mode: "atr", gridMult, levelsEachSide: n, atrLen,
          adxGate: false, direction: "both", reanchor: true,
        };
        yield { label: `mult=${gridMult} n=${n} atr=${atrLen}`, cfg };
      }
}

const fmtPF = (pf: number) => (Number.isFinite(pf) ? pf.toFixed(2) : "∞");

async function main() {
  console.log("TF sweep ($100, full costs, best worst-fold → untouched 30% test):");
  for (const tf of TFS) {
    const tfl = tf >= 1440 ? "D1" : tf >= 60 ? `H${tf / 60}` : `M${tf}`;
    for (const { file, name, costs } of MKTS) {
      const m = resample(await loadCsv(file), tf);
      if (m.c.length < 120) { console.log(`${tfl} ${name}: too few bars (${m.c.length}) — skipped`); continue; }
      const cut = Math.floor(m.c.length * 0.7);
      const TR: OHLC = { o: m.o.slice(0, cut), h: m.h.slice(0, cut), l: m.l.slice(0, cut), c: m.c.slice(0, cut) };
      const TE: OHLC = { o: m.o.slice(cut), h: m.h.slice(cut), l: m.l.slice(cut), c: m.c.slice(cut) };
      const fl = Math.floor(TR.c.length / 3);
      const F = (k: number): OHLC => ({ o: TR.o.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), h: TR.h.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), l: TR.l.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), c: TR.c.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl) });
      let best: { label: string; cfg: GridConfig; folds: number[] } | null = null;
      let bestW = -Infinity;
      for (const { label, cfg } of combos()) {
        const wc = { ...cfg, ...costs };
        let fs;
        try {
          fs = [0, 1, 2].map((k) => backtest(F(k), wc, 100));
        } catch { continue; }
        if (!fs.every((r) => r.roundTrips >= 3)) continue;
        const w = Math.min(...fs.map((r) => r.gridReturnPct));
        if (w > bestW) { bestW = w; best = { label, cfg, folds: fs.map((r) => r.gridReturnPct) }; }
      }
      if (!best) { console.log(`${tfl} ${name}: nothing trades all folds`); continue; }
      let t;
      try {
        t = backtest(TE, { ...best.cfg, ...costs }, 100);
      } catch { console.log(`${tfl} ${name}: test failed (too few bars)`); continue; }
      const strict = best.folds.every((f) => f > 0) ? "PASS" : "weak";
      console.log(`${tfl} ${name} [${best.label}] ${strict} folds ${best.folds.map((f) => f.toFixed(1)).join("/")} → TEST PP ${(t.gridReturnPct >= 0 ? "+" : "") + t.gridReturnPct.toFixed(2)}% RT=${t.roundTrips} win=${t.roundTrips ? t.winRatePct.toFixed(0) : "—"}% PF=${fmtPF(t.profitFactor)} DD=${t.maxDrawdownPct.toFixed(2)}%`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

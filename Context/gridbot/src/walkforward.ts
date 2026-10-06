// Walk-forward refit + H4 grid test.
//   npx tsx src/walkforward.ts
// A) MONTHLY REFIT (1m): fit on past chunks → validate next chunk → trade the
//    following chunk ONLY if validation is green (PP>0, PF>=1, RT>=10).
//    Simulates live deployment: flat (no trade) when validation fails.
// B) H4 GRID: same 3-month data resampled to H4, fold protocol, both-sides.

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

const chunk = (m: OHLC, k: number, size: number): OHLC => {
  const a = k * size, b = Math.min(m.c.length, (k + 1) * size);
  return { o: m.o.slice(a, b), h: m.h.slice(a, b), l: m.l.slice(a, b), c: m.c.slice(a, b) };
};
const cat = (cs: OHLC[]): OHLC => ({
  o: cs.flatMap((c) => c.o), h: cs.flatMap((c) => c.h),
  l: cs.flatMap((c) => c.l), c: cs.flatMap((c) => c.c),
});
const fmtPF = (pf: number) => (Number.isFinite(pf) ? pf.toFixed(2) : "∞");

async function main() {
  console.log("=== A) WALK-FORWARD REFIT (1m, 5 chunks ≈ 18d each: fit → validate → trade-if-green) ===");
  for (const { file, name, costs } of MKTS) {
    const m = await loadCsv(file);
    const size = Math.floor(m.c.length / 5);
    const C = [0, 1, 2, 3, 4].map((k) => chunk(m, k, size));
    const wc = (cfg: GridConfig): GridConfig => ({ ...cfg, ...costs });
    let cum = 0, traded = 0, skipped = 0;
    const log: string[] = [];
    for (let r = 0; r <= 1; r++) {
      const fit = cat(C.slice(0, r + 2));
      const h = Math.floor(fit.c.length / 2);
      const halves: OHLC[] = [
        { o: fit.o.slice(0, h), h: fit.h.slice(0, h), l: fit.l.slice(0, h), c: fit.c.slice(0, h) },
        { o: fit.o.slice(h), h: fit.h.slice(h), l: fit.l.slice(h), c: fit.c.slice(h) },
      ];
      let pick: { label: string; cfg: GridConfig } | null = null;
      let pickWorst = -Infinity;
      for (const { label, cfg } of combos()) {
        let rs;
        try {
          rs = halves.map((x) => backtest(x, wc(cfg), 100));
        } catch { continue; } // dead data stretch — combo untestable here
        if (!rs.every((x) => x.gridReturnPct > 0 && x.roundTrips >= 10)) continue;
        const w = Math.min(...rs.map((x) => x.gridReturnPct));
        if (w > pickWorst) { pickWorst = w; pick = { label, cfg }; }
      }
      if (!pick) { log.push(`R${r}: no fit → skip`); skipped++; continue; }
      const val = backtest(C[r + 2], wc(pick.cfg), 100);
      if (!(val.gridReturnPct > 0 && val.profitFactor >= 1 && val.roundTrips >= 10)) {
        log.push(`R${r}: [${pick.label}] val red (${val.gridReturnPct.toFixed(2)}%) → SKIP trade`); skipped++; continue;
      }
      const tr = backtest(C[r + 3], wc(pick.cfg), 100);
      cum += tr.gridReturnPct; traded++;
      log.push(`R${r}: [${pick.label}] val +${val.gridReturnPct.toFixed(2)}% → TRADE +${tr.gridReturnPct.toFixed(2)}% (${tr.roundTrips} RT)`);
    }
    console.log(`${name}: traded ${traded}/2 windows, skipped ${skipped} — cumulative ${cum >= 0 ? "+" : ""}${cum.toFixed(2)}%`);
    log.forEach((l) => console.log(`   ${l}`));
  }

  console.log("\n=== B) H4 GRID (resampled, fold protocol, both-sides) ===");
  for (const { file, name, costs } of MKTS) {
    const m = resample(await loadCsv(file), 240);
    const cut = Math.floor(m.c.length * 0.7);
    const TR: OHLC = { o: m.o.slice(0, cut), h: m.h.slice(0, cut), l: m.l.slice(0, cut), c: m.c.slice(0, cut) };
    const TE: OHLC = { o: m.o.slice(cut), h: m.h.slice(cut), l: m.l.slice(cut), c: m.c.slice(cut) };
    const fl = Math.floor(TR.c.length / 3);
    const F = (k: number): OHLC => ({ o: TR.o.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), h: TR.h.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), l: TR.l.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl), c: TR.c.slice(k * fl, k === 2 ? TR.c.length : (k + 1) * fl) });
    let best: { label: string; cfg: GridConfig; folds: number[] } | null = null;
    let bestW = -Infinity;
    for (const { label, cfg } of combos()) {
      const wc = { ...cfg, ...costs };
      const fs = [0, 1, 2].map((k) => backtest(F(k), wc, 100));
      if (!fs.every((r) => r.roundTrips >= 3)) continue;
      const w = Math.min(...fs.map((r) => r.gridReturnPct));
      if (w > bestW) { bestW = w; best = { label, cfg, folds: fs.map((r) => r.gridReturnPct) }; }
    }
    if (!best) { console.log(`${name} (${m.c.length} H4 bars): nothing trades all folds`); continue; }
    const t = backtest(TE, { ...best.cfg, ...costs }, 100);
    console.log(`${name} (${m.c.length} H4) [${best.label}] folds ${best.folds.map((f) => f.toFixed(1)).join("/")} → TEST PP ${(t.gridReturnPct >= 0 ? "+" : "") + t.gridReturnPct.toFixed(2)}% RT=${t.roundTrips} win=${t.roundTrips ? t.winRatePct.toFixed(0) : "—"}% PF=${fmtPF(t.profitFactor)} DD=${t.maxDrawdownPct.toFixed(2)}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// CLI: backtest one config across datasets.
//   npx tsx src/run.ts                        → synthetic markets
//   npx tsx src/run.ts --csv data/AUDCAD-1m.csv
// Costs live in cfg (commission/spread/slippage bps) — always on, always reported.

import { backtest } from "./backtest.js";
import { fetchBinance, genMarket, genRangeMarket, loadCsv, type OHLC } from "./market.js";
import { DEFAULTS, type GridConfig } from "./strategy.js";

const fmtPF = (pf: number) => (Number.isFinite(pf) ? pf.toFixed(2) : "∞");

async function main() {
  const args = process.argv.slice(2);
  let datasets: { name: string; m: OHLC; spread: number }[] = [];
  if (args[0] === "--csv" && args[1]) {
    datasets = [{ name: args[1], m: await loadCsv(args[1]), spread: 0.5 }];
  } else if (args[0] === "--binance") {
    const m = await fetchBinance(args[1] ?? "BTCUSDT", args[2] ?? "1h");
    datasets = [{ name: `${args[1] ?? "BTCUSDT"} ${args[2] ?? "1h"}`, m, spread: 0.5 }];
  } else {
    datasets = [
      { name: "synthetic trend/regime (seed 7)", m: genMarket(500, 7), spread: 0 },
      { name: "synthetic range (seed 7)", m: genRangeMarket(500, 7), spread: 0 },
    ];
  }

  const strategies: { name: string; cfg: GridConfig }[] = [
    { name: "ATR trail both", cfg: { ...DEFAULTS } },
  ];

  for (const { name, m, spread } of datasets) {
    console.log(`\n=== ${name} (${m.c.length} bars) ===`);
    console.table(strategies.map(({ name: s, cfg }) => {
      const r = backtest(m, { ...cfg, spreadBps: cfg.spreadBps || spread });
      return {
        Strategy: s,
        RT: r.roundTrips,
        "Win%": r.roundTrips ? r.winRatePct.toFixed(1) : "—",
        PF: fmtPF(r.profitFactor),
        "PP%": r.gridReturnPct.toFixed(2),
        "B&H%": r.buyHoldReturnPct.toFixed(2),
        "MaxDD%": r.maxDrawdownPct.toFixed(2),
        Costs: r.costsPaid.toFixed(2),
        ReAnch: r.reanchors,
        Escaped: r.escapedRange ? "yes" : "no",
      };
    }));
  }
  console.log("\nRT = round trips · PF = grossWin/grossLoss · PP = net profit % (all costs in) · Costs = commission+spread+slippage.");
}

main().catch((e) => { console.error(e); process.exit(1); });

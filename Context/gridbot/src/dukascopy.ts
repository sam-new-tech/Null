// Fetch M1 candles from Dukascopy (free, years deep) → data/*.csv
//   npx tsx src/dukascopy.ts [days=92]
// Weekends/holidays come back as gaps — engine treats bars as a sequence (no time-based logic), fine.
import { mkdir, writeFile } from "node:fs/promises";

const SYMBOLS = [
  { dk: "audcad", out: "data/AUDCAD-1m.csv" },
  { dk: "usdchf", out: "data/USDCHF-1m.csv" },
  { dk: "gbpusd", out: "data/GBPUSD-1m.csv" },
  { dk: "usdjpy", out: "data/USDJPY-1m.csv" },
  { dk: "xauusd", out: "data/GC-1m.csv" },
];

async function main() {
  const { getHistoricRates } = await import("dukascopy-node");
  const days = +(process.argv[2] ?? 92);
  const to = Date.now();
  const from = to - days * 86400000;
  await mkdir("data", { recursive: true });
  for (const { dk, out } of SYMBOLS) {
    console.log(`Fetching ${dk} M1, last ${days}d...`);
    const rows = (await getHistoricRates({ instrument: dk as any, dates: { from, to }, timeframe: "m1", volumes: false })) as number[][];
    const lines = ["ts,open,high,low,close"];
    for (const [ts, o, h, l, c] of rows) lines.push(`${ts},${o},${h},${l},${c}`);
    await writeFile(out, lines.join("\n"));
    console.log(`  ${out}: ${rows.length} bars, ${new Date(rows[0][0]).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

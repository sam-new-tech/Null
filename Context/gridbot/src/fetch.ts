// Fetch klines with pagination + save to CSV for reuse.
//   npx tsx src/fetch.ts BTCUSDT 5m 5000
// → data/BTCUSDT-5m.csv

import { mkdir, writeFile } from "node:fs/promises";
import type { OHLC } from "./market.js";

async function fetchPaged(symbol: string, interval: string, total: number): Promise<OHLC> {
  const per = 1000;
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  let endTime: number | undefined;
  const chunks: string[][][] = [];
  let need = total;
  while (need > 0) {
    const lim = Math.min(per, need);
    let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${lim}`;
    if (endTime) url += `&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as string[][];
    if (!rows.length) break;
    chunks.unshift(rows);
    endTime = +rows[0][0] - 1;
    need -= rows.length;
    if (rows.length < lim) break;
    await new Promise((r) => setTimeout(r, 300)); // rate-limit friendly
  }
  for (const rows of chunks.flat()) {
    o.push(+rows[1]); h.push(+rows[2]); l.push(+rows[3]); c.push(+rows[4]);
  }
  return { o: o.slice(-total), h: h.slice(-total), l: l.slice(-total), c: c.slice(-total) };
}

async function main() {
  const [symbol = "BTCUSDT", interval = "5m", total = "5000"] = process.argv.slice(2);
  console.log(`Fetching ${total} x ${interval} ${symbol}...`);
  const m = await fetchPaged(symbol, interval, +total);
  console.log(`Got ${m.c.length} bars: ${m.c[0]} → ${m.c[m.c.length - 1]}`);
  await mkdir("data", { recursive: true });
  const path = `data/${symbol}-${interval}.csv`;
  const lines = ["timestamp,open,high,low,close"];
  // timestamps not tracked — index is enough for backtest; keep OHLC only
  for (let i = 0; i < m.c.length; i++) lines.push(`${i},${m.o[i]},${m.h[i]},${m.l[i]},${m.c[i]}`);
  await writeFile(path, lines.join("\n"));
  console.log(`Saved ${path}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

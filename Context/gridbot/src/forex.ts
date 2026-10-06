// Fetch 1m forex week from Yahoo + rank by ranging (mean-reversion) score.
//   npx tsx src/forex.ts
// Score: efficiency ratio = |net change| / sum(|changes|) over the week.
// Lower = more chop (0 = pure sideways, 1 = straight line).

import { mkdir, writeFile } from "node:fs/promises";
import type { OHLC } from "./market.js";

const SYMBOLS = ["EURUSD=X", "GBPUSD=X", "USDJPY=X", "AUDUSD=X", "USDCAD=X",
  "EURGBP=X", "EURCHF=X", "AUDCAD=X", "NZDUSD=X", "USDCHF=X", "GC=F"];

async function fetchYahoo(symbol: string): Promise<{ m: OHLC; bars: number }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=7d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${symbol}: ${res.status}`);
  const j = (await res.json()) as any;
  const q = j.chart.result[0].indicators.quote[0];
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  for (let i = 0; i < q.close.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    o.push(q.open[i]); h.push(q.high[i]); l.push(q.low[i]); c.push(q.close[i]);
  }
  return { m: { o, h, l, c }, bars: c.length };
}

function efficiency(c: number[]): number {
  let path = 0;
  for (let i = 1; i < c.length; i++) path += Math.abs(c[i] - c[i - 1]);
  return path > 0 ? Math.abs(c[c.length - 1] - c[0]) / path : 1;
}

async function main() {
  await mkdir("data", { recursive: true });
  const ranked: { s: string; eff: number; bars: number; chg: number }[] = [];
  for (const s of SYMBOLS) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const { m, bars } = await fetchYahoo(s);
      const eff = efficiency(m.c);
      const chg = ((m.c[m.c.length - 1] / m.c[0] - 1) * 100);
      ranked.push({ s, eff, bars, chg });
      const name = s.replace("=X", "").replace("=F", "");
      const lines = ["ts,open,high,low,close"];
      for (let i = 0; i < m.c.length; i++) lines.push(`${i},${m.o[i]},${m.h[i]},${m.l[i]},${m.c[i]}`);
      await writeFile(`data/${name}-1m.csv`, lines.join("\n"));
      console.log(`${s}: bars=${bars} weekChg=${chg.toFixed(2)}% efficiency=${eff.toFixed(3)}`);
    } catch (e) { console.log(`${s}: FAILED ${e}`); }
  }
  ranked.sort((a, b) => a.eff - b.eff);
  console.log("\nMost ranging → most trending:");
  ranked.forEach((r, i) => console.log(`${i + 1}. ${r.s} eff=${r.eff.toFixed(3)}`));
}

main().catch((e) => { console.error(e); process.exit(1); });

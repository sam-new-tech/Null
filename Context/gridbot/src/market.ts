// Market data: synthetic generator (mirrors pine-math.ts from the docs app)
// + CSV loader + optional Binance klines fetch. All outputs OHLC arrays.

export interface OHLC {
  o: number[];
  h: number[];
  l: number[];
  c: number[];
}

export function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same generator as the docs lab: regime shifts every 45 bars. */
export function genMarket(n = 500, seed = 7): OHLC {
  const rnd = mulberry(seed);
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  let p = 100, trend = 0;
  for (let i = 0; i < n; i++) {
    if (i % 45 === 0) trend = (rnd() - 0.45) * 1.2;
    const vol = 0.6 + rnd() * 1.4;
    const ch = trend + rnd() * vol - vol / 2;
    const oo = p, cc = oo + ch;
    o.push(oo);
    h.push(Math.max(oo, cc) + rnd() * vol * 0.6);
    l.push(Math.min(oo, cc) - rnd() * vol * 0.6);
    c.push(cc);
    p = cc;
  }
  return { o, h, l, c };
}

/** Choppy / range-bound market: mean-reverts around `start`. Grid bots love this. */
export function genRangeMarket(n = 500, seed = 7, start = 100, amp = 6): OHLC {
  const rnd = mulberry(seed);
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const pull = (start - p) * 0.15; // mean reversion (strong enough to hold the range)
    const noise = (rnd() - 0.5) * amp * 0.3;
    const oo = p, cc = oo + pull + noise;
    o.push(oo);
    h.push(Math.max(oo, cc) + rnd() * 0.5);
    l.push(Math.min(oo, cc) - rnd() * 0.5);
    c.push(cc);
    p = cc;
  }
  return { o, h, l, c };
}

/** Resample 1m OHLC → N-minute bars (e.g. 240 = H4, 1440 = D1). */
export function resample(m: OHLC, minutes: number): OHLC {
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  for (let k = 0; k + minutes <= m.c.length; k += minutes) {
    o.push(m.o[k]);
    h.push(Math.max(...m.h.slice(k, k + minutes)));
    l.push(Math.min(...m.l.slice(k, k + minutes)));
    c.push(m.c[k + minutes - 1]);
  }
  return { o, h, l, c };
}

/** Load OHLC from a CSV with header containing open,high,low,close (extra cols ignored). */
export async function loadCsv(path: string): Promise<OHLC> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  const lines = text.trim().split("\n");
  const head = lines[0].toLowerCase().split(",").map((s) => s.trim());
  const io = head.indexOf("open"), ih = head.indexOf("high");
  const il = head.indexOf("low"), ic = head.indexOf("close");
  if (io < 0 || ih < 0 || il < 0 || ic < 0) {
    throw new Error(`CSV needs open,high,low,close columns, got: ${lines[0]}`);
  }
  const o: number[] = [], h: number[] = [], l: number[] = [], c: number[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    o.push(+cells[io]); h.push(+cells[ih]); l.push(+cells[il]); c.push(+cells[ic]);
  }
  return { o, h, l, c };
}

/** Fetch klines from Binance public API (no key needed). e.g. symbol BTCUSDT, interval 1h. */
export async function fetchBinance(symbol = "BTCUSDT", interval = "1h", limit = 500): Promise<OHLC> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as string[][];
  return {
    o: rows.map((r) => +r[1]),
    h: rows.map((r) => +r[2]),
    l: rows.map((r) => +r[3]),
    c: rows.map((r) => +r[4]),
  };
}

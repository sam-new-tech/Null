// App-faithful simulator: drives the REAL app engine (src/lib/bot/engine.ts)
// bar-by-bar over M15 gold, with intra-bar ticks so spot-crossing behaves
// like live onSpot(). Run: npx tsx src/app-sim.ts
import { loadCsv, resample } from "./market.js";
// NOTE: relative import reaches outside the context package on purpose —
// this is the exact module the app ships.
import {
  buildGrid as appBuildGrid,
  planTick as appPlanTick,
  isUpBar as appIsUpBar,
  type Bar as AppBar,
} from "../../../src/lib/bot/engine.js";

const GOLD_COSTS = { commissionBps: 0.3, spreadBps: 0.5, slippageBps: 0.3 };
const EQUITY = 10000;
const LOT_OZ = 2; // 0.02 lots
const DISASTER = 8;

interface Resting {
  side: "buy" | "sell";
  price: number;
  tp: number;
  sl: number;
}
interface Pos {
  side: "buy" | "sell";
  entry: number;
  tp: number;
  sl: number;
  qty: number;
  bar: number;
}

function simulate(m: { o: number[]; h: number[]; l: number[]; c: number[] }, label: string) {
  const bars: AppBar[] = m.c.map((c, i) => ({
    time: i,
    open: m.o[i],
    high: m.h[i],
    low: m.l[i],
    close: c,
  }));
  // Like runner.start(): need ≥25 bars, anchor on last CLOSED (drop forming).
  const seed = bars.slice(0, 60);
  const grid = appBuildGrid(seed, 21, 0.25, 3);
  let quote = EQUITY;
  let costs = 0;
  const lowers0: Resting[] = grid.lower.map((L) => ({ side: "buy" as const, price: L, tp: L + grid.step, sl: L - DISASTER * grid.step }));
  const uppers0: Resting[] = grid.upper.map((U) => ({ side: "sell" as const, price: U, tp: U - grid.step, sl: U + DISASTER * grid.step }));
  let resting: Resting[] = lowers0.concat(uppers0);
  const positions: Pos[] = [];
  const trades: { pnl: number; win: boolean }[] = [];
  let reanchors = 0;
  let escapes = 0;
  let cur = { ...grid };
  let barDir: "up" | "down" | null = appIsUpBar(seed[seed.length - 1]) ? "up" : "down";
  let prev: number | null = null;

  const adverse = (GOLD_COSTS.spreadBps / 2 + GOLD_COSTS.slippageBps) / 10000;
  const commFrac = GOLD_COSTS.commissionBps / 10000;
  const entryPx = (p: number, side: "buy" | "sell") => (side === "buy" ? p * (1 + adverse) : p * (1 - adverse));
  const exitPx = (p: number, side: "buy" | "sell") => (side === "buy" ? p * (1 - adverse) : p * (1 + adverse));

  const closePos = (idx: number, px: number) => {
    const p = positions[idx];
    const x = exitPx(px, p.side);
    const notional = p.qty * x;
    const fee = notional * commFrac + notional * adverse;
    costs += fee;
    const net = (p.side === "buy" ? x - p.entry : p.entry - x) * p.qty - notional * commFrac;
    quote += net;
    trades.push({ pnl: net, win: net > 0 });
    positions.splice(idx, 1);
  };

  // Walk bars after seeding; intra-bar ticks: open → extreme-first → extreme-second → close
  for (let b = 60; b < bars.length; b++) {
    const bar = bars[b];
    // refreshBar(): direction from last CLOSED bar
    barDir = appIsUpBar(bars[b - 1]) ? "up" : "down";
    const path =
      bar.close >= bar.open
        ? [bar.open, bar.low, bar.high, bar.close]
        : [bar.open, bar.high, bar.low, bar.close];
    for (const px of path) {
      if (prev === null) {
        prev = px;
        continue;
      }
      // 1. check resting fills by crossing (limit semantics)
      for (let i = resting.length - 1; i >= 0; i--) {
        const r = resting[i];
        const filled = r.side === "buy" ? prev > r.price && px <= r.price : prev < r.price && px >= r.price;
        if (filled) {
          const ep = entryPx(r.price, r.side);
          const notional = LOT_OZ * ep;
          const fee = notional * commFrac + notional * adverse;
          costs += fee;
          quote -= fee;
          positions.push({ side: r.side, entry: ep, tp: r.tp, sl: r.sl, qty: LOT_OZ, bar: b });
          resting.splice(i, 1);
        }
      }
      // 2. check TP / disaster SL touches
      for (let i = positions.length - 1; i >= 0; i--) {
        const p = positions[i];
        if (p.side === "buy") {
          if (px >= p.tp) closePos(i, p.tp);
          else if (px <= p.sl) closePos(i, p.sl);
        } else {
          if (px <= p.tp) closePos(i, p.tp);
          else if (px >= p.sl) closePos(i, p.sl);
        }
      }
      // 3. app planTick for fresh placements / escape
      const intents = appPlanTick({
        grid: cur,
        price: px,
        prevPrice: prev,
        barDir,
        positions: positions.map((p, j) => ({ id: String(j), side: p.side, entry: p.entry })),
        orders: resting.map((r, j) => ({ id: String(j), side: r.side, price: r.price })),
        volumeLots: 0.02,
        disasterSteps: DISASTER,
      });
      for (const it of intents) {
        if (it.type === "escape") {
          escapes++;
          // flatten everything at market (pay costs)
          for (let i = positions.length - 1; i >= 0; i--) {
            const p = positions[i];
            const x = exitPx(px, p.side);
            const notional = p.qty * x;
            const fee = notional * commFrac + notional * adverse;
            costs += fee;
            const net = (p.side === "buy" ? x - p.entry : p.entry - x) * p.qty - notional * commFrac;
            quote += net;
            trades.push({ pnl: net, win: net > 0 });
          }
          positions.length = 0;
          resting = [];
          reanchors++;
          // re-anchor like runner.escape(): fresh grid at market from history
          const hist = bars.slice(Math.max(0, b - 60), b);
          try {
            const g2 = appBuildGrid(hist, 21, 0.25, 3);
            cur = g2;
            const lowers: Resting[] = g2.lower.map((L) => ({ side: "buy" as const, price: L, tp: L + g2.step, sl: L - DISASTER * g2.step }));
            const uppers: Resting[] = g2.upper.map((U) => ({ side: "sell" as const, price: U, tp: U - g2.step, sl: U + DISASTER * g2.step }));
            resting = lowers.concat(uppers);
          } catch {
            // keep flat
          }
          break;
        }
        if (it.type === "place") {
          if (!resting.some((r) => r.side === it.side && Math.abs(r.price - it.level) < cur.step * 0.49)) {
            resting.push({ side: it.side, price: it.level, tp: it.tp, sl: it.sl });
          }
        }
      }
      prev = px;
    }
  }
  const wins = trades.filter((t) => t.win).length;
  const gw = trades.filter((t) => t.win).reduce((s, t) => s + t.pnl, 0);
  const gl = -trades.filter((t) => !t.win).reduce((s, t) => s + t.pnl, 0);
  const pf = gl === 0 ? (gw > 0 ? Infinity : 0) : gw / gl;
  const ret = ((quote - EQUITY) / EQUITY) * 100;
  console.log(
    `${label}: step=$${cur.step.toFixed(2)} RT=${trades.length} win=${trades.length ? ((wins / trades.length) * 100).toFixed(0) : "—"}% PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"} ret=${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% costs=$${costs.toFixed(0)} escapes=${escapes} reanchors=${reanchors} open=${positions.length} resting=${resting.length}`,
  );
}

async function main() {
  const m1 = await loadCsv("data/GC-1m.csv");
  const m15 = resample(m1, 15);
  console.log(`M15 bars=${m15.c.length}`);
  const cut = Math.floor(m15.c.length * 0.7);
  simulate(
    { o: m15.o.slice(0, cut), h: m15.h.slice(0, cut), l: m15.l.slice(0, cut), c: m15.c.slice(0, cut) },
    "TRAIN-appSim",
  );
  simulate(
    { o: m15.o.slice(cut), h: m15.h.slice(cut), l: m15.l.slice(cut), c: m15.c.slice(cut) },
    "TEST -appSim",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

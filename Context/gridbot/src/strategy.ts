// Grid strategy config — ATR grid + optional ADX regime gate + trailing + direction.
//
// Cost model (all three, every fill, both sides — this is what makes results realistic):
//   commissionBps — broker commission + retail markup, per side (ECN ~0.3–0.5 bps all-in)
//   spreadBps     — half-spread crossed per fill (majors ~0.2, gold ~0.5)
//   slippageBps   — extra adverse fill offset: queue skips, latency, fast-market slip
// Total friction per round trip ≈ 2 × (commission + spread/2 + slippage).

export interface GridConfig {
  /** "atr" → step = ATR(atrLen)*gridMult (breathes); "fixed" → step = ticks*tickSize */
  mode: "atr" | "fixed";
  atrLen: number;
  gridMult: number;
  fixedTicks: number;
  tickSize: number;
  levelsEachSide: number; // n — levels each side of base
  emaLen: number; // chart basis only (docs: 50) — never affects fills
  atrMult: number; // band mult, chart only — never affects fills
  adxThreshold: number; // entries pause below this when adxGate=true (docs: 20–25)
  adxGate: boolean; // true = directional filter; false = pure grid (grid edge lives in chop)
  direction: "long" | "short" | "both"; // sell-grid shorts tops (XAUUSD-style)
  reanchor: boolean; // true = trailing: fresh grid at close on escape
  entriesPerLevel: number; // stacked limits per level (1 = classic; tested, no benefit)
  bounceEntry: boolean; // enter only on snap-back bars (longs on up-bars, shorts on down-bars)
  lotOz: number; // fixed oz per entry (0 = auto perLevel sizing). 0.02 lots ≈ 2 oz
  leverage: number; // 0 = no margin constraint (spot-style); e.g. 1000 = MT5 CFD
  stopOutFrac: number; // stop-out when equity < marginUsed × this (Exness ≈ 0–0.2)
  // --- realistic costs, per side, in basis points ---
  commissionBps: number;
  spreadBps: number;
  slippageBps: number;
}

export const DEFAULTS: GridConfig = {
  mode: "atr",
  atrLen: 21, // XAUUSD-M15 validated 12mo: folds +57/+98/+68, test +69.5%, PF 1.93
  gridMult: 0.25, // small-step scalper: M15 steps clear costs, harvests both sides
  fixedTicks: 2,
  tickSize: 0.25,
  levelsEachSide: 4, // narrow book, fast turnover (220 RT/day on M15)
  emaLen: 50,
  atrMult: 1.5,
  adxThreshold: 20, // dormant while adxGate=false
  adxGate: false, // grid edge lives in chop — gate proven to cut profitable fills
  direction: "both", // always trade both sides — never long- or short-only
  reanchor: true,
  entriesPerLevel: 1,
  bounceEntry: true, // validated: PF 1.9→3.5, win 76→84%, all folds green
  lotOz: 0, // auto-size by equity; set e.g. 2 to force 0.02 lots like the video
  leverage: 0, // spot-style: no margin calls
  stopOutFrac: 0.2, // trailing: fixed ranges die in trends
  commissionBps: 0.3, // XAUUSD costs: commission + spread + slip, per side (bps)
  spreadBps: 0.5,
  slippageBps: 0.3,
};

export interface GridSetup {
  step: number;
  base: number;
  anchor: number; // first tradable bar (ainment may scan past dead minutes)
  lower: number[]; // long entries, ascending
  upper: number[]; // short entries, ascending
  atr: number[];
  adx: number[];
  basis: number[];
}

/** Build grid + indicators. Anchor bar = first bar after warmup. */
export function buildGrid(m: { h: number[]; l: number[]; c: number[] }, cfg: GridConfig, anchorIdx: number): GridSetup {
  const atr = ATR.calculate({ high: m.h, low: m.l, close: m.c, period: cfg.atrLen });
  const dmi = ADX.calculate({ high: m.h, low: m.l, close: m.c, period: cfg.atrLen });
  const basis = EMA.calculate({ values: m.c, period: cfg.emaLen });

  const n = m.c.length;
  const atrA = rightAlign(atr, n);
  const basisA = rightAlign(basis, n);
  const adxA = rightAlign(dmi.map((d) => d.adx), n);

  let anchor = anchorIdx;
  let step = cfg.mode === "atr" ? atrA[anchor] * cfg.gridMult : cfg.fixedTicks * cfg.tickSize;
  // Dead minutes (flat prices → ATR 0) can't anchor a grid — scan forward.
  // 1m forex is ~17% flat bars; a 5000-bar scan covers multi-hour dead stretches.
  // Also reject dust-steps: the anchor bar itself must fit inside its own range.
  const fits = (a: number, s: number) =>
    Number.isFinite(s) && s > 0 && m.h[a] - m.c[a] <= cfg.levelsEachSide * s && m.c[a] - m.l[a] <= cfg.levelsEachSide * s;
  while (!fits(anchor, step) && anchor < Math.min(anchorIdx + 5000, n - 2)) {
    anchor++;
    step = cfg.mode === "atr" ? atrA[anchor] * cfg.gridMult : cfg.fixedTicks * cfg.tickSize;
  }
  if (!fits(anchor, step)) throw new Error(`No valid grid step near bar ${anchorIdx}`);
  const base = m.c[anchor];
  const lower: number[] = [];
  const upper: number[] = [];
  for (let i = cfg.levelsEachSide; i >= 1; i--) lower.push(base - i * step);
  for (let i = 1; i <= cfg.levelsEachSide; i++) upper.push(base + i * step);
  return { step, base, anchor, lower, upper, atr: atrA, adx: adxA, basis: basisA };
}

import { ADX, ATR, EMA } from "technicalindicators";
import type { OHLC } from "./market.js";

function rightAlign(out: number[], n: number): number[] {
  const a = new Array(n).fill(NaN);
  const start = n - out.length;
  for (let i = 0; i < out.length; i++) a[start + i] = out[i];
  return a;
}

/** Warmup bars before anchor: ADX needs ~3x period to stabilize. */
export function warmup(cfg: GridConfig): number {
  return Math.max(cfg.emaLen, cfg.atrLen * 3);
}

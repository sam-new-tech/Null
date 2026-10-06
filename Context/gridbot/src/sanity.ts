// Sanity checks (npm test). No framework — throws on failure.
import { strict as assert } from "node:assert";
import { ADX, ATR, EMA } from "technicalindicators";
import { backtest } from "./backtest.js";
import { genMarket, genRangeMarket } from "./market.js";
import { DEFAULTS } from "./strategy.js";

// 1. ATR == Wilder RMA of TR (docs quiz: ta.sma(tr) is NOT ATR).
{
  const m = genMarket(100, 1);
  const atr = ATR.calculate({ high: m.h, low: m.l, close: m.c, period: 14 });
  const tr = m.h.map((h, i) =>
    i === 0 ? h - m.l[0] : Math.max(h - m.l[i], Math.abs(h - m.c[i - 1]), Math.abs(m.l[i] - m.c[i - 1])));
  const rma: number[] = [];
  rma[13] = tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (let i = 14; i < tr.length; i++) rma[i] = (tr[i] + rma[i - 1] * 13) / 14;
  const rel = Math.abs(atr[atr.length - 1] - rma[rma.length - 1]) / rma[rma.length - 1];
  assert(rel < 1e-3, `ATR != Wilder RMA (rel err ${rel})`);
  console.log("ok ATR == Wilder RMA");
}

// 2. ADX triple = Pine ta.dmi(): adx + pdi (+DI) + mdi (−DI).
{
  const m = genMarket(100, 2);
  const last = ADX.calculate({ high: m.h, low: m.l, close: m.c, period: 14 }).pop()!;
  assert(last.adx >= 0 && last.adx <= 100 && last.pdi >= 0 && last.mdi >= 0, "ADX triple broken");
  console.log(`ok ADX triple ADX=${last.adx.toFixed(1)} +DI=${last.pdi.toFixed(1)} -DI=${last.mdi.toFixed(1)}`);
}

// 3. EMA exists.
{
  const e = EMA.calculate({ values: genMarket(60, 3).c, period: 50 });
  assert(e.length > 0 && Number.isFinite(e[e.length - 1]), "EMA broken");
  console.log("ok EMA");
}

// 4. Long grid earns on chop; short grid earns on chop; both ≈ sum.
{
  const m = genRangeMarket(500, 7);
  const base = { ...DEFAULTS, mode: "atr" as const, adxGate: false, commissionBps: 0, spreadBps: 0, slippageBps: 0 };
  const lo = backtest(m, { ...base, direction: "long" });
  const sh = backtest(m, { ...base, direction: "short" });
  assert(lo.roundTrips > 5 && lo.gridReturnPct > 0, "long grid dead on chop");
  assert(sh.roundTrips > 5 && sh.gridReturnPct > 0, "short grid dead on chop");
  assert(lo.profitFactor > 1 && sh.profitFactor > 1, "PF must exceed 1 on chop");
  console.log(`ok grids on chop long=${lo.gridReturnPct.toFixed(1)}% short=${sh.gridReturnPct.toFixed(1)}%`);
}

// 5. Costs are actually charged: same run with costs earns less than without.
{
  const m = genRangeMarket(500, 7);
  const free = backtest(m, { ...DEFAULTS, mode: "atr" as const, adxGate: false, commissionBps: 0, spreadBps: 0, slippageBps: 0 });
  const paid = backtest(m, { ...DEFAULTS, mode: "atr" as const, adxGate: false });
  assert(paid.costsPaid > 0, "costs not charged");
  assert(paid.gridReturnPct < free.gridReturnPct, "costs not reducing return");
  console.log(`ok costs charged: free=${free.gridReturnPct.toFixed(2)}% paid=${paid.gridReturnPct.toFixed(2)}% costs=$${paid.costsPaid.toFixed(0)}`);
}

// 6. ATR step adapts to volatility.
{
  const calm = backtest(genRangeMarket(500, 7), { ...DEFAULTS, mode: "atr" as const, adxGate: false });
  const wild = backtest(genMarket(500, 7), { ...DEFAULTS, mode: "atr" as const, adxGate: false });
  assert(wild.step > calm.step, "ATR step not adaptive");
  console.log(`ok adaptive step calm=${calm.step.toFixed(2)} wild=${wild.step.toFixed(2)}`);
}

console.log("all sanity checks passed");

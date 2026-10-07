// Pure grid-bot logic: ATR grid construction, per-tick entry planning, sizing.
// No imports, no I/O, no timers. Mirrors the limit semantics of
// Context/gridbot backtest: longs buy lower[] levels and exit +step;
// shorts sell upper[] and cover -step; one lot per level within
// 0.49xstep; bounce entries (longs on up-bars, shorts on down-bars).

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface GridSetup {
  base: number;
  step: number;
  range: { lo: number; hi: number };
  lower: number[];
  upper: number[];
}

export interface BotPosition {
  id: string;
  side: 'buy' | 'sell';
  entry: number;
}

export interface RestingOrder {
  id: string;
  side: 'buy' | 'sell';
  price: number;
}

export type Intent =
  | { type: 'place'; side: 'buy' | 'sell'; level: number; tp: number; sl: number; volumeLots: number }
  | { type: 'cancel'; orderId: string }
  | { type: 'close'; positionId: string; volumeLots: number }
  | { type: 'escape' };

export function isUpBar(bar: Bar): boolean {
  return bar.close >= bar.open;
}

// Wilder ATR (RMA): first value = SMA of the first `period` true ranges,
// then RMA. Entries before seeding are null. Total: never throws.
export function atr(bars: Bar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (!Number.isFinite(period)) return out;
  const p = Math.floor(period);
  if (p < 1) return out;
  let count = 0;
  let sum = 0;
  let rma = 0;
  let seeded = false;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let t: number;
    if (i === 0) {
      t = b.high - b.low;
    } else {
      const pc = bars[i - 1].close;
      t = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
    if (!Number.isFinite(t)) {
      count = 0;
      sum = 0;
      seeded = false;
      out[i] = null;
      continue;
    }
    if (!seeded) {
      sum += t;
      count += 1;
      if (count === p) {
        rma = sum / p;
        seeded = true;
        out[i] = rma;
      } else {
        out[i] = null;
      }
    } else {
      rma = (rma * (p - 1) + t) / p;
      out[i] = Number.isFinite(rma) ? rma : null;
      if (out[i] === null) {
        seeded = false;
        count = 0;
        sum = 0;
      }
    }
  }
  return out;
}

// Anchor = last CLOSED bar close; step = ATR(at anchor) x gridMult;
// lower/upper = 1..levels steps from base. Throws on non-finite/zero step.
export function buildGrid(bars: Bar[], atrLen: number, gridMult: number, levels: number): GridSetup {
  const anchor = bars.length - 1;
  const base = anchor >= 0 ? bars[anchor].close : NaN;
  const a = atr(bars, atrLen);
  const atrAt = anchor >= 0 ? a[anchor] : null;
  const step = (atrAt === null ? NaN : (atrAt as number)) * gridMult;
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`buildGrid: bad step (atr=${String(atrAt)}, mult=${String(gridMult)})`);
  }
  if (!Number.isFinite(base)) {
    throw new Error('buildGrid: anchor close is not finite');
  }
  if (!Number.isFinite(levels) || Math.floor(levels) < 1) {
    throw new Error(`buildGrid: levels must be >= 1 (got ${String(levels)})`);
  }
  const lv = Math.floor(levels);
  const lower: number[] = [];
  for (let i = lv; i >= 1; i--) lower.push(base - i * step);
  const upper: number[] = [];
  for (let i = 1; i <= lv; i++) upper.push(base + i * step);
  return { base, step, range: { lo: base - lv * step, hi: base + lv * step }, lower, upper };
}

export function planTick(args: {
  grid: GridSetup;
  price: number;
  prevPrice: number | null;
  barDir: 'up' | 'down' | null;
  positions: BotPosition[];
  orders: RestingOrder[];
  volumeLots: number;
  disasterSteps?: number;
}): Intent[] {
  const { grid, price, prevPrice, barDir, positions, orders, volumeLots } = args;
  const disasterSteps = args.disasterSteps ?? 8;
  if (!Number.isFinite(price)) return [];
  const lo = grid?.range?.lo;
  const hi = grid?.range?.hi;
  if (Number.isFinite(lo) && Number.isFinite(hi)) {
    if (price < (lo as number) || price > (hi as number)) return [{ type: 'escape' }];
  }
  const step = grid?.step;
  if (!Number.isFinite(step) || (step as number) <= 0) return [];
  const s = step as number;
  const tol = 0.49 * s;
  const ds = Number.isFinite(disasterSteps) && (disasterSteps as number) > 0 ? (disasterSteps as number) : 8;
  const pos = Array.isArray(positions) ? positions : [];
  const ord = Array.isArray(orders) ? orders : [];
  const intents: Intent[] = [];

  if (barDir === 'up') {
    const lower = Array.isArray(grid.lower) ? grid.lower : [];
    for (const L of lower) {
      if (!Number.isFinite(L)) continue;
      const touched = prevPrice !== null && prevPrice !== undefined ? prevPrice > L && price <= L : price <= L;
      if (!touched) continue;
      if (pos.some((p) => p.side === 'buy' && Number.isFinite(p.entry) && Math.abs(p.entry - L) < tol)) continue;
      if (ord.some((o) => o.side === 'buy' && Number.isFinite(o.price) && Math.abs(o.price - L) < tol)) continue;
      intents.push({ type: 'place', side: 'buy', level: L, tp: L + s, sl: L - ds * s, volumeLots });
    }
  }

  if (barDir === 'down') {
    const upper = Array.isArray(grid.upper) ? grid.upper : [];
    for (const U of upper) {
      if (!Number.isFinite(U)) continue;
      const touched = prevPrice !== null && prevPrice !== undefined ? prevPrice < U && price >= U : price >= U;
      if (!touched) continue;
      if (pos.some((p) => p.side === 'sell' && Number.isFinite(p.entry) && Math.abs(p.entry - U) < tol)) continue;
      if (ord.some((o) => o.side === 'sell' && Number.isFinite(o.price) && Math.abs(o.price - U) < tol)) continue;
      intents.push({ type: 'place', side: 'sell', level: U, tp: U - s, sl: U + ds * s, volumeLots });
    }
  }

  return intents;
}

// --- DCA books (verified sim: first entries on the grid, adds every adverse
// step up to maxAdds, basket exit at average ± basketSteps*step). ---

/** Average entry of a book's legs. NaN when empty. */
export function dcaAvg(legs: { entry: number }[]): number {
  if (!Array.isArray(legs) || legs.length === 0) return NaN;
  let sum = 0;
  let qty = 0;
  for (const l of legs) {
    if (!Number.isFinite(l.entry)) return NaN;
    sum += l.entry;
    qty += 1;
  }
  return qty > 0 ? sum / qty : NaN;
}

/** Basket target: average ± basketSteps * step. */
export function dcaTarget(avg: number, side: 'buy' | 'sell', step: number, basketSteps: number): number {
  if (!Number.isFinite(avg) || !Number.isFinite(step) || step <= 0 || !Number.isFinite(basketSteps)) return NaN;
  return side === 'buy' ? avg + basketSteps * step : avg - basketSteps * step;
}

/** Next DCA add price: average ∓ one step. */
export function dcaNextAdd(avg: number, side: 'buy' | 'sell', step: number): number {
  if (!Number.isFinite(avg) || !Number.isFinite(step) || step <= 0) return NaN;
  return side === 'buy' ? avg - step : avg + step;
}

/** Crossed `level` between prevPrice and price (direction-aware). */
export function crossedLevel(side: 'buy' | 'sell', level: number, prevPrice: number | null, price: number): boolean {
  if (!Number.isFinite(level) || !Number.isFinite(price)) return false;
  if (prevPrice === null || prevPrice === undefined || !Number.isFinite(prevPrice)) {
    return side === 'buy' ? price <= level : price >= level;
  }
  return side === 'buy' ? prevPrice > level && price <= level : prevPrice < level && price >= level;
}

// lots = marginPerLevel x leverage / (price x unitsPerLot), floored to
// 0.01, min 0.01. Returns 0 on invalid inputs. Total: never throws.
export function lotsFor(marginPerLevel: number, price: number, leverage: number, unitsPerLot: number): number {
  if (
    !Number.isFinite(marginPerLevel) || marginPerLevel <= 0 ||
    !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(leverage) || leverage <= 0 ||
    !Number.isFinite(unitsPerLot) || unitsPerLot <= 0
  ) {
    return 0;
  }
  const raw = (marginPerLevel * leverage) / (price * unitsPerLot);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const floored = Math.floor(raw * 100 + 1e-9) / 100;
  return floored < 0.01 ? 0.01 : floored;
}

// Inverse of lotsFor: margin locked for `lots` at `price`.
// Returns 0 on invalid inputs. Total: never throws.
export function marginFor(lots: number, price: number, leverage: number, unitsPerLot: number): number {
  if (
    !Number.isFinite(lots) || lots < 0 ||
    !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(leverage) || leverage <= 0 ||
    !Number.isFinite(unitsPerLot) || unitsPerLot <= 0
  ) {
    return 0;
  }
  const margin = (lots * price * unitsPerLot) / leverage;
  return Number.isFinite(margin) && margin > 0 ? margin : 0;
}

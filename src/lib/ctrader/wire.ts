/**
 * Pure helpers for normalizing the cTrader JSON wire format.
 * No React/React Native imports, so these are unit-testable in plain Jest.
 */

/** Coerce a single object or an array into an array (some gateways send one). */
export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value !== undefined && value !== null) return [value as T];
  return [];
}

/** Symbol names arrive as `XAU/USD`; normalize to `XAUUSD`. */
export function normalizeSymbolName(name: string): string {
  return name.replace('/', '').toUpperCase();
}

/**
 * Amounts arrive as integers scaled by 10^digits. Missing values read as 0.
 */
export function money(value: number | undefined, digits: number | undefined): number {
  if (value === undefined) return 0;
  return value / Math.pow(10, digits ?? 2);
}

/**
 * Spot quotes arrive as 1e5-scaled integers (XAUUSD `414613000` → `4146.13`).
 * Pre-flattened doubles pass through untouched.
 */
export function scaleSpot(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Number.isInteger(raw) ? raw / 100000 : raw;
}

/** Seconds since the last inbound frame — drives the stale-stream UI. */
export function secondsSinceMessage(lastMessageAt: number, now = Date.now()): number {
  if (!lastMessageAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - lastMessageAt) / 1000);
}

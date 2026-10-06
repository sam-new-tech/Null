/**
 * cTrader Open API configuration.
 *
 * Credentials come from the environment (never committed):
 *   EXPO_PUBLIC_CTRADER_CLIENT_ID  — from openapi.ctrader.com portal
 *   EXPO_PUBLIC_CTRADER_CLIENT_SECRET — same portal (see warning below)
 *   EXPO_PUBLIC_CTRADER_ENV        — "demo" (default) or "live"
 *   EXPO_PUBLIC_CTRADER_SCOPE      — "trading" (default) or "accounts"
 *
 * SECURITY: the client secret is required by Spotware for both the token
 * exchange and the socket app-auth, so a pure mobile app must ship it.
 * Anything shipped can be extracted — treat this as the pragmatic interim
 * step. The hardened path is a tiny backend proxy that holds the secret and
 * performs the code exchange + refresh; the app then only ever sees tokens.
 */
import { Platform } from 'react-native';

export type CTraderEnv = 'demo' | 'live';

const env = (process.env.EXPO_PUBLIC_CTRADER_ENV ?? 'demo').toLowerCase();
export const CTRADER_ENV: CTraderEnv = env === 'live' ? 'live' : 'demo';

export const CTRADER_CLIENT_ID = process.env.EXPO_PUBLIC_CTRADER_CLIENT_ID ?? '';
// NOTE: bundled into the app binary. See module doc above for the proxy plan.
export const CTRADER_CLIENT_SECRET = process.env.EXPO_PUBLIC_CTRADER_CLIENT_SECRET ?? '';

export const CTRADER_SCOPE = process.env.EXPO_PUBLIC_CTRADER_SCOPE ?? 'trading';

/** Set when the portal credentials are present. Without it the app runs mock. */
export const CTRADER_CONFIGURED = CTRADER_CLIENT_ID.length > 0;

const HOSTS: Record<CTraderEnv, string> = {
  demo: 'demo.ctraderapi.com',
  live: 'live.ctraderapi.com',
};

/** wss on the JSON port (5036). Same host/port as TCP per Spotware docs. */
export function socketUrl(mode: CTraderEnv = CTRADER_ENV): string {
  return `wss://${HOSTS[mode]}:5036`;
}

const GRANT_URL = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/';

/** Exact URL from the Spotware auth doc. Extra params are not added. */
export function grantUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: CTRADER_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CTRADER_SCOPE,
    product: 'web',
  });
  return `${GRANT_URL}?${params.toString()}`;
}

const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';

/** GET per the code-exchange doc; POST per the refresh doc (params in query). */
export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  // Web goes through the same-origin /api/token proxy: the Spotware endpoint
  // has no CORS headers, so browsers block direct calls (native is unaffected).
  if (Platform.OS === 'web') {
    return proxyTokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CTRADER_CLIENT_ID,
    client_secret: CTRADER_CLIENT_SECRET,
  });
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  return parseTokenResponse(res);
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  if (Platform.OS === 'web') {
    return proxyTokens({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CTRADER_CLIENT_ID,
    client_secret: CTRADER_CLIENT_SECRET,
  });
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  return parseTokenResponse(res);
}

async function proxyTokens(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseTokenResponse(res);
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
}

async function parseTokenResponse(res: Response): Promise<TokenResponse> {
  const body = (await res.json()) as {
    accessToken?: string;
    tokenType?: string;
    expiresIn?: number;
    refreshToken?: string;
    errorCode?: string | null;
    description?: string | null;
  };
  if (!res.ok || body.errorCode || !body.accessToken || !body.refreshToken) {
    throw new Error(body.description ?? body.errorCode ?? `Token request failed (${res.status})`);
  }
  return {
    accessToken: body.accessToken,
    tokenType: body.tokenType ?? 'bearer',
    expiresIn: body.expiresIn ?? 2628000,
    refreshToken: body.refreshToken,
  };
}

/** Portal only accepts https:// — go through the Expo auth proxy (samuwayo).
 *  Currently used as the native return target until universal links exist. */
const PROXY_URI = 'https://auth.expo.io/@samuwayo/null';

/**
 * Where Spotware redirects with ?code=.
 * Override with EXPO_PUBLIC_CTRADER_REDIRECT_URI (e.g. production web origin).
 * Web: an already-registered portal URI — after Allow access the user copies
 * that URL and pastes it into the app (manual flow, no popup tricks needed).
 * Native: the Expo proxy (portal-registered); the proxy forwards to the app.
 */
export const MANUAL_REDIRECT_URI = 'https://openapi.ctrader.com';

export function redirectUri(): string {
  return (
    process.env.EXPO_PUBLIC_CTRADER_REDIRECT_URI ??
    (Platform.OS === 'web' ? MANUAL_REDIRECT_URI : PROXY_URI)
  );
}

/**
 * Where THIS app listens for the redirect back.
 * Web: the proxy URL itself (postMessage flow). Native: the custom scheme
 * (the proxy forwards there; needs the EAS-linked project for scheme lookup).
 */
export function returnUrl(): string {
  return Platform.OS === 'web' ? redirectUri() : 'xliquid://oauth';
}

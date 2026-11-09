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
const TOKEN_TIMEOUT_MS = 15000;

/**
 * Same-origin proxy used by the web build. Point this at a separately hosted
 * token proxy when the front end is deployed as a static site (for example a
 * Vercel/Cloudflare Function that implements the same POST contract).
 */
const TOKEN_PROXY_URL = process.env.EXPO_PUBLIC_CTRADER_TOKEN_PROXY_URL?.trim() || null;
/**
 * Same-origin candidates for the web token exchange. A configured URL wins
 * outright. Otherwise the non-obvious path goes first because some privacy
 * extensions and corporate proxies block URLs containing "token".
 */
const TOKEN_PROXY_URLS = TOKEN_PROXY_URL ? [TOKEN_PROXY_URL] : ['/api/ctrader/token', '/api/token'];

/** Network-level failure only — usable to decide whether another route is worth trying. */
class TokenTransportError extends Error {}

/** Manual timeout (no AbortSignal.timeout — older Hermes lacks it). */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TokenTransportError(`Token request timed out (${TOKEN_TIMEOUT_MS}ms)`);
    }
    throw new TokenTransportError(err instanceof Error ? err.message : 'Network request failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Web always uses the token proxy (Spotware has no CORS headers). Native talks
 * to Spotware directly unless an absolute proxy URL is configured, which is
 * useful on networks that block the token endpoint.
 */
function shouldUseTokenProxy(): boolean {
  return Platform.OS === 'web' || TOKEN_PROXY_URL !== null;
}

/** GET per the code-exchange doc; POST per the refresh doc (params in query). */
export async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  if (shouldUseTokenProxy()) {
    return proxyTokens({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CTRADER_CLIENT_ID,
    client_secret: CTRADER_CLIENT_SECRET,
  });
  const res = await fetchWithTimeout(`${TOKEN_URL}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  return parseTokenResponse(res);
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  if (shouldUseTokenProxy()) {
    return proxyTokens({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CTRADER_CLIENT_ID,
    client_secret: CTRADER_CLIENT_SECRET,
  });
  const res = await fetchWithTimeout(`${TOKEN_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  return parseTokenResponse(res);
}

async function proxyTokens(body: Record<string, string>): Promise<TokenResponse> {
  let lastError: unknown = null;
  for (const url of TOKEN_PROXY_URLS) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Transport failure (blocked path, offline server): try the next route.
      lastError = err;
      continue;
    }

    // A missing route (old deployment) or an HTML SPA fallback means this path
    // is not the token proxy. Try the next one; never re-send a code after a
    // real JSON response, because that exchange may already have consumed it.
    if (res.status === 404 || res.status === 405) {
      lastError = new Error(`${url} returned ${res.status}`);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      lastError = new Error(`${url} did not return JSON`);
      continue;
    }
    return parseTokenResponse(res);
  }

  // Every route failed at the network layer. "Failed to fetch" alone is
  // unactionable, so name the endpoints and the likely cause.
  throw new Error(
    `Could not reach the token server (${TOKEN_PROXY_URLS.join(', ')}). ` +
      'On web, serve the build with API routes (web.output "server") or set ' +
      'EXPO_PUBLIC_CTRADER_TOKEN_PROXY_URL to a hosted token proxy. On a device, ' +
      'that override must be an absolute https URL reachable from the phone. ' +
      (lastError instanceof Error ? `(${lastError.message})` : ''),
  );
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
}

async function parseTokenResponse(res: Response): Promise<TokenResponse> {
  let body: {
    accessToken?: string;
    tokenType?: string;
    expiresIn?: number;
    refreshToken?: string;
    errorCode?: string | null;
    description?: string | null;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON error pages (502 HTML, empty body) must keep the HTTP status.
    throw new Error(`Token request failed (${res.status})`);
  }
  if (!res.ok || body.errorCode || !body.accessToken || !body.refreshToken) {
    // Authorization codes are single-use: a network drop after the upstream
    // exchange consumes the code, so retrying the same pasted link always
    // fails. Tell the user to request a fresh one instead of a vague error.
    if (body.errorCode === 'ACCESS_DENIED') {
      throw new Error(
        'Authorization link was already used or expired. Tap “Connect with cTrader” again and paste the new redirect link.',
      );
    }
    throw new Error(body.description ?? body.errorCode ?? `Token request failed (${res.status})`);
  }
  const expiresIn = Number(body.expiresIn ?? 2628000);
  return {
    accessToken: body.accessToken,
    tokenType: body.tokenType ?? 'bearer',
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 2628000,
    refreshToken: body.refreshToken,
  };
}

/**
 * Optional HTTPS bridge that forwards the authorization result back to the
 * app (for example a tiny hosted page that deep-links `xliquid://oauth`, or a
 * web origin that completes the postMessage flow). It must be registered in
 * the cTrader Open API portal AND handled by the app.
 */
const REDIRECT_OVERRIDE = process.env.EXPO_PUBLIC_CTRADER_REDIRECT_URI?.trim() || null;

/**
 * Portal-registered fallback. After "Allow access", Spotware redirects here
 * with `?code=…`; the user copies that link and pastes it into the app. This
 * works on web and native without any extra hosting.
 */
export const MANUAL_REDIRECT_URI = 'https://openapi.ctrader.com';

/**
 * True when no automatic return bridge is configured, so the login screen
 * must show the "paste the redirect link" field up front. The old Expo auth
 * proxy (auth.expo.io) is deprecated and no longer completes sign-in, so
 * native defaults to the manual flow instead of pretending it will return.
 */
export const NEEDS_MANUAL_LINK = REDIRECT_OVERRIDE === null;

/** Where Spotware redirects with `?code=`. */
export function redirectUri(): string {
  return REDIRECT_OVERRIDE ?? MANUAL_REDIRECT_URI;
}

/**
 * Where THIS app listens for the redirect back. Only meaningful when a
 * working bridge is configured; otherwise the manual link flow is used.
 */
export function returnUrl(): string {
  return Platform.OS === 'web' ? redirectUri() : 'xliquid://oauth';
}

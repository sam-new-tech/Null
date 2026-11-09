/**
 * Legacy same-origin token proxy (web only). Kept so existing deployments keep
 * working; new clients also try /api/ctrader/token. Implementation lives in
 * src/lib/server/token-proxy.ts.
 */
export { handleTokenRequest as POST } from '@/lib/server/token-proxy';

/**
 * Same-origin cTrader token exchange (web only).
 *
 * Preferred path over /api/token because some privacy extensions and proxies
 * block URLs containing "token". Both routes share one implementation.
 */
export { handleTokenRequest as POST } from '@/lib/server/token-proxy';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import {
  CTRADER_CONFIGURED,
  redirectUri,
  exchangeCode,
  grantUrl,
  returnUrl,
} from '@/lib/ctrader/config';
import { liveEngine } from '@/lib/ctrader/live';
import { clearSession, loadSession, saveSession, type CTraderSession } from '@/lib/ctrader/session';

WebBrowser.maybeCompleteAuthSession();

interface AuthContextValue {
  connected: boolean;
  busy: boolean;
  hydrated: boolean;
  stage: string | null;
  error: string | null;
  live: boolean;
  login: () => Promise<void>;
  connectWithCode: (code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  connected: false,
  busy: false,
  hydrated: false,
  stage: null,
  error: null,
  live: false,
  login: async () => {},
  connectWithCode: async () => {},
  logout: async () => {},
});

function codeFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('code');
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  // Unconfigured (demo) builds hydrate instantly — nothing to restore.
  const [hydrated, setHydrated] = useState(!CTRADER_CONFIGURED);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  // Restore a stored session silently on launch.
  useEffect(() => {
    if (!CTRADER_CONFIGURED) return;
    loadSession().then((session) => {
      if (!session) {
        setHydrated(true);
        return;
      }
      setBusy(true);
      liveEngine
        .start(session)
        .then(() => {
          setConnected(true);
          setLive(true);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Restore failed');
        })
        .finally(() => {
          setBusy(false);
          setHydrated(true);
        });
    });
  }, []);

  const completeWithCode = useCallback(async (code: string) => {
    setStage('Exchanging code…');
    const tokens = await exchangeCode(code, redirectUri());
    const session = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
      ctidTraderAccountId: 0,
      isLive: false,
    };
    setStage('Connecting to cTrader…');
    await liveEngine.start(session);
    const stored = await loadSession();
    if (!stored) throw new Error('Session was not stored');
    setConnected(true);
    setLive(true);
    setStage(null);
  }, []);

  const connectWithCode = useCallback(
    async (code: string) => {
      setError(null);
      setBusy(true);
      try {
        await completeWithCode(code);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed');
        setStage(null);
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [completeWithCode],
  );

  const finishLoginWith = useCallback(async (session: CTraderSession) => {
    try {
      await saveSession(session);
      await liveEngine.start(session);
      const stored = await loadSession();
      if (!stored) throw new Error('Session was not stored');
      setConnected(true);
      setLive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const login = useCallback(async () => {
    setError(null);
    // No portal credentials yet: demo mode keeps every screen usable.
    if (!CTRADER_CONFIGURED) {
      setBusy(true);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        setConnected(true);
        setLive(false);
      } finally {
        setBusy(false);
      }
      return;
    }

    // Web: first-party /oauth callback completes via postMessage (see oauth.tsx).
    if (Platform.OS === 'web') {
      const listener = (event: MessageEvent) => {        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; ok?: boolean; reason?: string; session?: CTraderSession };
        if (data?.type !== 'ctrader-oauth') return;
        window.removeEventListener('message', listener);
        if (!data.ok || !data.session) {
          setError(typeof data.reason === 'string' ? data.reason : 'Authorization failed');
          setBusy(false);
          return;
        }
        finishLoginWith(data.session);
      };
      setBusy(true);
      window.addEventListener('message', listener);
      // If the tab closes without completing, openBrowserAsync resolves and
      // we reset; a real completion arrives first via postMessage.
      try {
        await WebBrowser.openBrowserAsync(grantUrl(redirectUri()));
      } finally {
        window.removeEventListener('message', listener);
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const result = await WebBrowser.openAuthSessionAsync(grantUrl(redirectUri()), returnUrl());
      if (result.type !== 'success') {
        if (result.type === 'cancel' || result.type === 'dismiss') return;
        throw new Error('Authorization was not completed');
      }
      const code = codeFromUrl(result.url);
      if (!code) throw new Error('No authorization code returned');
      await completeWithCode(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }, [completeWithCode, finishLoginWith]);

  const logout = useCallback(async () => {
    liveEngine.stop();
    await clearSession();
    setConnected(false);
    setLive(false);
    setError(null);
  }, []);

  return (
    <AuthContext.Provider value={{ connected, busy, hydrated, stage, error, live, login, connectWithCode, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

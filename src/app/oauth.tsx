import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { exchangeCode, REDIRECT_URI } from '@/lib/ctrader/config';
import type { CTraderSession } from '@/lib/ctrader/session';
import { Button } from 'panelui-native/components/button';
import { Text } from 'panelui-native/primitives/text';

type Status = 'working' | 'done' | 'error';

/**
 * First-party OAuth callback (web). The grant page redirects here with
 * ?code= (same origin, so no proxy needed). Exchanges the code, persists the
 * session to shared storage, notifies the opener and closes itself.
 */
export default function OAuthCallback() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const [status, setStatus] = useState<Status>('working');
  const [message, setMessage] = useState('Signing you in…');

  useEffect(() => {
    const code = typeof params.code === 'string' ? params.code : undefined;
    const denied = typeof params.error === 'string' ? params.error : undefined;
    if (denied && !code) {
      console.warn('[oauth] denied:', denied);
      setStatus('error');
      setMessage(`Access was not granted (${denied}). Close and retry.`);
      window.opener?.postMessage(
        { type: 'ctrader-oauth', ok: false, reason: denied },
        window.location.origin,
      );
      return;
    }
    if (!code) return;
    let cancelled = false;
    (async () => {
      try {
        console.log('[oauth] exchanging code…');
        const tokens = await exchangeCode(code, REDIRECT_URI);
        // Hand tokens to the opener: it persists + starts the engine in the
        // main context (popup storage is a different tab and must not be trusted).
        const session: CTraderSession = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
          ctidTraderAccountId: 0,
          isLive: false,
        };
        console.log('[oauth] session saved');
        if (!cancelled) {
          setStatus('done');
          setMessage('Signed in — closing…');
          window.opener?.postMessage(
            { type: 'ctrader-oauth', ok: true, session },
            window.location.origin,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Exchange failed';
        console.warn('[oauth] failed:', reason);
        if (!cancelled) {
          setStatus('error');
          setMessage(reason);
          window.opener?.postMessage(
            { type: 'ctrader-oauth', ok: false, reason },
            window.location.origin,
          );
        }
      } finally {
        setTimeout(() => window.close(), 1200);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000', padding: 32, gap: 16 }}>
      <Text weight="bold">{status === 'error' ? 'Sign-in failed' : 'Signing you in…'}</Text>
      {status !== 'working' && (
        <Text size="sm" muted className="text-center">
          {message}
        </Text>
      )}
      {status !== 'working' && (
        <Button size="sm" variant="outline" onPress={() => window.close()}>
          Close this window
        </Button>
      )}
      <Text size="sm" muted onPress={() => router.replace('/(auth)/login')} style={{ marginTop: 8 }}>
        Back to login
      </Text>
    </View>
  );
}

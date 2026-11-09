/**
 * Server-only cTrader token exchange (web).
 *
 * The Spotware token endpoint has no CORS headers, so browsers cannot call it
 * directly. This handler runs on the web server and performs the exchange.
 *
 * Routes that expose it:
 *   /api/ctrader/token  (preferred; less likely to be blocked by extensions)
 *   /api/token          (legacy path, kept for existing deployments)
 */

interface TokenRequestBody {
  grant_type?: string;
  code?: string;
  refresh_token?: string;
  redirect_uri?: string;
}

export async function handleTokenRequest(request: Request): Promise<Response> {
  let body: TokenRequestBody;
  try {
    body = (await request.json()) as TokenRequestBody;
  } catch {
    return Response.json({ errorCode: 'BAD_REQUEST', description: 'Invalid JSON body' }, { status: 400 });
  }

  // Server-only names are preferred, but hosted environments often only have
  // the EXPO_PUBLIC_* build vars configured (the same secret is already
  // embedded in native builds, so this does not widen exposure). Empty strings
  // are treated as unset — hosts frequently define vars with blank values.
  const clientId =
    process.env.CTRADER_CLIENT_ID?.trim() ||
    process.env.EXPO_PUBLIC_CTRADER_CLIENT_ID?.trim() ||
    '';
  const clientSecret =
    process.env.CTRADER_CLIENT_SECRET?.trim() ||
    process.env.EXPO_PUBLIC_CTRADER_CLIENT_SECRET?.trim() ||
    '';
  if (!clientId || !clientSecret) {
    return Response.json(
      {
        errorCode: 'NOT_CONFIGURED',
        description:
          'Server is missing cTrader credentials. Set CTRADER_CLIENT_SECRET (or EXPO_PUBLIC_CTRADER_CLIENT_SECRET) in the web host environment.',
      },
      { status: 500 },
    );
  }

  const params = new URLSearchParams({
    grant_type: body.grant_type === 'refresh_token' ? 'refresh_token' : 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (params.get('grant_type') === 'refresh_token') {
    if (!body.refresh_token) {
      return Response.json({ errorCode: 'BAD_REQUEST', description: 'Missing refresh_token' }, { status: 400 });
    }
    params.set('refresh_token', body.refresh_token);
  } else {
    if (!body.code || !body.redirect_uri) {
      return Response.json(
        { errorCode: 'BAD_REQUEST', description: 'Missing code or redirect_uri' },
        { status: 400 },
      );
    }
    params.set('code', body.code);
    params.set('redirect_uri', body.redirect_uri);
  }

  const method = params.get('grant_type') === 'refresh_token' ? 'POST' : 'GET';
  const upstream = await fetch(`https://openapi.ctrader.com/apps/token?${params.toString()}`, {
    method,
    headers: { Accept: 'application/json' },
  });
  const json = await upstream.json();
  return Response.json(json, { status: upstream.status });
}

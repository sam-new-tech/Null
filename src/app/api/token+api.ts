/**
 * Same-origin token proxy (web only).
 * The Spotware token endpoint has no CORS headers, so browsers block direct
 * calls. This route runs on the dev/server host (no CORS there) and — as a
 * bonus — the client secret never reaches the browser on web.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { grant_type?: string; code?: string; refresh_token?: string; redirect_uri?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ errorCode: 'BAD_REQUEST', description: 'Invalid JSON body' }, { status: 400 });
  }

  const clientId = process.env.EXPO_PUBLIC_CTRADER_CLIENT_ID ?? '';
  const clientSecret = process.env.CTRADER_CLIENT_SECRET ?? '';
  if (!clientId || !clientSecret) {
    return Response.json(
      { errorCode: 'NOT_CONFIGURED', description: 'Server is missing cTrader credentials' },
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
      return Response.json({ errorCode: 'BAD_REQUEST', description: 'Missing code or redirect_uri' }, { status: 400 });
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

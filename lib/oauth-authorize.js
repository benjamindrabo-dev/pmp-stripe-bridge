import {
  htmlEscape,
  normalizeScopes,
  originFromRequest,
  randomId,
  redirectUriAllowed,
  requestBodyParams,
  resourceAllowed,
  requiredSecret,
  safeEqual,
  signToken,
} from '../lib/mcp-oauth.js';

function errorPage(res, status, title, message) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title></head><body style="font-family:system-ui;max-width:680px;margin:48px auto;padding:0 20px"><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p></body></html>`);
}

function renderConsent(res, params, errorMessage = '') {
  const hidden = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join('\n');
  const scopeList = normalizeScopes(params.scope)
    .map((scope) => `<li><code>${htmlEscape(scope)}</code></li>`)
    .join('');
  const error = errorMessage
    ? `<p style="color:#a40000;font-weight:650">${htmlEscape(errorMessage)}</p>`
    : '';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(errorMessage ? 401 : 200).send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Pure Majesty Google Ads</title></head>
<body style="font-family:system-ui;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.45">
  <h1>Authorize Pure Majesty Google Ads + GA4</h1>
  <p>This private app will receive the following permissions:</p>
  <ul>${scopeList}</ul>
  ${error}
  <form method="post" action="/oauth/authorize">
    ${hidden}
    <label for="password" style="display:block;font-weight:650;margin:22px 0 6px">Owner password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required style="width:100%;box-sizing:border-box;padding:12px;font-size:16px">
    <button type="submit" style="margin-top:16px;padding:11px 18px;font-size:16px">Authorize</button>
  </form>
</body></html>`);
}

function requestParams(req) {
  return req.method === 'GET' ? req.query || {} : requestBodyParams(req);
}

function validateRequest(params, origin) {
  if (!params.client_id || String(params.client_id).length < 8) throw new Error('Missing or invalid OAuth client ID.');
  if (params.response_type !== 'code') throw new Error('Only response_type=code is supported.');
  if (!redirectUriAllowed(params.redirect_uri)) throw new Error('The OAuth redirect URI is not allowed.');
  if (!params.state) throw new Error('Missing OAuth state.');
  if (!params.code_challenge) throw new Error('PKCE code_challenge is required.');
  if (!resourceAllowed(params.resource, origin)) throw new Error('The OAuth resource is not allowed.');
  if (params.code_challenge_method !== 'S256') throw new Error('Only PKCE S256 is supported.');
  return {
    client_id: String(params.client_id),
    redirect_uri: String(params.redirect_uri),
    response_type: 'code',
    state: String(params.state),
    scope: normalizeScopes(params.scope).join(' '),
    code_challenge: String(params.code_challenge),
    code_challenge_method: 'S256',
    resource: params.resource ? String(params.resource) : '',
  };
}

export default function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  let params;
  try {
    params = validateRequest(requestParams(req), originFromRequest(req));
  } catch (error) {
    return errorPage(res, 400, 'Invalid OAuth request', error.message);
  }

  if (req.method === 'GET') return renderConsent(res, params);

  const password = String(requestBodyParams(req).password || '');
  const expectedPassword = requiredSecret('MCP_OWNER_PASSWORD', 16);
  if (!safeEqual(password, expectedPassword)) {
    return renderConsent(res, params, 'Incorrect owner password.');
  }

  const now = Math.floor(Date.now() / 1000);
  const code = signToken({
    typ: 'authorization_code',
    iss: 'pure-majesty-mcp',
    aud: params.client_id,
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    scope: params.scope,
    code_challenge: params.code_challenge,
    resource: params.resource,
    iat: now,
    nbf: now - 5,
    exp: now + 300,
    jti: randomId(),
  });

  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', params.state);
  return res.redirect(302, redirect.toString());
}

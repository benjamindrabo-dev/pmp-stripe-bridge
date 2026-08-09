import {
  normalizeScopes,
  parseBasicClient,
  pkceS256,
  randomId,
  requestBodyParams,
  requiredEnv,
  requiredSecret,
  safeEqual,
  signToken,
  verifySignedToken,
} from '../lib/mcp-oauth.js';

function oauthError(res, status, error, description) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  return res.status(status).json({ error, error_description: description });
}

function authenticateClient(req, body) {
  const basic = parseBasicClient(req);
  const clientId = String(basic?.clientId || body.client_id || '');
  const clientSecret = String(basic?.clientSecret || body.client_secret || '');
  if (!clientId || clientId.length < 8) throw new Error('Missing OAuth client ID.');

  const configuredClientId = requiredEnv('MCP_OAUTH_CLIENT_ID');
  if (safeEqual(clientId, configuredClientId)) {
    if (!safeEqual(clientSecret, requiredSecret('MCP_OAUTH_CLIENT_SECRET', 32))) {
      throw new Error('Invalid OAuth client credentials.');
    }
    return clientId;
  }

  // ChatGPT may generate its own OAuth client identifier for a connector.
  // Authentication of these clients is bound to the signed authorization code,
  // exact redirect URI and PKCE S256 verifier below. A supplied secret is ignored
  // because ChatGPT may still send one depending on connector configuration.
  return clientId;
}

function issueTokens({ clientId, scope, resource = '' }) {
  const now = Math.floor(Date.now() / 1000);
  const normalizedScope = normalizeScopes(scope).join(' ');
  const common = {
    iss: 'pure-majesty-mcp',
    sub: 'pure-majesty-owner',
    aud: resource || 'pure-majesty-mcp',
    client_id: clientId,
    scope: normalizedScope,
    iat: now,
    nbf: now - 5,
  };
  const accessToken = signToken({ ...common, typ: 'access', exp: now + 3600, jti: randomId() });
  const refreshToken = signToken({ ...common, typ: 'refresh', exp: now + 60 * 60 * 24 * 90, jti: randomId() });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: refreshToken,
    refresh_token_expires_in: 60 * 60 * 24 * 90,
    scope: normalizedScope,
  };
}

export default function handler(req, res) {
  if (req.method !== 'POST') return oauthError(res, 405, 'invalid_request', 'POST is required.');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  const body = requestBodyParams(req);
  let clientId;
  try {
    clientId = authenticateClient(req, body);
  } catch (error) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Pure Majesty MCP OAuth"');
    return oauthError(res, 401, 'invalid_client', error.message);
  }

  try {
    if (body.grant_type === 'authorization_code') {
      const payload = verifySignedToken(body.code, 'authorization_code');
      if (!safeEqual(payload.client_id, clientId)) throw new Error('Authorization code client mismatch.');
      if (!safeEqual(payload.redirect_uri, body.redirect_uri)) throw new Error('Authorization code redirect URI mismatch.');
      if (!body.code_verifier || !safeEqual(pkceS256(body.code_verifier), payload.code_challenge)) {
        throw new Error('PKCE verification failed.');
      }
      return res.status(200).json(issueTokens({
        clientId,
        scope: payload.scope,
        resource: payload.resource,
      }));
    }

    if (body.grant_type === 'refresh_token') {
      const payload = verifySignedToken(body.refresh_token, 'refresh');
      if (!safeEqual(payload.client_id, clientId)) throw new Error('Refresh token client mismatch.');
      const requested = body.scope
        ? normalizeScopes(body.scope, String(payload.scope || '').split(/\s+/))
        : normalizeScopes(payload.scope);
      const granted = requested.filter((scope) => String(payload.scope || '').split(/\s+/).includes(scope));
      if (!granted.length) throw new Error('No permitted scopes were requested.');
      return res.status(200).json(issueTokens({
        clientId,
        scope: granted,
        resource: payload.aud,
      }));
    }

    return oauthError(res, 400, 'unsupported_grant_type', 'Supported grants: authorization_code, refresh_token.');
  } catch (error) {
    return oauthError(res, 400, 'invalid_grant', error.message);
  }
}

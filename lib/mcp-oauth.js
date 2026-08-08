import crypto from 'node:crypto';

export const MCP_SCOPES = Object.freeze([
  'google-ads:read',
  'google-ads:write',
  'ga4:read',
  'offline_access',
]);

export const MCP_NON_SECRET_DEFAULTS = Object.freeze({
  GOOGLE_CLIENT_ID: '320852405325-nibnlp9dor8b4e6take8mbuga6829t58.apps.googleusercontent.com',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '5890800084',
  GOOGLE_ADS_CUSTOMER_ID: '2096373623',
  GA4_PROPERTY_ID: '526354130',
  MCP_OAUTH_CLIENT_ID: 'chatgpt-work-pmp',
});

export function requiredEnv(name) {
  const value = process.env[name] || MCP_NON_SECRET_DEFAULTS[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return String(value);
}

export function requiredSecret(name, minLength = 32) {
  const value = requiredEnv(name);
  if (value.length < minLength) {
    throw new Error(`${name} must contain at least ${minLength} characters.`);
  }
  return value;
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function signature(input, secret) {
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

export function signToken(payload, secret = requiredSecret('MCP_OAUTH_SIGNING_SECRET', 32)) {
  const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
  const body = encodeJson(payload);
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifySignedToken(
  token,
  expectedType,
  secret = requiredSecret('MCP_OAUTH_SIGNING_SECRET', 32),
) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed OAuth token.');
  const [headerPart, bodyPart, suppliedSignature] = parts;
  const unsigned = `${headerPart}.${bodyPart}`;
  const expectedSignature = signature(unsigned, secret);
  if (!safeEqual(suppliedSignature, expectedSignature)) {
    throw new Error('Invalid OAuth token signature.');
  }

  const header = decodeJson(headerPart);
  const payload = decodeJson(bodyPart);
  if (header.alg !== 'HS256') throw new Error('Unsupported OAuth token algorithm.');
  if (expectedType && payload.typ !== expectedType) {
    throw new Error(`Invalid OAuth token type; expected ${expectedType}.`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    throw new Error('OAuth token expired.');
  }
  if (Number.isFinite(payload.nbf) && payload.nbf > now + 30) {
    throw new Error('OAuth token is not active yet.');
  }
  return payload;
}

export function normalizeScopes(value, fallback = MCP_SCOPES) {
  const requested = Array.isArray(value)
    ? value
    : String(value || '').split(/\s+/).filter(Boolean);
  const unique = [...new Set(requested.filter((scope) => MCP_SCOPES.includes(scope)))];
  return unique.length ? unique : [...fallback];
}

export function scopeString(value, fallback = MCP_SCOPES) {
  return normalizeScopes(value, fallback).join(' ');
}

export function originFromRequest(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  if (!host) throw new Error('Unable to determine request host.');
  return `${proto}://${host}`;
}

export function redirectUriAllowed(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return false;

    const configured = String(process.env.MCP_ALLOWED_REDIRECT_HOSTS || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);

    if (configured.length) {
      return configured.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    }

    const host = url.hostname.toLowerCase();
    return (
      host === 'chatgpt.com' ||
      host.endsWith('.chatgpt.com') ||
      host === 'openai.com' ||
      host.endsWith('.openai.com')
    );
  } catch {
    return false;
  }
}

export function pkceS256(verifier) {
  return crypto.createHash('sha256').update(String(verifier || '')).digest('base64url');
}

export function parseBasicClient(req) {
  const header = String(req.headers?.authorization || '');
  if (!header.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

export function requestBodyParams(req) {
  const body = req?.body;
  if (!body) return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  return Object.fromEntries(new URLSearchParams(raw));
}

export function resourceAllowed(value, expectedOrigin) {
  if (!value) return true;
  try {
    const resource = new URL(String(value));
    const origin = new URL(String(expectedOrigin));
    return (
      resource.protocol === 'https:' &&
      resource.origin === origin.origin &&
      resource.pathname === '/api/mcp'
    );
  } catch {
    return false;
  }
}

export function htmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

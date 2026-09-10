/**
 * GoDaddy/Poynt Pay Links preparation. Not imported by any live checkout route.
 * Server-side only. No card data, raw customer data, or secrets are logged.
 * API contract: https://docs.poynt.com/api-reference/index.html (Paylinks).
 */
import { createHmac, createPrivateKey, randomUUID, sign, timingSafeEqual } from 'node:crypto';

const SERVICES = 'https://services.poynt.net';
const PAYLINKS = 'https://poynt.godaddy.com';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const APP_ID = /^urn:aid:[a-f0-9-]{36}$/i;
const MAX_BODY = 65536;

export class GoDaddyError extends Error {
  constructor(code, status = 503) { super(code); this.name = 'GoDaddyError'; this.code = code; this.status = status; }
}
function requireValue(condition, code, status = 400) { if (!condition) throw new GoDaddyError(code, status); }
function minor(value) { return Number.isSafeInteger(value) && value >= 0; }
function sameId(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function json64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function shortText(value, max) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), 'INVALID_TEXT');
  return value.trim();
}

export function readGoDaddyConfig(env = process.env) {
  return Object.freeze({
    enabled: env.PMP_GODADDY_ENABLED === '1',
    reviewApproved: env.PMP_GODADDY_REVIEW_APPROVED === '1',
    acceptanceVerified: env.PMP_GODADDY_ACCEPTANCE_VERIFIED === '1',
    businessId: String(env.GODADDY_BUSINESS_ID || '').trim(),
    storeId: String(env.GODADDY_STORE_ID || '').trim(),
    applicationId: String(env.GODADDY_APPLICATION_ID || '').trim(),
    privateKey: String(env.GODADDY_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    accessToken: String(env.GODADDY_ACCESS_TOKEN || '').trim(),
    webhookSecret: String(env.GODADDY_WEBHOOK_SECRET || ''),
    currency: String(env.GODADDY_CHARGE_CURRENCY || '').trim().toUpperCase(),
  });
}

/** Redacted, offline configuration check; this is NOT a merchant approval check. */
export function inspectGoDaddyConfig(config) {
  const missing = [];
  if (!UUID.test(config.businessId)) missing.push('GODADDY_BUSINESS_ID');
  if (!UUID.test(config.storeId)) missing.push('GODADDY_STORE_ID');
  // This bridge preparation intentionally supports only two-decimal CAD/USD.
  if (!['CAD', 'USD'].includes(config.currency)) missing.push('GODADDY_CHARGE_CURRENCY');
  if (!config.accessToken) {
    if (!APP_ID.test(config.applicationId) || !UUID.test(config.applicationId.slice(8))) missing.push('GODADDY_APPLICATION_ID');
    try {
      const key = createPrivateKey(config.privateKey);
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
    } catch { missing.push('GODADDY_PRIVATE_KEY'); }
  }
  if (config.webhookSecret.length < 32) missing.push('GODADDY_WEBHOOK_SECRET');
  return {
    mode: config.enabled ? 'enabled-by-operator' : 'disabled',
    credentialsConfigured: missing.length === 0,
    missing,
    reviewApprovalRecorded: config.reviewApproved,
    acceptanceTestsRecorded: config.acceptanceVerified,
    canCreateLinks: missing.length === 0 && config.enabled && config.reviewApproved && config.acceptanceVerified,
    accountAccessVerified: false,
  };
}

function assertCredentials(config) {
  const report = inspectGoDaddyConfig(config);
  requireValue(report.credentialsConfigured, 'GODADDY_CONFIGURATION_INCOMPLETE', 503);
}
function assertWriteEnabled(config) {
  assertCredentials(config);
  requireValue(config.enabled && config.reviewApproved && config.acceptanceVerified, 'GODADDY_NOT_ACTIVATED', 503);
}

/** Official Poynt JWT-bearer flow. The merchant must authorize this app separately. */
export function createGoDaddyAssertion(config, now = Date.now()) {
  requireValue(APP_ID.test(config.applicationId) && UUID.test(config.applicationId.slice(8)), 'INVALID_APPLICATION_ID');
  const iat = Math.floor(now / 1000);
  const payload = { iss: config.applicationId, sub: config.applicationId, aud: SERVICES, iat, exp: iat + 300, jti: randomUUID() };
  const input = `${json64({ alg: 'RS256', typ: 'JWT' })}.${json64(payload)}`;
  let signature;
  try { signature = sign('RSA-SHA256', Buffer.from(input), config.privateKey).toString('base64url'); }
  catch { throw new GoDaddyError('INVALID_PRIVATE_KEY'); }
  return `${input}.${signature}`;
}

/** Pure builder. Values MUST come from a server-validated, frozen Shopify quote. */
export function prepareGoDaddyIntent(quote, config, now = Date.now()) {
  requireValue(['CAD', 'USD'].includes(config.currency) && quote?.currency === config.currency, 'CURRENCY_MISMATCH');
  requireValue(minor(quote.amountMinor) && quote.amountMinor > 0, 'INVALID_AMOUNT');
  const reference = shortText(quote.reference, 100);
  requireValue(/^[A-Za-z0-9_-]+$/.test(reference), 'INVALID_REFERENCE');
  const title = shortText(quote.title, 160);
  const description = shortText(quote.description, 1000);
  requireValue(minor(quote.subtotalMinor) && minor(quote.discountMinor) && minor(quote.shippingMinor) && minor(quote.taxMinor), 'INVALID_BREAKDOWN');
  requireValue(quote.discountMinor <= quote.subtotalMinor && quote.subtotalMinor - quote.discountMinor + quote.shippingMinor + quote.taxMinor === quote.amountMinor, 'TOTAL_MISMATCH');
  return Object.freeze({
    provider: 'godaddy', version: 1, reference, title, description,
    businessId: config.businessId, storeId: config.storeId,
    transactionId: randomUUID(), requestId: randomUUID(),
    amountMinor: quote.amountMinor, currency: quote.currency,
    subtotalMinor: quote.subtotalMinor, discountMinor: quote.discountMinor,
    shippingMinor: quote.shippingMinor, taxMinor: quote.taxMinor,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(),
  });
}

function validateIntent(intent, config) {
  requireValue(intent?.provider === 'godaddy' && intent.version === 1, 'INVALID_INTENT');
  requireValue(UUID.test(intent.transactionId) && UUID.test(intent.requestId), 'INVALID_INTENT');
  requireValue(sameId(intent.businessId, config.businessId) && sameId(intent.storeId, config.storeId), 'MERCHANT_MISMATCH');
  requireValue(intent.currency === config.currency && minor(intent.amountMinor) && intent.amountMinor > 0, 'INVALID_INTENT');
  requireValue(minor(intent.subtotalMinor) && minor(intent.discountMinor) && minor(intent.shippingMinor) && minor(intent.taxMinor) && intent.discountMinor <= intent.subtotalMinor && intent.subtotalMinor - intent.discountMinor + intent.shippingMinor + intent.taxMinor === intent.amountMinor, 'TOTAL_MISMATCH');
  shortText(intent.reference, 100); shortText(intent.title, 160); shortText(intent.description, 1000);
}

/**
 * Injected fetch makes tests fully offline. No arbitrary URL/host is accepted.
 * No automatic POST retry: Pay Links idempotency must be verified on the account.
 */
export function createGoDaddyClient(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let cachedToken = null;
  let tokenExpires = 0;
  let tokenRequest = null;

  async function request(url, init) {
    let response;
    try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
    catch { throw new GoDaddyError('GODADDY_NETWORK_UNCERTAIN'); }
    if (!response.ok) throw new GoDaddyError(`GODADDY_HTTP_${response.status}`, response.status >= 500 ? 503 : 422);
    let data;
    try { data = await response.json(); }
    catch { throw new GoDaddyError('GODADDY_INVALID_RESPONSE'); }
    requireValue(data && typeof data === 'object', 'GODADDY_INVALID_RESPONSE', 502);
    return data;
  }
  async function accessToken() {
    assertCredentials(config);
    if (config.accessToken) return config.accessToken;
    if (cachedToken && tokenExpires > now() + 60000) return cachedToken;
    if (!tokenRequest) tokenRequest = (async () => {
      const body = new URLSearchParams({ grantType: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: createGoDaddyAssertion(config, now()) });
      const data = await request(`${SERVICES}/token`, { method: 'POST', headers: { Accept: 'application/json', 'api-version': '1.2', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      requireValue(typeof data.accessToken === 'string' && data.accessToken.length > 0 && Number.isFinite(data.expiresIn) && data.expiresIn > 0, 'GODADDY_INVALID_TOKEN_RESPONSE', 502);
      cachedToken = data.accessToken; tokenExpires = now() + data.expiresIn * 1000;
      return cachedToken;
    })();
    try { return await tokenRequest; } finally { tokenRequest = null; }
  }
  async function authorized(url, { method = 'GET', body, requestId } = {}) {
    const token = await accessToken();
    return request(url, { method, headers: { Authorization: `Bearer ${token}`, 'api-version': '1.2', 'Content-Type': 'application/json', ...(requestId ? { 'Poynt-Request-Id': requestId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  return {
    /** Read-only on merchant resources. Token exchange can make a POST /token. */
    async verifyAccountReadOnly() {
      assertCredentials(config);
      const store = await authorized(`${SERVICES}/businesses/${config.businessId}/stores/${config.storeId}`);
      requireValue(sameId(store.id, config.storeId), 'STORE_MISMATCH', 502);
      if (store.businessId != null) requireValue(sameId(store.businessId, config.businessId), 'MERCHANT_MISMATCH', 502);
      requireValue(store.currency === config.currency, 'STORE_CURRENCY_MISMATCH', 409);
      requireValue(store.status === 'ACTIVE', 'STORE_NOT_ACTIVE', 409);
      await authorized(`${PAYLINKS}/api/v2/stores/${config.storeId}/payLinks`);
      return { accountAccessVerified: true, payLinksReadable: true, livePaymentsTested: false, payoutAvailabilityTested: false };
    },
    /**
     * Durable storage contract:
     * reserve(intent) atomically reserves reference+requestId, returns true only
     * for the first attempt, and stores the frozen quote before any API write.
     * complete(intent,result) persists the correlation. Neither callback may log PII.
     * A failed/uncertain attempt stays reserved for explicit reconciliation.
     */
    async createOneTimePaylink(intent, storage) {
      assertWriteEnabled(config);
      validateIntent(intent, config);
      const remaining = Math.floor((Date.parse(intent.expiresAt) - now()) / 1000);
      requireValue(Number.isFinite(remaining) && remaining > 0 && remaining <= 3600, 'INTENT_EXPIRED');
      requireValue(typeof storage?.reserve === 'function' && typeof storage?.complete === 'function', 'DURABLE_STORAGE_REQUIRED', 503);
      requireValue(await storage.reserve(intent) === true, 'INTENT_ALREADY_RESERVED', 409);
      const data = await authorized(`${PAYLINKS}/api/v2/stores/${config.storeId}/payLinks/oneTime`, {
        method: 'POST', requestId: intent.requestId,
        body: { title: intent.title, description: `${intent.description} | Ref: ${intent.reference}`, amount: intent.amountMinor, currency: intent.currency, txnId: intent.transactionId, order: {}, expiry: remaining },
      });
      requireValue(sameId(data.businessId, config.businessId) && sameId(data.txnId, intent.transactionId) && UUID.test(data.orderId), 'GODADDY_CORRELATION_MISMATCH', 502);
      let checkout;
      try { checkout = new URL(data.url); } catch { throw new GoDaddyError('GODADDY_INVALID_CHECKOUT_URL', 502); }
      requireValue(checkout.origin === PAYLINKS && !checkout.username && !checkout.password && checkout.pathname.startsWith('/checkout/'), 'GODADDY_INVALID_CHECKOUT_URL', 502);
      requireValue(Number.isFinite(Date.parse(data.expires)) && Date.parse(data.expires) > now(), 'GODADDY_INVALID_EXPIRY', 502);
      const result = { provider: 'godaddy', checkoutUrl: checkout.href, sessionId: intent.reference, transactionId: data.txnId, orderId: data.orderId, businessId: config.businessId, storeId: config.storeId, amountMinor: intent.amountMinor, currency: intent.currency, expiresAt: data.expires };
      await storage.complete(intent, result);
      return result;
    },
    async getTransaction(transactionId) {
      assertCredentials(config);
      requireValue(UUID.test(transactionId), 'INVALID_TRANSACTION_ID');
      return authorized(`${SERVICES}/businesses/${config.businessId}/transactions/${transactionId}`);
    },
  };
}

/** Authenticate raw bytes BEFORE JSON parsing. Never follow event.links URLs. */
export function verifyGoDaddyWebhook(rawBody, signature, config) {
  requireValue(Buffer.isBuffer(rawBody) && rawBody.length <= MAX_BODY, 'INVALID_WEBHOOK_BODY', 400);
  requireValue(config.webhookSecret.length >= 32 && typeof signature === 'string' && /^[A-Za-z0-9+/]{27}=$/.test(signature), 'INVALID_WEBHOOK_SIGNATURE', 401);
  // HMAC-SHA1 is mandated by Poynt's webhook protocol, not an algorithm choice.
  const expected = createHmac('sha1', config.webhookSecret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'base64');
  requireValue(actual.length === expected.length && timingSafeEqual(actual, expected), 'INVALID_WEBHOOK_SIGNATURE', 401);
  let event;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new GoDaddyError('INVALID_WEBHOOK_JSON', 400); }
  requireValue(event && typeof event === 'object' && sameId(event.businessId, config.businessId) && sameId(event.storeId, config.storeId), 'WEBHOOK_MERCHANT_MISMATCH', 401);
  if (config.applicationId) requireValue(event.applicationId === config.applicationId, 'WEBHOOK_APPLICATION_MISMATCH', 401);
  requireValue(UUID.test(event.id) && UUID.test(event.resourceId), 'INVALID_WEBHOOK_IDENTIFIERS', 400);
  requireValue(['TRANSACTION_CAPTURED', 'TRANSACTION_UPDATED', 'TRANSACTION_REFUNDED', 'TRANSACTION_VOIDED'].includes(event.eventType) && event.resource === '/transactions', 'UNSUPPORTED_WEBHOOK_EVENT', 400);
  // Authentic notification only; this does not imply a captured or usable payment.
  return { eventId: event.id, transactionId: event.resourceId, eventType: event.eventType, businessId: event.businessId, storeId: event.storeId };
}

/** For full, immediate SALE transactions fetched directly through the trusted API. */
export function assertGoDaddySaleMatches(transaction, expected) {
  requireValue(UUID.test(expected?.transactionId) && UUID.test(expected?.businessId) && UUID.test(expected?.storeId) && minor(expected?.amountMinor) && expected.amountMinor > 0 && ['CAD', 'USD'].includes(expected?.currency), 'INVALID_EXPECTED_PAYMENT');
  requireValue(sameId(transaction?.id, expected.transactionId) && sameId(transaction?.context?.businessId, expected.businessId) && sameId(transaction?.context?.storeId, expected.storeId), 'TRANSACTION_MISMATCH', 409);
  requireValue(transaction.action === 'SALE' && transaction.status === 'CAPTURED' && transaction.voided === false && transaction.partiallyApproved !== true && transaction.actionVoid !== true && transaction.reversalVoid !== true, 'PAYMENT_NOT_CAPTURED', 409);
  requireValue(transaction.amounts?.transactionAmount === expected.amountMinor && transaction.amounts?.currency === expected.currency, 'PAYMENT_AMOUNT_MISMATCH', 409);
  if (expected.orderId) requireValue(transaction.references?.some(ref => ref.type === 'POYNT_ORDER' && sameId(ref.id, expected.orderId)), 'PAYMENT_ORDER_MISMATCH', 409);
  return { verified: true, transactionId: transaction.id, amountMinor: expected.amountMinor, currency: expected.currency };
}

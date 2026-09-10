import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { readGoDaddyConfig, inspectGoDaddyConfig, createGoDaddyAssertion, prepareGoDaddyIntent, createGoDaddyClient, verifyGoDaddyWebhook, assertGoDaddySaleMatches } from '../lib/godaddy-payments.js';

// Synthetic fixtures only. Never actual merchant IDs, tokens or card numbers.
const biz = '11111111-1111-4111-8111-111111111111';
const store = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const eventId = '44444444-4444-4444-8444-444444444444';
const app = 'urn:aid:55555555-5555-4555-8555-555555555555';
const now = 1788955200000;
const base = readGoDaddyConfig({ GODADDY_BUSINESS_ID: biz, GODADDY_STORE_ID: store, GODADDY_CHARGE_CURRENCY: 'CAD', GODADDY_ACCESS_TOKEN: 'synthetic-test-token', GODADDY_WEBHOOK_SECRET: 'synthetic-hook-secret-for-tests-only' });
const active = { ...base, enabled: true, reviewApproved: true, acceptanceVerified: true };
const quote = { reference: 'gd_test_cart_001', title: 'Pure Majesty Pets - test only', description: 'Synthetic quote, not a real offer', currency: 'CAD', subtotalMinor: 10000, discountMinor: 2000, shippingMinor: 500, taxMinor: 0, amountMinor: 8500 };
const intent = () => prepareGoDaddyIntent(quote, base, now);
const ok = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const errorCode = code => err => err.code === code;
const response = i => ({ businessId: biz, txnId: i.transactionId, orderId, url: `https://poynt.godaddy.com/checkout/${store}/onetime-${orderId}`, expires: new Date(now + 3600000).toISOString() });
const storage = () => {
  const states = new Map();
  return { states, reserve: async i => { if (states.has(i.reference)) return false; states.set(i.reference, { pending: i }); return true; }, complete: async (i, result) => { states.set(i.reference, { pending: i, result }); } };
};

test('disabled by default; offline readiness does not claim account approval', () => {
  const report = inspectGoDaddyConfig(base);
  assert.equal(report.credentialsConfigured, true);
  assert.equal(report.canCreateLinks, false);
  assert.equal(report.accountAccessVerified, false);
});
test('missing credentials reported by name, never values', () => {
  const report = inspectGoDaddyConfig(readGoDaddyConfig({}));
  assert.ok(report.missing.includes('GODADDY_BUSINESS_ID'));
  assert.ok(report.missing.includes('GODADDY_PRIVATE_KEY'));
  assert.ok(!JSON.stringify(inspectGoDaddyConfig(base)).includes(base.accessToken));
  assert.ok(!JSON.stringify(inspectGoDaddyConfig(base)).includes(base.webhookSecret));
});
test('only exact 1 enables flags', () => { assert.equal(readGoDaddyConfig({ PMP_GODADDY_ENABLED: 'true' }).enabled, false); });
test('amount breakdown and discount are preserved', () => { const i = intent(); assert.equal(i.amountMinor, 8500); assert.equal(i.discountMinor, 2000); assert.ok(Object.isFrozen(i)); });
for (const [label, change, code] of [
  ['wrong currency', { currency: 'USD' }, 'CURRENCY_MISMATCH'],
  ['negative amount', { amountMinor: -1 }, 'INVALID_AMOUNT'],
  ['fractional amount', { amountMinor: 8500.5 }, 'INVALID_AMOUNT'],
  ['zero amount', { amountMinor: 0 }, 'INVALID_AMOUNT'],
  ['unsafe integer', { amountMinor: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_AMOUNT'],
  ['incorrect total', { amountMinor: 8501 }, 'TOTAL_MISMATCH'],
  ['negative shipping', { shippingMinor: -1 }, 'INVALID_BREAKDOWN'],
  ['excess discount', { discountMinor: 10001 }, 'TOTAL_MISMATCH'],
  ['PII in reference', { reference: 'someone@example.test' }, 'INVALID_REFERENCE'],
]) test(`rejects ${label}`, () => assert.throws(() => prepareGoDaddyIntent({ ...quote, ...change }, base, now), errorCode(code)));

for (const flag of ['enabled', 'reviewApproved', 'acceptanceVerified']) test(`no API call while ${flag} is false`, async () => {
  let calls = 0;
  const client = createGoDaddyClient({ ...active, [flag]: false }, { fetchImpl: async () => { calls++; throw Error(); }, now: () => now });
  await assert.rejects(client.createOneTimePaylink(intent(), storage()), errorCode('GODADDY_NOT_ACTIVATED'));
  assert.equal(calls, 0);
});
test('rejects missing durable storage before network', async () => {
  const client = createGoDaddyClient(active, { fetchImpl: async () => { throw Error('must not run'); }, now: () => now });
  await assert.rejects(client.createOneTimePaylink(intent()), errorCode('DURABLE_STORAGE_REQUIRED'));
});
test('creates one-time link only after reserving frozen quote; blocks duplicate calls', async () => {
  const i = intent(), db = storage(); let calls = 0;
  const client = createGoDaddyClient(active, { now: () => now, fetchImpl: async (url, options) => {
    calls++; assert.ok(db.states.has(i.reference));
    assert.equal(url, `https://poynt.godaddy.com/api/v2/stores/${store}/payLinks/oneTime`);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.amount, 8500); assert.equal(body.currency, 'CAD'); assert.equal(body.txnId, i.transactionId); assert.equal(body.expiry, 3600);
    return ok(response(i));
  } });
  const result = await client.createOneTimePaylink(i, db);
  assert.equal(result.orderId, orderId); assert.equal(db.states.get(i.reference).result.transactionId, i.transactionId);
  await assert.rejects(client.createOneTimePaylink(i, db), errorCode('INTENT_ALREADY_RESERVED'));
  assert.equal(calls, 1);
});
test('network uncertainty is never retried automatically and remains reserved', async () => {
  const i = intent(), db = storage(); let calls = 0;
  const client = createGoDaddyClient(active, { now: () => now, fetchImpl: async () => { calls++; throw Error('contains token: DO-NOT-EXPOSE'); } });
  await assert.rejects(client.createOneTimePaylink(i, db), errorCode('GODADDY_NETWORK_UNCERTAIN'));
  await assert.rejects(client.createOneTimePaylink(i, db), errorCode('INTENT_ALREADY_RESERVED'));
  assert.equal(calls, 1);
});
for (const [label, overrides, code] of [
  ['different merchant', { businessId: store }, 'GODADDY_CORRELATION_MISMATCH'],
  ['different transaction', { txnId: orderId }, 'GODADDY_CORRELATION_MISMATCH'],
  ['malicious checkout host', { url: 'https://attacker.example/checkout/test' }, 'GODADDY_INVALID_CHECKOUT_URL'],
  ['HTTP checkout', { url: 'http://poynt.godaddy.com/checkout/test' }, 'GODADDY_INVALID_CHECKOUT_URL'],
  ['credentials in checkout URL', { url: 'https://user:pass@poynt.godaddy.com/checkout/test' }, 'GODADDY_INVALID_CHECKOUT_URL'],
  ['expired response', { expires: '2000-01-01T00:00:00Z' }, 'GODADDY_INVALID_EXPIRY'],
]) test(`rejects ${label} response`, async () => {
  const i = intent(); const client = createGoDaddyClient(active, { now: () => now, fetchImpl: async () => ok({ ...response(i), ...overrides }) });
  await assert.rejects(client.createOneTimePaylink(i, storage()), errorCode(code));
});
test('read-only preflight does not create links, and checks currency and store', async () => {
  const methods = [];
  const client = createGoDaddyClient(base, { fetchImpl: async (url, options) => {
    methods.push(options.method);
    return ok(url.endsWith('/payLinks') ? { checkoutUrls: [] } : { id: store, businessId: biz, currency: 'CAD', status: 'ACTIVE' });
  } });
  assert.equal((await client.verifyAccountReadOnly()).accountAccessVerified, true);
  assert.deepEqual(methods, ['GET', 'GET']);
});
test('read-only preflight rejects wrong merchant currency', async () => {
  const client = createGoDaddyClient(base, { fetchImpl: async () => ok({ id: store, currency: 'USD', status: 'ACTIVE' }) });
  await assert.rejects(client.verifyAccountReadOnly(), errorCode('STORE_CURRENCY_MISMATCH'));
});
test('JWT has correct RS256 signature, audience, application and five-minute lifetime', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = { ...base, accessToken: '', applicationId: app, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const assertion = createGoDaddyAssertion(cfg, now);
  const [header, payload, signature] = assertion.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  assert.equal(claims.aud, 'https://services.poynt.net'); assert.equal(claims.iss, app); assert.equal(claims.exp - claims.iat, 300);
  assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), pair.publicKey, Buffer.from(signature, 'base64url')));
  let tokenCalls = 0;
  const client = createGoDaddyClient(cfg, { now: () => now, fetchImpl: async (url, options) => {
    if (url.endsWith('/token')) { tokenCalls++; assert.ok(new URLSearchParams(options.body).get('assertion')); return ok({ accessToken: 'synthetic-token', expiresIn: 86400 }); }
    return ok(url.endsWith('/payLinks') ? {} : { id: store, currency: 'CAD', status: 'ACTIVE' });
  } });
  await client.verifyAccountReadOnly(); await client.verifyAccountReadOnly(); assert.equal(tokenCalls, 1);
});
const event = () => ({ id: eventId, businessId: biz, storeId: store, resourceId: orderId, eventType: 'TRANSACTION_CAPTURED', resource: '/transactions' });
const signed = payload => { const raw = Buffer.from(JSON.stringify(payload)); return [raw, createHmac('sha1', base.webhookSecret).update(raw).digest('base64')]; };
test('accepts valid raw webhook signature without treating it as payment proof', () => {
  const e = verifyGoDaddyWebhook(...signed(event()), base); assert.equal(e.transactionId, orderId); assert.equal(e.paid, undefined);
});
test('rejects tampered webhook body', () => {
  const [raw, sig] = signed(event()); assert.throws(() => verifyGoDaddyWebhook(Buffer.concat([raw, Buffer.from(' ')]), sig, base), errorCode('INVALID_WEBHOOK_SIGNATURE'));
});
test('rejects unsigned and malformed signatures', () => {
  for (const sig of ['', 'bad', 'A'.repeat(100)]) assert.throws(() => verifyGoDaddyWebhook(Buffer.from('{}'), sig, base), errorCode('INVALID_WEBHOOK_SIGNATURE'));
});
test('rejects other merchant even with valid signature', () => { assert.throws(() => verifyGoDaddyWebhook(...signed({ ...event(), businessId: store }), base), errorCode('WEBHOOK_MERCHANT_MISMATCH')); });
test('rejects order-completed notification as transaction proof', () => { assert.throws(() => verifyGoDaddyWebhook(...signed({ ...event(), eventType: 'ORDER_COMPLETED', resource: '/orders' }), base), errorCode('UNSUPPORTED_WEBHOOK_EVENT')); });
const expected = { transactionId: eventId, businessId: biz, storeId: store, orderId, amountMinor: 8500, currency: 'CAD' };
const transaction = () => ({ id: eventId, context: { businessId: biz, storeId: store }, status: 'CAPTURED', action: 'SALE', voided: false, amounts: { transactionAmount: 8500, currency: 'CAD' }, references: [{ type: 'POYNT_ORDER', id: orderId }] });
test('accepts exact captured sale retrieved from trusted API', () => { assert.equal(assertGoDaddySaleMatches(transaction(), expected).verified, true); });
for (const status of ['AUTHORIZED', 'PARTIALLY_CAPTURED', 'DECLINED', 'REFUNDED', 'VOIDED', 'STEP_UP']) test(`rejects transaction status ${status}`, () => { assert.throws(() => assertGoDaddySaleMatches({ ...transaction(), status }, expected), errorCode('PAYMENT_NOT_CAPTURED')); });
test('rejects partial approval and voided sale', () => {
  for (const change of [{ voided: true }, { partiallyApproved: true }, { action: 'AUTHORIZE' }]) assert.throws(() => assertGoDaddySaleMatches({ ...transaction(), ...change }, expected), errorCode('PAYMENT_NOT_CAPTURED'));
});
test('rejects mismatching total or currency', () => {
  for (const amounts of [{ transactionAmount: 1, currency: 'CAD' }, { transactionAmount: 8500, currency: 'USD' }]) assert.throws(() => assertGoDaddySaleMatches({ ...transaction(), amounts }, expected), errorCode('PAYMENT_AMOUNT_MISMATCH'));
});
test('rejects reused payment from another order', () => { assert.throws(() => assertGoDaddySaleMatches({ ...transaction(), references: [] }, expected), errorCode('PAYMENT_ORDER_MISMATCH')); });
test('rejects HTTP error without exposing provider response data', async () => {
  const client = createGoDaddyClient(base, { fetchImpl: async () => new Response('secret-account-details', { status: 403 }) });
  await assert.rejects(client.verifyAccountReadOnly(), err => err.code === 'GODADDY_HTTP_403' && !err.message.includes('secret'));
});

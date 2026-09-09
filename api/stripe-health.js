// Read-only configuration checks; the optional signature probe never creates a payment.
import { createHash, createHmac, randomUUID } from 'node:crypto';

const EXPECTED_ACCOUNT = 'acct_1UDbyTPw2Aen0E79';
const WEBHOOK_ID = 'we_1UDcMEPw2Aen0E79RIgwUg8c';
const WEBHOOK_URL = 'https://pmp-stripe-bridge.vercel.app/api/stripe-webhook';
// One-way fingerprint only. The signing secret remains exclusively in Vercel.
const WEBHOOK_FINGERPRINT = '1db4ea3e138a3ad3765b2acdc49214d08d94650be53e32442b0a7eb8f48e8890';
let cached = null;
let probeCache = null;

async function stripeGet(path, key) {
  const response = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('stripe_configuration_unavailable');
  return response.json();
}

async function signatureProbe(secret) {
  if (probeCache && Date.now() - probeCache.at < 3600000) return probeCache.result;
  // This unhandled diagnostic event cannot enter either paid-checkout branch.
  const now = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({
    id: 'evt_pmp_config_' + randomUUID(), object: 'event', created: now,
    livemode: true, type: 'pmp.configuration_probe', data: { object: {} },
  });
  const signature = createHmac('sha256', secret).update(now + '.' + raw).digest('hex');
  const post = (sig) => fetch(WEBHOOK_URL, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=' + now + ',v1=' + sig },
    body: raw, signal: AbortSignal.timeout(10000),
  });
  const invalid = await post('0'.repeat(64));
  const invalidBody = await invalid.json().catch(() => null);
  const valid = await post(signature);
  const body = await valid.json().catch(() => null);
  const result = {
    validSignatureAccepted: valid.status === 200 && body?.received === true,
    // stripe-webhook.js rejects invalid signatures with 401, not malformed-JSON 400.
    invalidSignatureRejected: invalid.status === 401 && invalidBody?.error === 'Bad signature',
    validSignatureStatus: valid.status,
    invalidSignatureStatus: invalid.status,
    paidEventTested: false,
  };
  probeCache = { at: Date.now(), result };
  return result;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const signingSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  const publicKey = process.env.STRIPE_PUBLISHABLE_KEY || (await import('../lib/stripe-cad-bridge.js')).PUBLIC_KEY;
  const report = {
    revision: 'pmp-stripe-cad-live-2026-09-09',
    checkoutProvider: 'square',
    chargeCurrency: 'CAD',
    displayCurrency: 'shopify_market',
    serverKeyConfigured: /^(sk|rk)_live_/.test(secret),
    webhookSecretMatches: createHash('sha256').update(signingSecret).digest('hex') === WEBHOOK_FINGERPRINT,
    publishableKeyConfigured: /^pk_live_[A-Za-z0-9]+$/.test(publicKey),
    accountMatches: false, chargesEnabled: false, payoutsEnabled: false,
    webhookRegistered: false,
    checkoutChangedByThisCheck: false,
  };
  try {
    if (report.serverKeyConfigured) {
      if (!cached || Date.now() - cached.at > 60000) {
        const [account, webhook] = await Promise.all([
          stripeGet('account', secret), stripeGet('webhook_endpoints/' + WEBHOOK_ID, secret),
        ]);
        cached = { at: Date.now(), account, webhook };
      }
      report.accountMatches = cached.account.id === EXPECTED_ACCOUNT;
      report.chargesEnabled = cached.account.charges_enabled === true;
      report.payoutsEnabled = cached.account.payouts_enabled === true;
      report.webhookRegistered = cached.webhook.status === 'enabled' && cached.webhook.livemode === true &&
        cached.webhook.url === WEBHOOK_URL &&
        ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].every(e => cached.webhook.enabled_events?.includes(e));
    }
    const wantsProbe = new URL(req.url, 'https://pmp-stripe-bridge.vercel.app').searchParams.get('probe') === '1';
    if (wantsProbe && report.accountMatches && report.webhookSecretMatches && report.webhookRegistered) {
      report.signatureProbe = await signatureProbe(signingSecret);
    }
    report.serverReady = report.serverKeyConfigured && report.webhookSecretMatches && report.accountMatches &&
      report.chargesEnabled && report.webhookRegistered;
    if (wantsProbe) report.serverReady = report.serverReady && report.signatureProbe?.validSignatureAccepted === true &&
      report.signatureProbe?.invalidSignatureRejected === true;
    return res.status(200).json(report);
  } catch {
    return res.status(503).json({ ...report, serverReady: false, error: 'Configuration verification unavailable' });
  }
}

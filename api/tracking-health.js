// GET /api/tracking-health
// Safe operational health check. It never returns secret values.
function host(value) {
  if (!value) return null;
  try { return new URL(value).hostname || null; } catch { return null; }
}
function path(value) {
  if (!value) return null;
  try { return new URL(value).pathname || null; } catch { return null; }
}
async function audit1565() {
  const id = 'cs_live_b1wFNLti8zTYT0f1nQR48elbHsrKvA0XGOV6Wjlk9kQMN7ONYSVkBaG1z1';
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const s = await r.json();
  if (!r.ok) throw new Error(s?.error?.message || `Stripe ${r.status}`);
  const m = s.metadata || {};
  return {
    paid: s.payment_status === 'paid',
    amount_total: s.amount_total ?? null,
    currency: s.currency ? String(s.currency).toUpperCase() : null,
    has_fbc: Boolean(m.fbc),
    has_fbp: Boolean(m.fbp),
    has_gclid: Boolean(m.gclid),
    has_gbraid: Boolean(m.gbraid),
    has_wbraid: Boolean(m.wbraid),
    has_ttclid: Boolean(m.ttclid),
    has_msclkid: Boolean(m.msclkid),
    utm_source: m.utm_source || null,
    utm_medium: m.utm_medium || null,
    utm_campaign: m.utm_campaign || null,
    utm_content: m.utm_content || null,
    utm_term: m.utm_term || null,
    referrer_host: host(m.referrer),
    landing_host: host(m.landing_page),
    landing_path: path(m.landing_page),
  };
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const stripeKey = String(process.env.STRIPE_SECRET_KEY || "");
  const pixelId = String(process.env.META_PIXEL_ID || "");
  const required = {
    stripe_secret_key: Boolean(stripeKey),
    stripe_webhook_secret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    shopify_admin_token: Boolean(process.env.SHOPIFY_ADMIN_TOKEN),
    upstash_url: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    upstash_token: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
    meta_pixel_id: Boolean(pixelId),
    meta_capi_token: Boolean(process.env.META_CAPI_TOKEN),
  };
  const result = {
    ok: Object.values(required).every(Boolean),
    tracking_version: "pmp_v3_google",
    environment: process.env.VERCEL_ENV || null,
    deployment_commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    meta: { pixel_id: pixelId || null, capi_token_configured: required.meta_capi_token },
    google_ads: {
      conversion_id: "AW-18031615333",
      conversion_label: "jlQICMeV844cEOW6kpZD",
      enhanced_conversion_user_data: "sha256_email_and_optional_phone",
      server_api_upload: false,
    },
    stripe: {
      mode: stripeKey.startsWith("sk_live_") ? "live" : stripeKey.startsWith("sk_test_") ? "test" : stripeKey ? "configured" : "missing",
      webhook_secret_configured: required.stripe_webhook_secret,
    },
    store_origin: process.env.STORE_ORIGIN || null,
    dependencies: required,
  };
  if (String(req.query?.audit || '') === '1565') {
    try { result.order_1565_audit = await audit1565(); }
    catch (error) { result.order_1565_audit = { error: String(error?.message || error) }; }
  }
  return res.status(200).json(result);
}

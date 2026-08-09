// GET /api/tracking-health
// Safe operational health check. It never returns secret values.

async function stripeSessionAttribution(id) {
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const s = await r.json();
  if (!r.ok) throw new Error(s?.error?.message || `Stripe ${r.status}`);
  const m = s.metadata || {};
  let referrerHost = null;
  let landingPath = null;
  try { referrerHost = m.referrer ? new URL(m.referrer).hostname : null; } catch {}
  try { landingPath = m.landing_page ? new URL(m.landing_page).pathname : null; } catch {}
  return {
    paid: s.payment_status === 'paid',
    amount_total: s.amount_total ?? null,
    currency: s.currency ? String(s.currency).toUpperCase() : null,
    has_fbc: Boolean(m.fbc),
    has_fbp: Boolean(m.fbp),
    has_gclid: Boolean(m.gclid),
    has_gbraid: Boolean(m.gbraid),
    has_wbraid: Boolean(m.wbraid),
    utm_source: m.utm_source || null,
    utm_medium: m.utm_medium || null,
    utm_campaign: m.utm_campaign || null,
    referrer_host: referrerHost,
    landing_path: landingPath,
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

  const out = {
    ok: Object.values(required).every(Boolean),
    tracking_version: "pmp_v3_google",
    environment: process.env.VERCEL_ENV || null,
    deployment_commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    meta: {
      pixel_id: pixelId || null,
      capi_token_configured: required.meta_capi_token,
    },
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

  if (String(req.query?.audit || '') === 'recent-meta') {
    out.recent_meta_audit = {};
    for (const [order, id] of Object.entries({
      '#1557': 'cs_live_b168HOGF8QJv6218uChGZ0NdEAyTwMpAzzwY5Pw32lxilc4zUJH8lfxVNK',
      '#1558': 'cs_live_b1TTMfQg9cYxmtoEwKkCZINYaYVgNrvDLEHHJDUOAGXNWrNsOiNDcBeTaw',
    })) {
      try { out.recent_meta_audit[order] = await stripeSessionAttribution(id); }
      catch (e) { out.recent_meta_audit[order] = { error: String(e?.message || e) }; }
    }
  }

  return res.status(200).json(out);
}

// GET /api/tracking-health
// Safe operational health check. It never returns secret values.

const AUDIT_SESSIONS = [
  { order: '#1555', id: 'cs_live_b11IlNrz6p6URvQZ9aKa95D0PZ52grmYKc56cZ0ybmVA08JrhL0YTAANsC' },
  { order: '#1556', id: 'cs_live_b1wQCGJmc1zhuMUXVSIQo1ERDaTVLHRfz9bs9JWUwCgGj8juFxsIaet1z2' },
];

function safeHost(value) {
  if (!value) return null;
  try { return new URL(value).hostname || null; } catch { return null; }
}

function safePath(value) {
  if (!value) return null;
  try { return new URL(value).pathname || null; } catch { return null; }
}

function classify(metadata) {
  const m = metadata || {};
  const source = String(m.utm_source || '').toLowerCase();
  if (m.gclid || m.gbraid || m.wbraid || source.includes('google')) return 'google';
  if (m.fbc || m.fbp || source.includes('facebook') || source.includes('meta') || source.includes('instagram')) return 'meta';
  if (m.ttclid || source.includes('tiktok')) return 'tiktok';
  if (m.msclkid || source.includes('bing') || source.includes('microsoft')) return 'microsoft';
  if (source) return source;
  return safeHost(m.referrer) || 'direct_or_unknown';
}

async function auditAttribution() {
  const results = [];
  for (const item of AUDIT_SESSIONS) {
    try {
      const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(item.id)}`, {
        headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      });
      const session = await response.json();
      if (!response.ok) throw new Error(session?.error?.message || `Stripe ${response.status}`);
      const m = session.metadata || {};
      results.push({
        order: item.order,
        source: classify(m),
        landing_host: safeHost(m.landing_page),
        landing_path: safePath(m.landing_page),
        referrer_host: safeHost(m.referrer),
        utm_source: m.utm_source || null,
        utm_medium: m.utm_medium || null,
        utm_campaign: m.utm_campaign || null,
        utm_content: m.utm_content || null,
        utm_term: m.utm_term || null,
        has_gclid: Boolean(m.gclid),
        has_gbraid: Boolean(m.gbraid),
        has_wbraid: Boolean(m.wbraid),
        has_fbc: Boolean(m.fbc),
        has_fbp: Boolean(m.fbp),
        has_ttclid: Boolean(m.ttclid),
        has_msclkid: Boolean(m.msclkid),
      });
    } catch (error) {
      results.push({ order: item.order, error: String(error?.message || error) });
    }
  }
  console.log('TMP_ATTRIBUTION_AUDIT_1555_1556', JSON.stringify(results));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const auditRequested = String(req.query?.audit || '') === '1555-1556';
  if (auditRequested) await auditAttribution();

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

  return res.status(200).json({
    ok: Object.values(required).every(Boolean),
    tracking_version: "pmp_v3_google",
    audit_logged: auditRequested,
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
  });
}

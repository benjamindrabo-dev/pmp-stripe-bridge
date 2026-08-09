// GET /api/tracking-health
// Safe operational health check. It never returns secret values.

async function googleAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN || '',
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `Google OAuth ${r.status}`);
  return j.access_token;
}

async function googleAddToCartClicks() {
  const token = await googleAccessToken();
  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID || '6591205737').replace(/\D/g, '');
  const query = `SELECT click_view.gclid, campaign.id, campaign.name, segments.date, segments.hour, segments.conversion_action_name, metrics.all_conversions, metrics.all_conversions_value FROM click_view WHERE segments.date DURING LAST_7_DAYS AND segments.conversion_action_name = 'puremajestypet.com (web) add_to_cart' AND metrics.all_conversions > 0`;
  const r = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Google Ads ${r.status}`);
  return (j.results || []).map((row) => ({
    gclid: row.clickView?.gclid || null,
    campaign: row.campaign?.name || null,
    date: row.segments?.date || null,
    hour: row.segments?.hour ?? null,
    action: row.segments?.conversionActionName || null,
    conversions: Number(row.metrics?.allConversions || 0),
    value: Number(row.metrics?.allConversionsValue || 0),
  })).filter((row) => row.gclid && row.conversions > 0);
}

async function recentStripeSessions(days = 7) {
  const out = [];
  let startingAfter = null;
  const gte = Math.floor(Date.now() / 1000) - days * 86400;
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({ limit: '100', 'created[gte]': String(gte) });
    if (startingAfter) params.set('starting_after', startingAfter);
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `Stripe ${r.status}`);
    const data = Array.isArray(j.data) ? j.data : [];
    out.push(...data);
    if (!j.has_more || !data.length) break;
    startingAfter = data[data.length - 1].id;
  }
  return out;
}

async function auditGoogleCartToStripe() {
  const clicks = await googleAddToCartClicks();
  const sessions = await recentStripeSessions(7);
  return clicks.map((click) => {
    const matches = sessions.filter((s) => String(s.metadata?.gclid || '') === click.gclid);
    return {
      campaign: click.campaign,
      conversion_date: click.date,
      conversion_hour: click.hour,
      google_add_to_cart: click.conversions,
      stripe_session_found: matches.length > 0,
      stripe_sessions: matches.map((s) => ({
        created: s.created || null,
        status: s.status || null,
        payment_status: s.payment_status || null,
        paid: s.payment_status === 'paid',
        amount_total: s.amount_total ?? null,
        currency: s.currency ? String(s.currency).toUpperCase() : null,
        landing_page: s.metadata?.landing_page || null,
      })),
      converted_to_paid_stripe: matches.some((s) => s.payment_status === 'paid'),
    };
  });
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

  if (String(req.query?.audit || '') === 'google-cart') {
    try {
      result.google_cart_audit = await auditGoogleCartToStripe();
    } catch (error) {
      result.google_cart_audit = { error: String(error?.message || error) };
    }
  }

  return res.status(200).json(result);
}

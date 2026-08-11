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

async function ga4PurchaseAudit() {
  const token = await googleAccessToken();
  const propertyId = String(process.env.GA4_PROPERTY_ID || '526354130').replace(/\D/g, '');
  const body = {
    dateRanges: [{ startDate: '2026-08-10', endDate: '2026-08-10' }],
    dimensions: [
      { name: 'eventName' },
      { name: 'transactionId' },
      { name: 'sessionSourceMedium' },
      { name: 'sessionCampaignName' },
      { name: 'landingPagePlusQueryString' },
      { name: 'pageReferrer' },
    ],
    metrics: [{ name: 'eventCount' }, { name: 'purchaseRevenue' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'purchase' } },
    },
    limit: '100',
  };
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `GA4 ${r.status}`);
  const dims = (j.dimensionHeaders || []).map((h) => h.name);
  const mets = (j.metricHeaders || []).map((h) => h.name);
  return (j.rows || []).map((row) => {
    const out = {};
    (row.dimensionValues || []).forEach((v, i) => { out[dims[i]] = v.value; });
    (row.metricValues || []).forEach((v, i) => { out[mets[i]] = v.value; });
    return out;
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

  if (String(req.query?.audit || '') === 'ga4-purchases') {
    try { result.ga4_purchase_audit = await ga4PurchaseAudit(); }
    catch (e) { result.ga4_purchase_audit = { error: String(e?.message || e) }; }
  }

  return res.status(200).json(result);
}

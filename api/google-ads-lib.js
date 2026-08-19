// api/google-ads-lib.js
//
// Google Ads offline conversion upload for the Pure Majesty Pets Stripe bridge.
//
// Why this exists: the purchase completes on Stripe's domain, so the browser can
// no longer fire a Google Ads conversion — the gclid cookie is first-party to
// puremajestypet.com. create-checkout.js already persists gclid / gbraid /
// wbraid on the Stripe Session metadata, which is durable. ads-backfill.js reads
// them back and calls this module. GA4 is not in the path, so nothing depends on
// session stitching.
//
// Dependency-free (fetch only), matching the rest of the project.

const ADS_API_VERSION = "v24";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Access tokens live 1h. Module-scope cache: warm invocations reuse it, cold
// ones refresh. Never persisted — a leaked token is worse than an extra refresh.
let _tokenCache = { value: null, expiresAt: 0 };

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache.value && now < _tokenCache.expiresAt) return _tokenCache.value;

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ads_token_refresh_failed status=${res.status} ${detail.slice(0, 300)}`);
  }

  const json = await res.json();
  // 60s margin so we never present a token that expires mid-flight.
  _tokenCache = {
    value: json.access_token,
    expiresAt: now + (Number(json.expires_in || 3600) - 60) * 1000,
  };
  return _tokenCache.value;
}

// Google Ads wants "YYYY-MM-DD HH:MM:SS+HH:MM", not ISO 8601. It rejects the
// trailing "Z" that toISOString produces — the usual first failure here.
function adsDateTime(input) {
  const d = input instanceof Date ? input : new Date(input || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`
  );
}

async function sha256Hex(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * True when the environment is complete enough to upload.
 * tracking-health.js can call this so the health endpoint reports reality.
 */
export function adsConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN &&
      process.env.GOOGLE_ADS_DEVELOPER_TOKEN &&
      process.env.GOOGLE_ADS_CUSTOMER_ID &&
      process.env.GOOGLE_ADS_CONVERSION_ACTION_ID
  );
}

/**
 * Uploads one purchase to Google Ads.
 *
 * @param {object} opts
 * @param {string} [opts.gclid]   from session.metadata.gclid
 * @param {string} [opts.gbraid]  iOS app-to-web
 * @param {string} [opts.wbraid]  iOS web-to-web
 * @param {number} opts.value     order total in major units
 * @param {string} opts.currency  e.g. "usd"
 * @param {string} opts.orderId   Stripe session id — the dedup key
 * @param {string|Date} [opts.occurredAt]
 * @param {string} [opts.email]   raw; hashed here, never sent in clear
 *
 * @returns {Promise<{ok: boolean, skipped?: string, partialFailure?: string}>}
 */
export async function uploadPurchase(opts) {
  if (!adsConfigured()) return { ok: false, skipped: "not_configured" };

  const { gclid, gbraid, wbraid } = opts;
  // No click identifier means the order cannot be attributed to a click.
  // Uploading anyway would be rejected, so skip quietly.
  if (!gclid && !gbraid && !wbraid) return { ok: false, skipped: "no_click_id" };

  const customerId = String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, "");
  const loginCustomerId = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");

  const conversion = {
    conversionAction: `customers/${customerId}/conversionActions/${process.env.GOOGLE_ADS_CONVERSION_ACTION_ID}`,
    conversionDateTime: adsDateTime(opts.occurredAt),
    conversionValue: Number(opts.value) || 0,
    currencyCode: String(opts.currency || "USD").toUpperCase(),
    // orderId makes the upload idempotent on Google's side: re-sending the same
    // Stripe session id updates rather than duplicates.
    orderId: String(opts.orderId),
  };

  // Exactly one click identifier, in Google's order of precedence.
  if (gclid) conversion.gclid = gclid;
  else if (wbraid) conversion.wbraid = wbraid;
  else if (gbraid) conversion.gbraid = gbraid;

  // Enhanced conversions: improves match rate when the click id alone is weak.
  const hashedEmail = await sha256Hex(opts.email);
  if (hashedEmail) conversion.userIdentifiers = [{ hashedEmail }];

  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;

  const res = await fetchWithTimeout(
    `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}:uploadClickConversions`,
    {
      method: "POST",
      headers,
      // partialFailure keeps one malformed row from taking down the batch.
      body: JSON.stringify({ conversions: [conversion], partialFailure: true }),
    },
    10000
  );

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    // Thrown, not swallowed: the caller releases its claim and retries next run.
    throw new Error(`ads_upload_failed status=${res.status} ${text.slice(0, 500)}`);
  }

  let json = {};
  try {
    json = JSON.parse(text);
  } catch (_) {}

  // A 200 with partialFailureError means Google accepted the request but
  // rejected this conversion. Retrying will not help — surface it.
  if (json.partialFailureError) {
    return {
      ok: false,
      partialFailure: JSON.stringify(json.partialFailureError).slice(0, 500),
    };
  }

  return { ok: true };
}

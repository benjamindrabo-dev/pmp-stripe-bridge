// api/google-ads-datamanager.js
// Conversions d'achat vers Google Ads via la Data Manager API.
// Remplace UploadClickConversions, ferme aux nouveaux depuis le 15 juin 2026.
// Pas de developer-token, pas de login-customer-id : le compte est designe
// dans le corps JSON. Montant en unites majeures, pas en micros.

const DM_ENDPOINT = "https://datamanager.googleapis.com/v1/events:ingest";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DM_SCOPE = "https://www.googleapis.com/auth/datamanager";

let _tok = { v: null, exp: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_tok.v && now < _tok.exp) return _tok.v;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const text = await res.text().catch(function () { return ""; });
  if (!res.ok) throw new Error("dm_token_failed status=" + res.status + " " + text.slice(0, 300));
  const json = JSON.parse(text);
  // Sans le scope datamanager, l'ingestion renvoie un 403 opaque.
  if (json.scope && json.scope.indexOf(DM_SCOPE) === -1) {
    throw new Error("dm_scope_missing scopes=" + json.scope);
  }
  _tok = { v: json.access_token, exp: now + (Number(json.expires_in || 3600) - 60) * 1000 };
  return _tok.v;
}

export function adsConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN &&
    process.env.GOOGLE_ADS_CUSTOMER_ID &&
    process.env.GOOGLE_ADS_CONVERSION_ACTION_ID
  );
}

export async function uploadPurchase(opts) {
  if (!adsConfigured()) return { ok: false, skipped: "not_configured" };
  const gclid = opts.gclid || null;
  const gbraid = opts.gbraid || null;
  const wbraid = opts.wbraid || null;
  if (!gclid && !gbraid && !wbraid) return { ok: false, skipped: "no_click_id" };

  const cid = String(process.env.GOOGLE_ADS_CUSTOMER_ID).replace(/-/g, "");
  const ids = {};
  if (gclid) ids.gclid = gclid;
  else if (wbraid) ids.wbraid = wbraid;
  else ids.gbraid = gbraid;

  const when = opts.occurredAt instanceof Date ? opts.occurredAt : new Date(opts.occurredAt || Date.now());
  const ev = {
    destinationReferences: ["pmp_purchase"],
    adIdentifiers: ids,
    transactionId: String(opts.orderId),
    eventTimestamp: when.toISOString(),
    eventSource: "WEB",
    conversionValue: Number(opts.value) || 0,
    currency: String(opts.currency || "USD").toUpperCase()
  };
  // This destination is an "Import from clicks" conversion. The click ID is
  // the matching key. Adding hashed email userData makes Data Manager treat
  // BRAID rows as Enhanced Conversions for Leads and reject them when ECFL is
  // not enabled on the account. Keep this pipeline click-ID-only.

  const payload = {
    destinations: [{
      reference: "pmp_purchase",
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: cid },
      productDestinationId: String(process.env.GOOGLE_ADS_CONVERSION_ACTION_ID)
    }],
    encoding: "HEX",
    events: [ev],
    validateOnly: Boolean(opts.validateOnly)
  };

  const token = await getAccessToken();
  const res = await fetch(DM_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text().catch(function () { return ""; });
  // Keep the complete Google BadRequest details. The useful field violation is
  // often after ErrorInfo/RequestInfo and was previously cut off at 600 chars,
  // making INVALID_ARGUMENT failures impossible to diagnose from Vercel logs.
  if (!res.ok) throw new Error("dm_ingest_failed status=" + res.status + " " + text.slice(0, 4000));

  let json = {};
  try { json = JSON.parse(text); } catch (e) {}
  const warn = json.fieldWarnings && json.fieldWarnings.length ? JSON.stringify(json.fieldWarnings).slice(0, 400) : null;
  const partialFailure = json.partialFailureError
    ? JSON.stringify(json.partialFailureError).slice(0, 4000)
    : null;
  if (partialFailure) {
    return {
      ok: false,
      requestId: json.requestId || null,
      partialFailure,
      warnings: warn
    };
  }
  return { ok: true, requestId: json.requestId || null, warnings: warn };
}

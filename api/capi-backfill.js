// GET /api/capi-backfill?key=<BACKFILL_KEY>&from=2026-07-21T22:00:00Z&to=2026-07-28T22:00:00Z[&dry=1]
//
// One-off catch-up: sends Meta Conversions API "Purchase" events for Shopify
// orders that were created by the Stripe bridge BEFORE client-side tracking was
// installed, so those sales are not missing from your ad reporting.
//
// IMPORTANT
//  - Meta only accepts events whose event_time is at most 7 DAYS old. Older
//    orders are skipped (Meta rejects the whole batch otherwise).
//  - Only run it over a window that happened BEFORE the pixel went live,
//    otherwise you double-count (the pixel already sent those).
//  - event_id = "shopify_<orderId>" so re-running the SAME window does not
//    create duplicates (Meta de-dupes on event_id).
//  - Disabled unless BACKFILL_KEY is set in Vercel. Use dry=1 to preview.

import crypto from "crypto";

const SHOPIFY_API = "2025-01";
const sha256 = (v) => crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

async function fetchOrders(from, to) {
  // REST: orders tagged by the bridge, paid, within the window.
  const url =
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API}/orders.json` +
    `?status=any&financial_status=paid&limit=250` +
    `&created_at_min=${encodeURIComponent(from)}&created_at_max=${encodeURIComponent(to)}`;
  const r = await fetch(url, { headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN } });
  const j = await r.json();
  if (!r.ok) throw new Error("Shopify orders fetch failed: " + JSON.stringify(j));
  // Only orders this bridge created.
  return (j.orders || []).filter((o) => String(o.tags || "").toLowerCase().includes("stripe"));
}

function toEvent(o) {
  const a = o.shipping_address || o.billing_address || {};
  const user_data = {};
  if (o.email) user_data.em = [sha256(o.email)];
  if (o.phone || a.phone) user_data.ph = [sha256(String(o.phone || a.phone).replace(/[^0-9]/g, ""))];
  if (a.first_name) user_data.fn = [sha256(a.first_name)];
  if (a.last_name) user_data.ln = [sha256(a.last_name)];
  if (a.city) user_data.ct = [sha256(String(a.city).replace(/\s/g, ""))];
  if (a.province_code || a.province) user_data.st = [sha256(a.province_code || a.province)];
  if (a.zip) user_data.zp = [sha256(String(a.zip).replace(/\s/g, ""))];
  if (a.country_code || a.country) user_data.country = [sha256(a.country_code || a.country)];

  return {
    event_name: "Purchase",
    event_time: Math.floor(new Date(o.created_at).getTime() / 1000),
    event_id: "shopify_" + o.id, // stable → safe to re-run the same window
    action_source: "website",
    event_source_url: process.env.SUCCESS_URL || undefined,
    user_data,
    custom_data: {
      value: Number(o.total_price),
      currency: String(o.currency || "USD").toUpperCase(),
      order_id: String(o.order_number || o.id),
    },
  };
}

export default async function handler(req, res) {
  const q = req.query || {};
  if (!process.env.BACKFILL_KEY || q.key !== process.env.BACKFILL_KEY) {
    return res.status(403).json({ error: "Forbidden (set BACKFILL_KEY and pass ?key=)" });
  }
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return res.status(400).json({ error: "META_PIXEL_ID / META_CAPI_TOKEN not set" });

  const to = q.to || new Date().toISOString();
  const from = q.from || new Date(Date.now() - 6.5 * 864e5).toISOString();

  try {
    const orders = await fetchOrders(from, to);

    // Meta hard-rejects a batch containing any event older than 7 days.
    const cutoff = Math.floor((Date.now() - 6.9 * 864e5) / 1000);
    const all = orders.map(toEvent);
    const events = all.filter((e) => e.event_time >= cutoff);
    const skippedTooOld = all.length - events.length;

    if (q.dry) {
      return res.status(200).json({
        dryRun: true, window: { from, to },
        ordersFound: orders.length, wouldSend: events.length, skippedTooOld,
        totalValue: events.reduce((s, e) => s + (e.custom_data.value || 0), 0),
        sample: events.slice(0, 3).map((e) => ({ event_id: e.event_id, value: e.custom_data.value, currency: e.custom_data.currency })),
      });
    }
    if (!events.length) return res.status(200).json({ sent: 0, ordersFound: orders.length, skippedTooOld });

    // Meta accepts up to 1000 events per request; batch by 500 to be safe.
    const results = [];
    for (let i = 0; i < events.length; i += 500) {
      const batch = events.slice(i, i + 500);
      const r = await fetch(
        `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: batch }) }
      );
      results.push({ status: r.status, body: await r.json() });
    }
    return res.status(200).json({ sent: events.length, skippedTooOld, window: { from, to }, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

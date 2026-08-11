// POST /api/stripe-webhook
// On checkout.session.completed (paid) we create the matching Shopify order,
// in the same currency the customer paid, with shipping + billing addresses.
export const config = { api: { bodyParser: false } };

import crypto from "crypto";

const SHOPIFY_API = "2026-01"; // keep on a SUPPORTED version (2025-01 expired; expired versions silently fall forward)

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Stripe signature: header "t=<ts>,v1=<hex hmac of `${t}.${rawBody}`>"
function verifyStripe(raw, header) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) return false;
  } catch {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // replay protection
  return true;
}

async function redisCommand(command) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || typeof j !== "object" || "error" in j) {
    throw new Error("Upstash command failed: " + r.status + " " + JSON.stringify(j || {}).slice(0, 200));
  }
  return j.result;
}

async function kvGet(key) {
  const result = await redisCommand(["GET", key]);
  return result ? JSON.parse(result) : null;
}
async function kvSet(key, value, ttlSeconds) {
  const result = await redisCommand(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]);
  if (result !== "OK") throw new Error("Upstash SET was not acknowledged");
}
async function kvDel(key) { await redisCommand(["DEL", key]); }
// List helpers for the GA4 outbox queue: enumerating pending entries with a
// LIST is O(1) per read, unlike SCAN which walks the whole keyspace.
async function kvRPush(key, member) { return redisCommand(["RPUSH", key, String(member)]); }
async function kvLPop(key) { return redisCommand(["LPOP", key]); }

// A short processing lease is not a completion marker. Concurrent deliveries
// receive 500 so Stripe retries; only done:<session> is acknowledged as complete.
async function kvClaim(key, token) {
  try {
    const result = await redisCommand(["SET", key, token, "NX", "EX", "300"]);
    return result === "OK" ? "ok" : "busy";
  } catch (e) {
    console.error("kvClaim network error:", String(e && e.message || e));
    return "error";
  }
}
async function kvRelease(key, token) {
  const script = "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
  return redisCommand(["EVAL", script, "1", key, token]);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// ---- Meta Conversions API (server-side purchase tracking) ----
// Deduplicated with the browser pixel: both send event_id = Stripe session id.
// Requires env vars META_PIXEL_ID and META_CAPI_TOKEN (token is a SECRET —
// set it in Vercel → Environment Variables, never in the code/repo).
const sha256 = (v) =>
  crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex");

async function sendMetaPurchase({ sessionId, email, phone, value, currency, cart, address, name, orderId, orderNumber }) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) { console.error("Meta CAPI SKIPPED: META_PIXEL_ID / META_CAPI_TOKEN not set in Vercel"); return; }

  const user_data = {};
  // external_id = a stable, hashed customer identifier. Meta weighs it heavily
  // in Event Match Quality, so we derive it from the email.
  // Send BOTH identifiers: the browser's stable id (identical to the pixel's
  // Advanced Matching value) and the hashed email. More keys = better matching.
  const extIds = [];
  // Browser Pixel hashes Advanced Matching values automatically. CAPI requires
  // the server copy to be SHA-256 hashed explicitly so both channels match.
  if (cart && cart.external_id) extIds.push(sha256(cart.external_id));
  if (email) extIds.push(sha256(email));
  if (extIds.length) user_data.external_id = extIds;
  if (email) user_data.em = [sha256(email)];
  if (phone) user_data.ph = [sha256(String(phone).replace(/[^0-9]/g, ""))];
  if (name) {
    const parts = String(name).trim().split(/\s+/);
    if (parts[0]) user_data.fn = [sha256(parts[0])];
    if (parts.length > 1) user_data.ln = [sha256(parts[parts.length - 1])];
  }
  if (address) {
    if (address.city) user_data.ct = [sha256(String(address.city).replace(/\s/g, ""))];
    if (address.state) user_data.st = [sha256(address.state)];
    if (address.postal_code) user_data.zp = [sha256(String(address.postal_code).replace(/\s/g, ""))];
    if (address.country) user_data.country = [sha256(address.country)];
  }
  if (cart && cart.fbp) user_data.fbp = cart.fbp;
  if (cart && cart.fbc) user_data.fbc = cart.fbc;
  if (cart && cart.ip) user_data.client_ip_address = cart.ip;
  if (cart && cart.ua) user_data.client_user_agent = cart.ua;

  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: sessionId,                  // dedupe key shared with the pixel
        action_source: "website",
        event_source_url: (cart && cart.landing_url) || process.env.SUCCESS_URL || undefined,
        user_data,
        // Richer custom_data = better reporting, catalog matching and retargeting.
        custom_data: {
          value: Number(value),
          currency: String(currency).toUpperCase(),
          content_type: "product",
          num_items: (cart && cart.items) ? cart.items.reduce((n, it) => n + (Number(it.quantity) || 1), 0) : undefined,
          content_ids: (cart && cart.items) ? cart.items.map((it) => String(it.variant_id)) : undefined,
          contents: (cart && cart.items) ? cart.items.map((it) => ({
            id: String(it.variant_id),
            quantity: Number(it.quantity) || 1,
            item_price: (Number(it.price_cents) || 0) / 100,
          })) : undefined,
          // order_id lets Meta recognise the same purchase coming from another
          // source (e.g. Shopify's own integration) and avoid double counting.
          order_id: orderNumber ? String(orderNumber) : (orderId ? String(orderId) : undefined),
        },
      },
    ],
  };

  const r = await fetch(
    `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await r.json().catch(() => null);
  // Explicitly assert Meta acknowledged the event, not just HTTP 200.
  if (!r.ok || !j || j.events_received !== 1) {
    console.error("Meta CAPI FAILED for", sessionId, "status:", r.status, "body:", JSON.stringify(j || {}).slice(0, 300));
  } else {
    console.log("Meta CAPI ok:", sessionId, JSON.stringify(j));
  }
}

// ---- GA4 Measurement Protocol (server-side purchase tracking) ----
// The webhook is the SINGLE source for the GA4 `purchase` event: the browser
// tag is removed, so a paid order converts even if the shopper never loads the
// thank-you page. Requires env vars GA4_MEASUREMENT_ID and GA4_API_SECRET
// (the API secret is a SECRET — set it in Vercel → Environment Variables,
// never in the code/repo). Note: the Measurement Protocol answers HTTP 204
// even for an invalid payload, so we log exactly what we send and expose a
// separate ENFORCE_RECOMMENDATIONS validator in /api/ga4-retry?validate=1.
const GA4_OUTBOX_TTL = 345600;              // 4 days > GA4's 72h backdating window
const GA4_QUEUE_KEY = "ga4:queue";          // Redis LIST of session ids (no SCAN)
const GA4_MAX_AGE_MS = 72 * 3600 * 1000;    // GA4 drops events backdated > 72h

// Payment instant in MICROseconds. Retries must reuse this value, so it is
// stored in the outbox entry: a retry two hours later must not be dated two
// hours later.
function ga4TimestampMicros(session) {
  const st = session && session.status_transitions;
  const seconds =
    Number(st && (st.paid_at || st.completed_at)) ||
    Number(session && session.created) ||
    0;
  return seconds > 0 ? seconds * 1e6 : Date.now() * 1000;
}

// GA4 ecommerce requires `items`, and each item requires item_id or item_name.
// item_id is the socle (always present). item_name is matched BY variant_id
// against the Shopify order lines; when the match fails — or when createdOrder
// is unavailable (ambiguous recovery path) — item_name is OMITTED rather than
// invented. Free BXGY lines are kept as-is with price 0: that is the correct
// ecommerce representation, they are neither merged nor dropped.
function buildGa4Items(cart, createdOrder) {
  const lines = (createdOrder && Array.isArray(createdOrder.line_items)) ? createdOrder.line_items : [];
  const titleByVariant = new Map();
  for (const li of lines) {
    if (!li || li.variant_id == null) continue;
    const title = li.title || li.name;
    const vid = String(li.variant_id);
    if (title && !titleByVariant.has(vid)) titleByVariant.set(vid, String(title));
  }
  return ((cart && cart.items) || []).map((it) => {
    const id = String(it.variant_id);
    const item = { item_id: id };
    const name = titleByVariant.get(id);
    if (name) item.item_name = name;
    item.price = (Number(it.price_cents) || 0) / 100;
    item.quantity = Number(it.quantity) || 1;
    return item;
  });
}

// Builds the exact body posted to the Measurement Protocol. Returns null when
// there is no real client_id: a fabricated id would create a parasitic
// direct/(none) user and corrupt attribution — zero events beats one badly
// attributed event.
function buildGa4Payload({ sessionId, itemsValueCents, currency, gaClientId, gaSessionId, gaSessionNumber, items, timestampMicros }) {
  if (!gaClientId) return null;
  const params = {
    // transaction_id must be the Stripe session id (cs_...): same key the
    // browser tag used and the same value as the Meta CAPI event_id.
    transaction_id: sessionId,
    // GA4 defines purchase.value as SUM(price x quantity) of the items,
    // EXCLUDING shipping and tax. session.amount_total (the charged amount) is
    // therefore not used here; it is only logged for traceability.
    value: Math.round(Number(itemsValueCents) || 0) / 100,
    currency: String(currency).toUpperCase(),
    // KEPT FOR NOW, pending arbitration: whether engagement_time_msec belongs on
    // a server-side purchase must be decided by the validationMessages returned
    // by /api/ga4-retry?validate=1 (validationBehavior ENFORCE_RECOMMENDATIONS),
    // not by opinion. Do not remove it before that verdict.
    engagement_time_msec: 1,
    items: Array.isArray(items) ? items : [],
  };
  // Only include session fields when they exist: GA4 treats an explicit null
  // as a value.
  if (gaSessionId) params.session_id = String(gaSessionId);
  if (gaSessionNumber) params.session_number = String(gaSessionNumber);

  return {
    client_id: String(gaClientId),
    // Real payment instant, so Stripe/outbox retries do not shift the event.
    timestamp_micros: Math.round(Number(timestampMicros) || Date.now() * 1000),
    // No `non_personalized_ads` (deprecated) and deliberately NO `consent`
    // block: with no consent block GA4 reuses the consent state of the online
    // interactions carrying the same client_id, which reflects the visitor's
    // actual choice better than anything we could assert server-side.
    events: [{ name: "purchase", params }],
  };
}

// Single POST to the Measurement Protocol. `validate` targets the debug
// endpoint, which returns validationMessages instead of silently accepting.
async function ga4Post(payload, { validate = false } = {}) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) throw new Error("GA4_MEASUREMENT_ID / GA4_API_SECRET not set");
  const base = validate
    ? "https://www.google-analytics.com/debug/mp/collect"
    : "https://www.google-analytics.com/mp/collect";
  const body = validate ? { ...payload, validationBehavior: "ENFORCE_RECOMMENDATIONS" } : payload;
  const r = await fetchWithTimeout(
    `${base}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    5000
  );
  let json = null;
  if (validate) json = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json };
}

// ---- GA4 outbox --------------------------------------------------------
// sendGa4Purchase is called AFTER done:<session> is written, so a GA4 failure
// can never be retried by Stripe. The outbox owns tracking idempotence:
// ga4:<session> holds the ready-to-post payload, ga4:queue lists the pending
// ids (a LIST, never SCAN). Nothing here may affect the order.
async function ga4Enqueue(sessionId, payload) {
  const entry = {
    session_id: String(sessionId),
    payload,
    status: "pending",
    attempts: 0,
    first_seen_at: Date.now(),
  };
  await kvSet(`ga4:${sessionId}`, entry, GA4_OUTBOX_TTL);
  await kvRPush(GA4_QUEUE_KEY, String(sessionId));
  return entry;
}

// One delivery attempt for an outbox entry; always persists the new state.
// Past the 72h backdating limit the entry is marked `expired` instead of being
// retried forever.
async function ga4TrySend(entry) {
  const key = `ga4:${entry.session_id}`;
  const micros = Number(entry.payload && entry.payload.timestamp_micros) || 0;
  if (micros > 0 && Date.now() - micros / 1000 > GA4_MAX_AGE_MS) {
    entry.status = "expired";
    entry.last_error = "older than GA4's 72h backdating limit — abandoned";
    await kvSet(key, entry, GA4_OUTBOX_TTL);
    return entry;
  }
  try {
    const r = await ga4Post(entry.payload);
    if (!r.ok) throw new Error("Measurement Protocol HTTP " + r.status);
    entry.status = "sent";
    entry.sent_at = Date.now();
    delete entry.last_error;
    console.log("GA4 MP sent:", entry.session_id, "status:", r.status, "payload:", JSON.stringify(entry.payload).slice(0, 500));
  } catch (e) {
    entry.status = "pending";
    entry.attempts = (Number(entry.attempts) || 0) + 1;
    entry.last_error = String((e && e.message) || e).slice(0, 200);
    console.error("GA4 MP attempt failed for", entry.session_id, entry.last_error);
  }
  await kvSet(key, entry, GA4_OUTBOX_TTL);
  return entry;
}

// Opportunistic drain: pop a few ids, retry them, requeue the ones still
// failing. Capped in count AND in wall-clock time (no maxDuration on this
// function). Callers must keep it inside a try/catch.
async function ga4Drain({ max = 3, budgetMs = 4000 } = {}) {
  const startedAt = Date.now();
  const summary = { popped: 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
  for (let i = 0; i < max; i++) {
    if (Date.now() - startedAt > budgetMs) break;
    const id = await kvLPop(GA4_QUEUE_KEY);
    if (!id) break;
    summary.popped += 1;
    const entry = await kvGet(`ga4:${id}`);
    if (!entry || entry.status === "sent" || entry.status === "expired") { summary.skipped += 1; continue; }
    const out = await ga4TrySend(entry);
    if (out.status === "sent") summary.sent += 1;
    else if (out.status === "expired") summary.expired += 1;
    else { summary.failed += 1; await kvRPush(GA4_QUEUE_KEY, String(id)); }
  }
  return summary;
}

// Persist the intention FIRST, then try once. Never throws.
async function sendGa4Purchase(opts) {
  const payload = buildGa4Payload(opts);
  if (!payload) {
    console.error("GA4 MP SKIPPED for", opts && opts.sessionId, ": no ga_client_id (cart + session.metadata both empty)");
    return null;
  }
  console.log(
    "GA4 purchase queued:", opts.sessionId,
    "value:", payload.events[0].params.value,
    "charged:", opts.chargedCents == null ? "n/a" : (Number(opts.chargedCents) || 0) / 100
  );
  const entry = await ga4Enqueue(opts.sessionId, payload);
  return ga4TrySend(entry);
}

function cleanAddress(a) {
  if (!a || !a.address1) return undefined;
  return {
    // Shopify prefers first_name/last_name; name alone can be ignored.
    first_name: a.first_name || undefined,
    last_name: a.last_name || undefined,
    name: a.name || undefined,
    address1: a.address1,
    address2: a.address2 || undefined,
    city: a.city || undefined,
    province: a.province || undefined,
    country: a.country || undefined,
    zip: a.zip || undefined,
    phone: a.phone || undefined,
  };
}

// Read the promo code the shopper typed inside Stripe Checkout. The webhook
// payload only carries discount IDs, so we re-fetch the session with the
// promotion code expanded. Never throws — a missing code must not cost an order.
async function fetchDiscount(sessionId) {
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=discounts.promotion_code`,
      { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
    );
    const s = await r.json();
    if (!r.ok) return null;
    const cents = Number(s.total_details && s.total_details.amount_discount) || 0;
    if (cents <= 0) return null;
    const d = (s.discounts || [])[0];
    const pc = d && d.promotion_code;
    const code = (pc && (pc.code || pc.id)) || "STRIPE_PROMO";
    return { code: String(code), cents };
  } catch (e) {
    console.error("promo lookup failed:", String((e && e.message) || e));
    return null;
  }
}

async function findShopifyOrder(sessionId) {
  const query = `query($q:String!){ orders(first:1, query:$q) { nodes { id legacyResourceId name tags totalPriceSet { shopMoney { amount currencyCode } } } } }`;
  const r = await fetchWithTimeout(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API}/graphql.json`,
    {
      method: "POST",
      headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { q: `source_identifier:${sessionId}` } }),
    }
  );
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors) throw new Error("Shopify reconciliation failed: " + r.status + " " + JSON.stringify(j || {}).slice(0, 300));
  return (j.data && j.data.orders && j.data.orders.nodes && j.data.orders.nodes[0]) || null;
}

async function recoverCartFromStripe(session) {
  const r = await fetchWithTimeout(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(session.id)}/line_items?limit=100&expand[]=data.price.product`,
    { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
  );
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !Array.isArray(j.data)) throw new Error("Stripe line-item recovery failed");
  const items = [];
  for (const line of j.data) {
    const product = line && line.price && line.price.product;
    const variantId = product && typeof product === "object" && product.metadata && product.metadata.shopify_variant_id;
    if (!variantId) continue; // excludes the synthetic Shipping line
    const quantity = Number(line.quantity) || 1;
    const unitAmount = Number(line.price && line.price.unit_amount);
    if (!Number.isInteger(Number(variantId)) || !Number.isFinite(unitAmount)) continue;
    items.push({ variant_id: Number(variantId), quantity, price_cents: unitAmount });
  }
  if (!items.length) throw new Error("No recoverable Shopify items on Stripe Session");
  return { items, currency: String(session.currency || "USD").toLowerCase(), note: "Recovered from Stripe Session metadata" };
}

async function createShopifyOrder({ items, currency, email, phone, shipping, billing, note, sessionId, discount, chargedCents }) {
  const charged = Number(chargedCents);
  if (!Number.isInteger(charged) || charged < 0) throw new Error("Invalid signed Stripe amount");
  const order = {
    line_items: items.map((it) => {
      const li = { variant_id: Number(it.variant_id), quantity: Number(it.quantity) };
      // Use the presentment price the customer actually paid, so the order
      // total matches the Stripe charge (esp. for non-shop currencies).
      if (it.price_cents != null) li.price = (Number(it.price_cents) / 100).toFixed(2);
      return li;
    }),
    financial_status: "paid",
    // Shopify's documented paid-order shape includes a successful sale
    // transaction. The amount comes from the signed Stripe webhook, not cart JS.
    transactions: [{
      kind: "sale",
      status: "success",
      amount: (charged / 100).toFixed(2),
      gateway: "Stripe",
    }],
    email: email || undefined,
    phone: phone || undefined,
    note: `Paid via Stripe (${(currency || "").toUpperCase()}). Stripe session: ${sessionId || "n/a"}. ${note || ""}`.trim(),
    // Machine-readable link back to the Stripe payment (refunds, dedup, audits).
    note_attributes: sessionId ? [{ name: "stripe_session_id", value: String(sessionId) }] : undefined,
    source_identifier: String(sessionId),
    // Shopify tags are limited to 40 characters; keep the full Session ID in
    // source_identifier/note_attributes and use a deterministic short tag.
    tags: `stripe, stripe_${crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32)}`,
    send_receipt: true,
    send_fulfillment_receipt: false,
    inventory_behaviour: "decrement_obeying_policy",
  };
  if (currency) order.currency = String(currency).toUpperCase();
  // Promo code applied inside Stripe Checkout. Recorded as an order-level
  // discount so the Shopify total equals what Stripe actually charged, and so
  // the code shows up in Shopify's reports (which code drove which sale).
  if (discount && discount.cents > 0) {
    order.discount_codes = [{
      code: discount.code,
      amount: (discount.cents / 100).toFixed(2),
      type: "fixed_amount",
    }];
  }
  const itemCents = items.reduce((sum, it) => sum + (Number(it.price_cents) || 0) * (Number(it.quantity) || 1), 0);
  const shippingCents = charged - itemCents + ((discount && discount.cents) || 0);
  if (shippingCents > 0) {
    order.shipping_lines = [{ title: "Shipping", price: (shippingCents / 100).toFixed(2), code: "STRIPE_SHIPPING" }];
  }
  const ship = cleanAddress(shipping);
  const bill = cleanAddress(billing);
  if (ship) order.shipping_address = ship;
  if (bill) order.billing_address = bill;

  let r;
  try {
    r = await fetchWithTimeout(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API}/orders.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ order }),
      }
    );
  } catch (cause) {
    const e = new Error("Shopify order create network/timeout failure");
    e.ambiguous = true; e.cause = cause; throw e;
  }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.order) {
    const e = new Error("Shopify order create failed: " + r.status + " " + JSON.stringify(j || {}).slice(0, 500));
    e.ambiguous = r.status >= 500 || !j;
    throw e;
  }
  return j.order;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const raw = await readRaw(req);
  if (!verifyStripe(raw, req.headers["stripe-signature"])) {
    return res.status(401).json({ error: "Bad signature" });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).end(); }

  try {
    // async_payment_succeeded covers delayed methods (bank debits etc.) that
    // confirm after the session completes.
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        const key = `sess:${session.id}`;
        const claimKey = `processing:${session.id}`;
        const doneKey = `done:${session.id}`;
        const claimToken = crypto.randomUUID();

        // A durable done marker is the only reason to ACK a duplicate delivery.
        // A processing lease is temporary; concurrent deliveries receive 500.
        let done;
        try { done = await kvGet(doneKey); }
        catch (e) { console.error("done lookup failed", e); return res.status(500).json({ error: "state unavailable, retry" }); }
        if (done) return res.status(200).json({ received: true, duplicate: true, order: done.order_id || null });

        const claim = await kvClaim(claimKey, claimToken);
        if (claim === "error") return res.status(500).json({ error: "lock unavailable, retry" });
        if (claim === "busy") return res.status(500).json({ error: "already processing, retry" });

        // Reconcile before every POST. This prevents a duplicate Shopify order
        // if Shopify created the prior order but its HTTP response was lost.
        let existingOrder;
        try { existingOrder = await findShopifyOrder(session.id); }
        catch (e) {
          try { await kvRelease(claimKey, claimToken); } catch (releaseError) { console.error("lease release failed", releaseError); }
          console.error("Shopify reconciliation failed", e);
          return res.status(500).json({ error: "reconciliation failed, retry" });
        }
        if (existingOrder) {
          await kvSet(doneKey, { order_id: existingOrder.legacyResourceId || existingOrder.id, reconciled: true }, 7776000);
          await kvRelease(claimKey, claimToken);
          try { await kvDel(key); } catch (e) { console.error("cart cleanup failed for", key, e); }
          return res.status(200).json({ received: true, reconciled: true });
        }

        let cart;
        try { cart = await kvGet(key); }
        catch (e) {
          try { await kvRelease(claimKey, claimToken); } catch (releaseError) { console.error("lease release failed", releaseError); }
          console.error("Upstash read failed", e);
          return res.status(500).json({ error: "cart read failed, retry" });
        }

        if (!cart) {
          try {
            cart = await recoverCartFromStripe(session);
            console.warn("Recovered missing cart from Stripe Session", session.id);
          } catch (e) {
            try { await kvRelease(claimKey, claimToken); } catch (releaseError) { console.error("lease release failed", releaseError); }
            console.error("Cart missing and Stripe recovery failed for", key, e);
            return res.status(500).json({ error: "cart recovery failed, retry" });
          }
        }

        const cd = session.customer_details || {};
        // Newer Stripe API versions move shipping to collected_information.
        const sd = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
        const shipAddr = sd.address || cd.address || {};
        const billAddr = cd.address || sd.address || {};
        const toAddr = (a, name, phone) => {
          const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
          return {
            first_name: parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] || undefined),
            last_name: parts.length > 1 ? parts[parts.length - 1] : undefined,
            name: name || undefined,
            address1: a.line1, address2: a.line2, city: a.city,
            province: a.state, country: a.country, zip: a.postal_code, phone,
          };
        };

        // Promo code entered inside Stripe Checkout (null when there is none).
        const discount = await fetchDiscount(session.id);

        // Integrity tripwire: cart total MINUS the Stripe promo discount, vs the
        // amount Stripe actually charged (signed event). Logged, not blocking.
        const cartTotal = (cart.items || []).reduce((s, it) => s + (Number(it.price_cents) || 0) * (Number(it.quantity) || 1), 0);
        const expected = cartTotal - ((discount && discount.cents) || 0);
        if (session.amount_total != null && Math.abs(expected - session.amount_total) > Math.max(2, session.amount_total * 0.01)) {
          console.error(`AMOUNT MISMATCH for ${session.id}: stripe=${session.amount_total} cart=${cartTotal} discount=${(discount && discount.cents) || 0} ${session.currency}`);
        }

        let createdOrder;
        try {
          createdOrder = await createShopifyOrder({
            items: cart.items,
            currency: cart.currency,
            email: cd.email,
            phone: cd.phone,
            shipping: toAddr(shipAddr, sd.name || cd.name, cd.phone),
            billing: toAddr(billAddr, cd.name || sd.name, cd.phone),
            note: cart.note,
            sessionId: session.id,
            discount,
            chargedCents: session.amount_total,
          });
          // Money check: if Shopify ever ignores order.discount_codes, the order
          // total would silently exceed the amount charged. Surface it loudly in
          // the logs rather than let the books drift.
          if (discount && createdOrder && session.amount_total != null) {
            const orderCents = Math.round(Number(createdOrder.total_price) * 100);
            if (Math.abs(orderCents - session.amount_total) > 2) {
              console.error(`DISCOUNT NOT APPLIED on order ${createdOrder.id}: shopify=${orderCents} stripe=${session.amount_total} code=${discount.code}`);
            }
          }
        } catch (e) {
          if (e && e.ambiguous) {
            // The POST may have succeeded. Poll reconciliation before returning;
            // if still unknown, keep the lease until its 5-minute expiry.
            for (const delay of [500, 1200]) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              try {
                const found = await findShopifyOrder(session.id);
                if (found) { createdOrder = { id: found.legacyResourceId || found.id, order_number: found.name }; break; }
              } catch (reconcileError) { console.error("post-create reconciliation failed", reconcileError); }
            }
            if (!createdOrder) {
              console.error("Shopify order result ambiguous — returning 500 with lease retained:", e);
              return res.status(500).json({ error: "order result unknown, retry later" });
            }
          } else {
            try { await kvRelease(claimKey, claimToken); } catch (releaseError) { console.error("lease release failed", releaseError); }
            console.error("Shopify order create rejected — returning 500:", e);
            return res.status(500).json({ error: "order create failed, retry" });
          }
        }

        // Completion is durable before analytics. If this write fails, Stripe
        // retries and Shopify reconciliation prevents a duplicate order.
        await kvSet(doneKey, { order_id: createdOrder && createdOrder.id, completed_at: Date.now() }, 7776000);
        await kvRelease(claimKey, claimToken);

        // Server-side ad tracking (never blocks the order; pixel is the backup).
        try {
          await sendMetaPurchase({
            sessionId: session.id,
            email: cd.email,
            phone: cd.phone,
            value: (Number(session.amount_total) || 0) / 100,
            currency: session.currency || cart.currency,
            cart,
            address: shipAddr,
            name: sd.name || cd.name,
            orderId: createdOrder && createdOrder.id,
            orderNumber: createdOrder && createdOrder.order_number,
          });
        } catch (e) { console.error("Meta CAPI error", e); }

        // Server-side ad tracking (never blocks the order; pixel is the backup).
        // done:<session> is already durable above, so Stripe will never retry a
        // GA4 failure: the ga4:<session> outbox carries that retry instead.
        try {
          await sendGa4Purchase({
            sessionId: session.id,
            // GA4 value = SUM(price x quantity) of items, shipping and tax
            // EXCLUDED. cartTotal is exactly that sum (the same one used to
            // derive shippingCents). session.amount_total stays available and
            // is logged, but is no longer sent as `value`.
            itemsValueCents: cartTotal,
            chargedCents: session.amount_total,
            currency: session.currency || cart.currency,
            // Redis may have expired; Stripe metadata is durable, so fall back on it.
            gaClientId: (cart && cart.ga_client_id) || (session.metadata && session.metadata.ga_client_id) || null,
            gaSessionId: (cart && cart.ga_session_id) || (session.metadata && session.metadata.ga_session_id) || null,
            gaSessionNumber: (cart && cart.ga_session_number) || (session.metadata && session.metadata.ga_session_number) || null,
            // item_name is matched by variant_id against the Shopify order
            // lines, and omitted when the match fails (never invented).
            items: buildGa4Items(cart, createdOrder),
            timestampMicros: ga4TimestampMicros(session),
          });
        } catch (e) { console.error("GA4 MP error", e); }

        // Opportunistic outbox drain: at most 3 entries, hard time budget, and
        // wrapped so it can never fail the webhook or touch the order state.
        try {
          const drained = await ga4Drain({ max: 3, budgetMs: 4000 });
          if (drained.popped) console.log("GA4 outbox drain:", JSON.stringify(drained));
        } catch (e) { console.error("GA4 outbox drain error", e); }

        try { await kvDel(key); } catch (e) { console.error("cart cleanup failed for", key, e); }
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    // Unexpected failure: let Stripe retry rather than acknowledging a loss.
    console.error("Unexpected webhook error:", e);
    return res.status(500).json({ error: "unexpected error, retry" });
  }
}

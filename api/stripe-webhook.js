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

// Build the Conversions API request body — and nothing else. Sending is a
// separate step (metaTrySend), deliberately: the durability of the intention
// must be acquired BEFORE done:<session> is written, while the delivery attempt
// belongs after the lease is released. This is the exact same split as GA4.
// `fallback` supplies fbp / fbc / external_id when the Redis cart is gone (the
// reconciliation path): those three live in session.metadata, which is durable.
// It deliberately does NOT supply client_ip_address / client_user_agent —
// Stripe does not carry them and a fabricated value would poison matching.
function buildMetaPurchaseBody({ sessionId, email, phone, value, currency, cart, address, name, orderId, orderNumber, fallback }) {
  const fb = fallback || {};
  const externalId = (cart && cart.external_id) || fb.external_id || null;
  const fbpValue = (cart && cart.fbp) || fb.fbp || null;
  const fbcValue = (cart && cart.fbc) || fb.fbc || null;

  const user_data = {};
  // external_id = a stable, hashed customer identifier. Meta weighs it heavily
  // in Event Match Quality, so we derive it from the email.
  // Send BOTH identifiers: the browser's stable id (identical to the pixel's
  // Advanced Matching value) and the hashed email. More keys = better matching.
  const extIds = [];
  // Browser Pixel hashes Advanced Matching values automatically. CAPI requires
  // the server copy to be SHA-256 hashed explicitly so both channels match.
  if (externalId) extIds.push(sha256(externalId));
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
  if (fbpValue) user_data.fbp = fbpValue;
  if (fbcValue) user_data.fbc = fbcValue;
  // client_ip_address / client_user_agent exist ONLY in the Redis cart. When
  // the cart is gone they are omitted — never invented.
  if (cart && cart.ip) user_data.client_ip_address = cart.ip;
  if (cart && cart.ua) user_data.client_user_agent = cart.ua;

  return {
    data: [
      {
        event_name: "Purchase",
        // Frozen at build time and stored in the outbox, like GA4's
        // timestamp_micros: a retry two hours later must not be dated two
        // hours later.
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
}

// Transport only. Same URL, same headers, same serialisation as before.
async function metaPost(body) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) throw new Error("META_PIXEL_ID / META_CAPI_TOKEN not set");
  const r = await fetch(
    `https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json: j };
}

// ---- GA4 Measurement Protocol (server-side purchase tracking) ----
// The webhook is the SINGLE source for the GA4 `purchase` event: the browser
// tag is removed, so a paid order converts even if the shopper never loads the
// thank-you page. Requires env vars GA4_MEASUREMENT_ID and GA4_API_SECRET
// (the API secret is a SECRET — set it in Vercel → Environment Variables,
// never in the code/repo). Note: the Measurement Protocol answers HTTP 204
// even for an invalid payload, so we log exactly what we send and expose a
// separate validator (validation_behavior = ENFORCE_RECOMMENDATIONS, sent ONLY
// to /debug/mp/collect) in /api/ga4-retry?validate=1.
const GA4_OUTBOX_TTL = 345600;              // 4 days > GA4's 72h backdating window
const GA4_QUEUE_KEY = "ga4:queue";          // Redis LIST of session ids (no SCAN)
const GA4_MAX_AGE_MS = 72 * 3600 * 1000;    // GA4 drops events backdated > 72h

// Event instant in MICROseconds, taken from the Stripe Event object's
// `created` (Unix seconds) — the moment the payment event was emitted. The
// Checkout Session carries no payment-transition timestamps, and
// session.created is only the moment the checkout was opened, which for
// delayed payment methods can be days before the money actually arrives.
// Retries must reuse this value, so it is stored in the outbox entry: a retry
// two hours later must not be dated two hours later.
// Never throws: falls back on Date.now() when `created` is missing or absurd.
const GA4_MIN_PLAUSIBLE_SECONDS = 1420070400; // 2015-01-01, sanity floor
function ga4TimestampMicros(event) {
  const nowMicros = Date.now() * 1000;
  const seconds = Number(event && event.created);
  if (!Number.isFinite(seconds) || seconds < GA4_MIN_PLAUSIBLE_SECONDS) return nowMicros;
  const micros = Math.round(seconds * 1e6);
  // More than 24h in the future = clock nonsense; prefer our own clock.
  if (micros > nowMicros + 24 * 3600 * 1e6) return nowMicros;
  return micros;
}

// Spreads an order-level Stripe discount (in integer cents) across the PAYING
// lines only, pro rata of each line subtotal (price_cents x quantity).
// Free BXGY lines (price_cents <= 0) get no share and stay at price 0.
//
// Everything is done in integer cents with the largest-remainder method, so the
// allocated shares sum EXACTLY to the discount — no stray cent appears or
// vanishes. A discount greater than or equal to the paying subtotal is clamped
// to that subtotal, so a net price can never go negative.
//
// Returns an array of integer cents, aligned index-by-index with `items`.
// Pure function, never throws: any unusable input yields all-zero shares.
function allocateDiscountCents(items, discountCents) {
  const list = Array.isArray(items) ? items : [];
  const shares = new Array(list.length).fill(0);
  const total = Math.round(Number(discountCents) || 0);
  if (!(total > 0)) return shares;

  const subtotals = list.map((it) => {
    const price = Math.round(Number(it && it.price_cents) || 0);
    const qty = Math.max(1, Math.round(Number(it && it.quantity) || 1));
    return price > 0 ? price * qty : 0;
  });
  const payable = subtotals.reduce((s, v) => s + v, 0);
  if (payable <= 0) return shares;

  // Clamp: never discount more than what is actually payable.
  const toSpread = Math.min(total, payable);

  const remainders = [];
  let assigned = 0;
  for (let i = 0; i < list.length; i++) {
    if (subtotals[i] <= 0) continue;
    const exact = (toSpread * subtotals[i]) / payable;
    const floor = Math.floor(exact);
    shares[i] = floor;
    assigned += floor;
    remainders.push({ i, frac: exact - floor, sub: subtotals[i] });
  }
  // Largest remainder; ties broken by the larger subtotal, then the lower index.
  remainders.sort((a, b) => (b.frac - a.frac) || (b.sub - a.sub) || (a.i - b.i));
  let left = toSpread - assigned;
  for (let k = 0; k < remainders.length && left > 0; k++) {
    shares[remainders[k].i] += 1;
    left -= 1;
  }
  return shares;
}

// GA4 ecommerce requires `items`, and each item requires item_id or item_name.
// item_id is the socle (always present). item_name is matched BY variant_id
// against the Shopify order lines; when the match fails — or when createdOrder
// is unavailable (ambiguous recovery path) — item_name is OMITTED rather than
// invented. Free BXGY lines are kept as-is with price 0: that is the correct
// ecommerce representation, they are neither merged nor dropped.
//
// `price` is the NET unit price actually paid: (line subtotal - allocated
// discount share) / quantity / 100. Google requires the post-discount price,
// and an order-level discount to be spread over the items. Rounding: the unit
// price is rounded half-up to 2 decimals (Math.round on hundredths), the
// currency's smallest unit. With quantity > 1 and a share that is not divisible
// by the quantity, price x quantity may differ from the exact net line total by
// less than one cent per line; the cents themselves are never lost, only the
// per-unit display is rounded.
// When discountCents is 0/absent, shares are all 0 and the result is byte-for-
// byte what it was before this change.
function buildGa4Items(cart, createdOrder, discountCents) {
  const lines = (createdOrder && Array.isArray(createdOrder.line_items)) ? createdOrder.line_items : [];
  const titleByVariant = new Map();
  for (const li of lines) {
    if (!li || li.variant_id == null) continue;
    const title = li.title || li.name;
    const vid = String(li.variant_id);
    if (title && !titleByVariant.has(vid)) titleByVariant.set(vid, String(title));
  }
  const cartItems = (cart && cart.items) || [];
  const shares = allocateDiscountCents(cartItems, discountCents);
  return cartItems.map((it, idx) => {
    const id = String(it.variant_id);
    const item = { item_id: id };
    const name = titleByVariant.get(id);
    if (name) item.item_name = name;
    const priceCents = Math.round(Number(it.price_cents) || 0);
    const quantity = Number(it.quantity) || 1;
    const qty = Math.max(1, Math.round(quantity));
    const gross = priceCents > 0 ? priceCents * qty : 0;
    const net = Math.max(0, gross - (Number(shares[idx]) || 0));
    item.price = priceCents > 0 ? Math.round((net / qty)) / 100 : (priceCents || 0) / 100;
    item.quantity = quantity;
    return item;
  });
}

// GA4 purchase.value = SUM(price x quantity) over the items, shipping and tax
// EXCLUDED. Computed from the very items we send, so value and items always
// agree — including after a discount has been spread over them.
function ga4ItemsValueCents(items) {
  return (Array.isArray(items) ? items : []).reduce(
    (sum, it) => sum + Math.round((Number(it && it.price) || 0) * 100) * (Math.max(1, Math.round(Number(it && it.quantity) || 1))),
    0
  );
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
    // No engagement-time parameter is sent: it is not a session-attribution
    // condition (those are session_id, delivery within 24h of the session
    // start, and a timestamp_micros inside that session). A hardcoded 1 ms
    // would be an invented duration, and strict validation checks only types.
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
  // validation_behavior (underscore) is the documented field name, and Google
  // asks that it NOT be sent in production — it is therefore attached only on
  // the /debug/mp/collect path, never on /mp/collect.
  const body = validate ? { ...payload, validation_behavior: "ENFORCE_RECOMMENDATIONS" } : payload;
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
// The intention is persisted BEFORE done:<session> is written (so a crash
// there makes Stripe redeliver and rebuild it), and only ATTEMPTED afterwards,
// so a GA4 send failure can never be retried by Stripe. The outbox owns
// tracking idempotence:
// ga4:<session> holds the ready-to-post payload, ga4:queue lists the pending
// ids (a LIST, never SCAN). Nothing here may affect the order.
async function ga4Enqueue(sessionId, payload) {
  return outboxEnqueue("ga4", sessionId, payload, GA4_OUTBOX_TTL);
}

// One delivery attempt for an outbox entry; always persists the new state.
// Past the 72h backdating limit the entry is marked `expired` instead of being
// retried forever. The age is measured from payload.timestamp_micros, i.e. the
// Stripe Event instant, so a delayed payment confirmed days after checkout is
// dated at its confirmation and is not expired on sight.
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

// Opportunistic BI-CHANNEL drain: pop a few session ids, retry BOTH channels
// for each, and requeue the id only when at least one channel is still
// pending. Capped in count AND in wall-clock time (no maxDuration on this
// function). Callers must keep it inside a try/catch.
async function outboxDrain({ max = 3, budgetMs = 4000 } = {}) {
  const startedAt = Date.now();
  const summary = { popped: 0, sent: 0, failed: 0, expired: 0, skipped: 0, requeued: 0 };
  for (let i = 0; i < max; i++) {
    if (Date.now() - startedAt > budgetMs) break;
    const id = await kvLPop(OUTBOX_QUEUE_KEY);
    if (!id) break;
    summary.popped += 1;
    let stillPending = false;
    let touched = false;
    for (const channel of OUTBOX_CHANNELS) {
      const entry = await kvGet(`${channel}:${id}`);
      if (!entry || !entry.session_id) continue;
      if (entry.status === "sent" || entry.status === "expired") continue;
      touched = true;
      const out = channel === "ga4" ? await ga4TrySend(entry) : await metaTrySend(entry);
      if (out.status === "sent") summary.sent += 1;
      else if (out.status === "expired") summary.expired += 1;
      else { summary.failed += 1; stillPending = true; }
    }
    if (!touched) summary.skipped += 1;
    // Requeue only if something is still pending: a session whose two channels
    // are sent/expired leaves the queue for good.
    if (stillPending) { summary.requeued += 1; await kvRPush(OUTBOX_QUEUE_KEY, String(id)); }
  }
  return summary;
}

// Persist the purchase intention in the outbox — and nothing else. Sending is
// a separate step (ga4TrySend), deliberately: the durability of the intention
// must be acquired BEFORE done:<session> is written, while the delivery attempt
// belongs after the lease is released. Returns the outbox entry, or null when
// there is no real client_id.
async function ga4PersistIntent(opts) {
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
  return ga4Enqueue(opts.sessionId, payload);
}

// ---- Shared outbox plumbing (GA4 + Meta) --------------------------------
// Both channels have exactly the same failure mode, so they share exactly the
// same machinery: one JSON entry per channel per session
//   ga4:<stripe_session_id>   { session_id, payload, status, attempts,
//   meta:<stripe_session_id>     first_seen_at, sent_at?, last_error? }
//                             status ∈ pending | sent | expired
// and ONE queue holding SESSION IDS (never payloads), so a single queue entry
// covers both channels.
//
// QUEUE NAME: deliberately kept as "ga4:queue" even though it now serves both
// channels. Renaming it would orphan every id already queued in production —
// a LIST that is being popped concurrently by the webhook and by
// /api/ga4-retry has no safe in-place migration (a copy-then-delete races with
// live pops and can drop or duplicate ids). Read OUTBOX_QUEUE_KEY as
// "outbox:queue"; the string is legacy, the semantics are bi-channel.
const OUTBOX_QUEUE_KEY = GA4_QUEUE_KEY;
const OUTBOX_CHANNELS = ["ga4", "meta"];
const OUTBOX_SIBLING = { ga4: "meta", meta: "ga4" };

// IDEMPOTENT enqueue, shared by both channels. The intention is persisted
// BEFORE done:<session>, so a crash between the two makes Stripe redeliver and
// reach this code again: an existing entry is therefore NEVER rewritten (a
// `sent` entry must never fall back to `pending`) and the session id is pushed
// onto the queue AT MOST ONCE, even when the two channels are enqueued back to
// back — when the sibling channel already holds a `pending` entry the id is
// necessarily still in the queue, so the push is skipped. A sibling that is
// `sent`/`expired` may already have been popped and dropped, so in that case we
// do push: a duplicate id in the queue is harmless (the second pop finds both
// channels sent and skips), a missing one is a lost conversion.
async function outboxEnqueue(channel, sessionId, payload, ttlSeconds) {
  const key = `${channel}:${sessionId}`;
  const label = channel === "ga4" ? "GA4" : "Meta";
  const existing = await kvGet(key);
  if (existing && existing.session_id) {
    console.log(label, "outbox entry already present for", sessionId, "status:", existing.status, "— not re-enqueued");
    return existing;
  }
  const entry = {
    session_id: String(sessionId),
    payload,
    status: "pending",
    attempts: 0,
    first_seen_at: Date.now(),
  };
  await kvSet(key, entry, ttlSeconds);
  let siblingPending = false;
  try {
    const sibling = await kvGet(`${OUTBOX_SIBLING[channel]}:${sessionId}`);
    siblingPending = !!(sibling && sibling.session_id && sibling.status === "pending");
  } catch (e) {
    // Unknown sibling state: push. A duplicate id is benign, a missing one is not.
    console.error("outbox sibling lookup failed for", sessionId, String((e && e.message) || e));
  }
  if (!siblingPending) await kvRPush(OUTBOX_QUEUE_KEY, String(sessionId));
  return entry;
}

// ---- Meta CAPI outbox ---------------------------------------------------
// TTL is 8 days, longer than GA4's 4, because Meta's acceptance window is
// longer (see META_MAX_AGE_MS).
const META_OUTBOX_TTL = 691200;                  // 8 days > Meta's 7-day window
// GA4's 72h backdating limit is a GA4 rule and is deliberately NOT applied
// here: the Conversions API accepts events up to 7 days old. Reusing 72h would
// abandon events Meta would still have accepted. The `expired` state is kept —
// same state machine — only the threshold differs.
const META_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// One delivery attempt for a Meta outbox entry; always persists the new state.
// The age is measured from the stored event_time, so a retry never re-dates the
// event and never resets its own expiry clock.
async function metaTrySend(entry) {
  const key = `meta:${entry.session_id}`;
  const evt = entry.payload && entry.payload.data && entry.payload.data[0];
  const eventTime = Number(evt && evt.event_time) || 0;
  if (eventTime > 0 && Date.now() - eventTime * 1000 > META_MAX_AGE_MS) {
    entry.status = "expired";
    entry.last_error = "older than Meta's 7-day event window — abandoned";
    await kvSet(key, entry, META_OUTBOX_TTL);
    return entry;
  }
  try {
    const r = await metaPost(entry.payload);
    // Explicitly assert Meta acknowledged the event, not just HTTP 200.
    if (!r.ok || !r.json || r.json.events_received !== 1) {
      throw new Error("Meta CAPI HTTP " + r.status + " body: " + JSON.stringify(r.json || {}).slice(0, 300));
    }
    entry.status = "sent";
    entry.sent_at = Date.now();
    delete entry.last_error;
    console.log("Meta CAPI ok:", entry.session_id, JSON.stringify(r.json));
  } catch (e) {
    entry.status = "pending";
    entry.attempts = (Number(entry.attempts) || 0) + 1;
    entry.last_error = String((e && e.message) || e).slice(0, 200);
    console.error("Meta CAPI FAILED for", entry.session_id, entry.last_error);
  }
  await kvSet(key, entry, META_OUTBOX_TTL);
  return entry;
}

// Persist the Meta purchase intention in the outbox — and nothing else.
// Returns the outbox entry, or null when the CAPI credentials are missing (an
// unsendable entry would just churn the queue until it expires).
async function metaPersistIntent(opts) {
  if (!process.env.META_PIXEL_ID || !process.env.META_CAPI_TOKEN) {
    console.error("Meta CAPI SKIPPED: META_PIXEL_ID / META_CAPI_TOKEN not set in Vercel");
    return null;
  }
  const body = buildMetaPurchaseBody(opts);
  const cd = body.data[0].custom_data;
  console.log("Meta purchase queued:", opts.sessionId, "value:", cd.value, cd.currency);
  return outboxEnqueue("meta", opts.sessionId, body, META_OUTBOX_TTL);
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

const ATTRIBUTION_MODEL = "last_paid_else_first_free_v1";
const EMAIL_LIKE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/i;

function containsEmail(value) {
  if (value == null) return false;
  let candidate = String(value);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (EMAIL_LIKE.test(candidate)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return EMAIL_LIKE.test(candidate);
}

// Attribution is copied from a browser-controlled request to Stripe metadata,
// then to Shopify. Validate it again at this final trust boundary: reports and
// order notes must never become a store for email addresses or arbitrary text.
function safeAttributionText(value, max = 500) {
  if (value == null) return null;
  const clean = String(value).trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  if (!clean || containsEmail(clean)) return null;
  return clean.slice(0, max);
}

function safeAttributionUrl(value, max = 500) {
  if (value == null || !String(value).trim()) return null;
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    // A storefront path can accidentally contain an email (for example an
    // email-platform preview URL). Keep only the harmless origin.
    if (containsEmail(url.pathname)) url.pathname = "/";
    return `${url.origin}${url.pathname}`.slice(0, max);
  } catch {
    return null;
  }
}

function safeAttributionAt(value) {
  const text = safeAttributionText(value, 40);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function safeClickId(value) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw || raw.length > 255) return null;
  const text = safeAttributionText(raw, 255);
  if (!text || text.length < 6 || !/^[A-Za-z0-9._~-]+$/.test(text)) return null;
  return text;
}

function safeFacebookBrowserId(value) {
  const text = safeAttributionText(value, 300);
  if (!text) return null;
  const match = /^fb\.1\.(\d{10,16})\.([A-Za-z0-9._~-]{6,200})$/.exec(text);
  return match ? text : null;
}

// The shop's explicit attribution contract treats these eight redirect IDs as
// paid-click evidence. fbc remains a matching cookie and is not proof alone.
function validatedClickIds(attribution) {
  const data = attribution || {};
  return {
    gclid: safeClickId(data.gclid),
    gbraid: safeClickId(data.gbraid),
    wbraid: safeClickId(data.wbraid),
    dclid: safeClickId(data.dclid),
    msclkid: safeClickId(data.msclkid),
    ttclid: safeClickId(data.ttclid),
    sccid: safeClickId(data.sccid),
    fbclid: safeClickId(data.fbclid),
    fbc: safeFacebookBrowserId(data.fbc),
  };
}

function googleAdsClickIds(attribution) {
  const ids = validatedClickIds(attribution);
  return ["gclid", "gbraid", "wbraid", "dclid"].flatMap((type) => ids[type] ? [{ type, value: ids[type] }] : []);
}

function searchEngineFromReferrer(referrer) {
  if (!referrer) return null;
  try {
    const host = new URL(String(referrer)).hostname.toLowerCase().replace(/^www\./, "");
    if (host === "google.com" || host.startsWith("google.") || host.includes(".google.")) return "Google";
    if (host === "bing.com" || host.endsWith(".bing.com")) return "Bing";
    if (host === "search.yahoo.com" || host.endsWith(".search.yahoo.com")) return "Yahoo";
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) return "DuckDuckGo";
    if (host === "ecosia.org" || host.endsWith(".ecosia.org")) return "Ecosia";
    if (host === "baidu.com" || host.endsWith(".baidu.com")) return "Baidu";
    if (host === "yandex.com" || host.startsWith("yandex.") || host.includes(".yandex.")) return "Yandex";
  } catch {
    return null;
  }
  return null;
}

function externalReferrerHost(referrer) {
  if (!referrer) return null;
  try {
    const host = new URL(String(referrer)).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || host === "puremajestypet.com" || host.endsWith(".puremajestypet.com")) return null;
    return host;
  } catch {
    return null;
  }
}

export function entryPageIdentity(pageUrl) {
  if (!pageUrl) return { type: null, handle: null };
  try {
    const segments = new URL(String(pageUrl)).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (!segments.length) return { type: "homepage", handle: null };
    if (segments[0] === "blogs" && segments.length >= 3) {
      return { type: "article", handle: segments.slice(2).join("/") };
    }
    if (segments[0] === "products" && segments[1]) return { type: "product", handle: segments.slice(1).join("/") };
    if (segments[0] === "collections" && segments[1]) return { type: "collection", handle: segments.slice(1).join("/") };
    if (segments[0] === "pages" && segments[1]) return { type: "page", handle: segments.slice(1).join("/") };
    return { type: segments[0], handle: segments.slice(1).join("/") || null };
  } catch {
    return { type: null, handle: null };
  }
}

function normalizeAttributionToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function paidMedium(medium) {
  const med = normalizeAttributionToken(medium);
  return new Set([
    "paid", "cpc", "ppc", "paid_social", "paid_search", "paidsearch",
    "sem", "display", "retargeting", "remarketing", "cpm",
  ]).has(med);
}

function sourcePlatform(source) {
  const src = normalizeAttributionToken(source);
  if (["google", "google_ads", "adwords"].includes(src) || src.startsWith("google_")) return "google";
  if (["meta", "facebook", "instagram", "fb", "ig"].includes(src) || /(^|_)(facebook|instagram)($|_)/.test(src)) return "meta";
  if (["microsoft", "microsoft_ads", "bing", "bing_ads"].includes(src)) return "microsoft";
  if (["tiktok", "tik_tok", "tiktok_ads"].includes(src)) return "tiktok";
  if (["snapchat", "snap", "snapchat_ads", "snap_ads"].includes(src)) return "snapchat";
  return null;
}

function socialSourceLabel(source) {
  const src = normalizeAttributionToken(source);
  if (src === "instagram" || src === "ig") return "Instagram";
  if (src === "facebook" || src === "fb") return "Facebook";
  if (src === "meta") return "Meta";
  if (src === "tiktok" || src === "tik_tok") return "TikTok";
  if (src === "snapchat" || src === "snap") return "Snapchat";
  return safeAttributionText(source, 100) || "Social";
}

function paidPlatformLabel(platform, source) {
  if (platform === "google") return "Google Ads (paid)";
  if (platform === "meta") return "Meta Ads (paid)";
  if (platform === "microsoft") return "Microsoft Ads (paid)";
  if (platform === "tiktok") return "TikTok Ads (paid)";
  if (platform === "snapchat") return "Snapchat Ads (paid)";
  return `${safeAttributionText(source, 100) || "Paid"} Ads (paid)`;
}

function touchFrom(attribution, prefix) {
  const data = attribution || {};
  const key = (name) => prefix ? `${prefix}_${name}` : name;
  const landingValue = prefix
    ? (data[key("landing")] || data[key("landing_url")])
    : (data.landing_page || data.landing_url);
  return {
    landing: safeAttributionUrl(landingValue),
    referrer: safeAttributionUrl(data[key("referrer")]),
    source: safeAttributionText(prefix ? data[key("source")] : data.utm_source, 100),
    medium: safeAttributionText(prefix ? data[key("medium")] : data.utm_medium, 100),
    campaign: safeAttributionText(prefix ? data[key("campaign")] : data.utm_campaign, 200),
    at: safeAttributionAt(prefix ? data[key("at")] : (data.bridge_started_at || data.captured_at)),
    content: safeAttributionText(prefix ? data[key("content")] : data.utm_content, 200),
  };
}

function touchHasSignal(touch) {
  return Boolean(touch && (touch.landing || touch.referrer || touch.source || touch.medium || touch.campaign));
}

function identifiableFreeTouch(touch, channel) {
  if (!touchHasSignal(touch) || !channel || channel.paid) return false;
  // A landing URL by itself is only a direct session, not an identifiable
  // acquisition click. Source/medium/campaign or an external referrer is
  // required before we call a touch "first free".
  const meaningful = (value) => {
    const token = normalizeAttributionToken(value).replace(/[()]/g, "");
    return Boolean(token && !["direct", "none", "unknown", "not_set", "unset"].includes(token));
  };
  return Boolean(
    meaningful(touch.source) || meaningful(touch.medium) || meaningful(touch.campaign) ||
    externalReferrerHost(touch.referrer),
  );
}

// Human-readable channel for the Shopify order screen. Browser-only channel
// signals are labelled as inferred; validated ad IDs and explicit paid UTMs
// are sufficient to classify a paid click.
export function classifyEntryChannel({ attribution, source, medium, campaign, referrer, content, allowClickIds = true }) {
  const data = attribution || {};
  const ids = validatedClickIds(data);
  const src = normalizeAttributionToken(source);
  const med = normalizeAttributionToken(medium);
  const camp = normalizeAttributionToken(campaign);
  const normalizedContent = normalizeAttributionToken(content || data.utm_content);
  let platform = sourcePlatform(src);

  if (allowClickIds && !platform) {
    if (ids.gclid || ids.gbraid || ids.wbraid || ids.dclid) platform = "google";
    else if (ids.msclkid) platform = "microsoft";
    else if (ids.ttclid) platform = "tiktok";
    else if (ids.sccid) platform = "snapchat";
    else if (ids.fbclid) platform = "meta";
  }
  const hasPaidProof = allowClickIds && Boolean(
    ids.gclid || ids.gbraid || ids.wbraid || ids.dclid || ids.fbclid ||
    ids.msclkid || ids.ttclid || ids.sccid
  );
  if (hasPaidProof || paidMedium(med)) {
    return { label: paidPlatformLabel(platform, source), seo: false, freeListing: false, paid: true, platform };
  }

  const engine = searchEngineFromReferrer(referrer) ||
    (src.includes("google") ? "Google" : src.includes("bing") ? "Bing" : src.includes("yahoo") ? "Yahoo" : null);

  // Shopify's Google product-sync links commonly carry these exact values.
  // They are kept distinct from classic SEO because a free product listing is
  // not the same acquisition surface as a normal organic search result.
  if (src.includes("google") && (med === "product_sync" || camp.includes("sag_organic") || normalizedContent.includes("sag_organic"))) {
    return { label: "Google free listing (inferred)", seo: false, freeListing: true, paid: false, platform: "google" };
  }
  if (med === "organic" || med === "organic_search" || (engine && !med && !camp)) {
    return { label: `${engine || source || "Search"} organic search / SEO (inferred)`, seo: true, freeListing: false, paid: false, platform };
  }
  if (med === "email" || src.includes("email") || src.includes("omnisend")) {
    return { label: "Email", seo: false, freeListing: false, paid: false, platform: null };
  }
  if (["dm", "direct_message", "direct_messages"].includes(med)) {
    return { label: `${socialSourceLabel(source)} DM`, seo: false, freeListing: false, paid: false, platform };
  }
  if (med === "organic_social" || med === "social") {
    return { label: `${socialSourceLabel(source)} organic social (inferred)`, seo: false, freeListing: false, paid: false, platform };
  }
  const referrerHost = externalReferrerHost(referrer);
  if (referrerHost) return { label: `Referral: ${referrerHost}`, seo: false, freeListing: false, paid: false, platform: null };
  if (source || medium) return { label: [source, medium].filter(Boolean).join(" / "), seo: false, freeListing: false, paid: false, platform };
  return { label: "Direct / unknown", seo: false, freeListing: false, paid: false, platform: null };
}

export function entryAttributionAttributes(attribution) {
  const data = attribution || {};
  const firstEntry = touchFrom(data, "first_entry");
  const firstFree = touchFrom(data, "first_touch");
  const session = touchFrom(data, "");
  const entry = touchHasSignal(firstEntry) ? firstEntry : (touchHasSignal(firstFree) ? firstFree : session);
  if (!touchHasSignal(entry) && !googleAdsClickIds(data).length) return {};
  const entryBasis = touchHasSignal(firstEntry) ? "first_entry" : (touchHasSignal(firstFree) ? "first_touch" : "session_landing");
  const channel = classifyEntryChannel({
    attribution: data,
    source: entry.source,
    medium: entry.medium,
    campaign: entry.campaign,
    referrer: entry.referrer,
    content: entry.content,
    allowClickIds: entryBasis === "session_landing",
  });
  const pageIdentity = entryPageIdentity(entry.landing);
  return {
    entry_page: entry.landing,
    entry_basis: entryBasis,
    entry_page_type: pageIdentity.type,
    entry_page_handle: pageIdentity.handle,
    entry_referrer: entry.referrer,
    entry_channel: channel.label,
    entry_source: entry.source,
    entry_medium: entry.medium,
    entry_campaign: entry.campaign,
    seo_organic: channel.seo ? "yes (inferred)" : null,
  };
}

function touchAttributes(prefix, touch) {
  return {
    [`${prefix}_landing`]: touch.landing,
    [`${prefix}_referrer`]: touch.referrer,
    [`${prefix}_source`]: touch.source,
    [`${prefix}_medium`]: touch.medium,
    [`${prefix}_campaign`]: touch.campaign,
    [`${prefix}_at`]: touch.at,
  };
}

export function orderAttributionAttributes(attribution) {
  const data = attribution || {};
  const firstEntry = touchFrom(data, "first_entry");
  const firstFree = touchFrom(data, "first_touch");
  const lastPaid = touchFrom(data, "last_touch");
  const session = touchFrom(data, "");

  const classify = (touch, allowClickIds) => classifyEntryChannel({
    attribution: data,
    source: touch.source,
    medium: touch.medium,
    campaign: touch.campaign,
    referrer: touch.referrer,
    content: touch.content,
    allowClickIds,
  });
  const lastPaidChannel = classify(lastPaid, true);
  const sessionChannel = classify(session, true);
  const firstFreeChannel = classify(firstFree, false);
  const firstEntryChannel = classify(firstEntry, false);

  let primary = session;
  let primaryChannel = sessionChannel;
  let basis = "current_session";
  let basisLabel = "current session";
  // last_touch is the canonical latest paid click. Current-session paid data
  // is the compatibility fallback for checkouts created by an older client.
  if (touchHasSignal(lastPaid) && lastPaidChannel.paid) {
    primary = lastPaid;
    primaryChannel = lastPaidChannel;
    basis = "last_paid_click";
    basisLabel = "last paid click";
  } else if (sessionChannel.paid) {
    basis = "last_paid_click";
    basisLabel = "last paid click";
  } else if (identifiableFreeTouch(firstFree, firstFreeChannel)) {
    primary = firstFree;
    primaryChannel = firstFreeChannel;
    basis = "first_free_click";
    basisLabel = "first free click";
  } else if (identifiableFreeTouch(firstEntry, firstEntryChannel)) {
    primary = firstEntry;
    primaryChannel = firstEntryChannel;
    basis = "first_free_click";
    basisLabel = "first free click";
  }

  const legacyEntry = entryAttributionAttributes(data);
  const firstEntryIsFree = identifiableFreeTouch(firstEntry, firstEntryChannel);
  const firstFreeEffective = identifiableFreeTouch(firstFree, firstFreeChannel)
    ? firstFree : (firstEntryIsFree ? firstEntry : null);
  const lastPaidEffective = touchHasSignal(lastPaid) && lastPaidChannel.paid
    ? lastPaid : (sessionChannel.paid ? session : null);
  return {
    attributes: {
      tracking_version: safeAttributionText(data.tracking_version, 40),
      attribution_model: ATTRIBUTION_MODEL,
      attribution_basis: basis,
      attribution_channel: primaryChannel.label,
      attribution_landing: primary.landing,
      attribution_referrer: primary.referrer,
      attribution_source: primary.source,
      attribution_medium: primary.medium,
      attribution_campaign: primary.campaign,
      attribution_at: primary.at,
      ...touchAttributes("first_entry", firstEntry),
      first_entry_channel: touchHasSignal(firstEntry) ? firstEntryChannel.label : null,
      ...legacyEntry,
      ...touchAttributes("first_touch", firstFree),
      ...touchAttributes("last_touch", lastPaid),
      ...(firstFreeEffective ? touchAttributes("first_free", firstFreeEffective) : {}),
      ...(lastPaidEffective ? touchAttributes("last_paid", lastPaidEffective) : {}),
    },
    basis,
    basisLabel,
    primary,
    channel: primaryChannel,
    firstEntry,
  };
}

export async function createShopifyOrder({ items, currency, email, phone, shipping, billing, note, sessionId, discount, chargedCents, attribution }) {
  const charged = Number(chargedCents);
  if (!Number.isInteger(charged) || charged < 0) throw new Error("Invalid signed Stripe amount");
  const noteAttributes = sessionId ? [{ name: "stripe_session_id", value: String(sessionId) }] : [];
  const bridgeCorrelation = {
    pmp_journey_id: attribution && attribution.journey_id,
    shopify_cart_token: attribution && attribution.shopify_cart_token,
    bridge_client_reference_id: attribution && attribution.client_reference_id,
    bridge_started_at: attribution && attribution.bridge_started_at,
  };
  Object.entries(bridgeCorrelation).forEach(([name, value]) => {
    const clean = safeAttributionText(value, 500);
    if (clean) noteAttributes.push({ name, value: clean });
  });
  const attributionSummary = orderAttributionAttributes(attribution);
  const clickIds = validatedClickIds(attribution);
  const googleClickIds = googleAdsClickIds(attribution);
  for (const click of googleClickIds) {
    noteAttributes.push({ name: `google_ads_${click.type}`, value: click.value });
  }
  if (clickIds.msclkid) noteAttributes.push({ name: "microsoft_ads_msclkid", value: clickIds.msclkid });
  if (clickIds.ttclid) noteAttributes.push({ name: "tiktok_ads_ttclid", value: clickIds.ttclid });
  if (clickIds.sccid) noteAttributes.push({ name: "snapchat_ads_sccid", value: clickIds.sccid });
  if (clickIds.fbc) noteAttributes.push({ name: "meta_fbc", value: clickIds.fbc });
  if (clickIds.fbclid) noteAttributes.push({ name: "meta_fbclid", value: clickIds.fbclid });

  const paidPlatform = attributionSummary.channel.paid ? attributionSummary.channel.platform : null;
  if (paidPlatform) {
    noteAttributes.push({ name: `${paidPlatform}_ads_paid`, value: "yes" });
    if (paidPlatform === "meta" && clickIds.fbc) {
      noteAttributes.push({ name: "meta_ads_fbc", value: clickIds.fbc });
    }
    if (paidPlatform === "meta" && clickIds.fbclid) {
      noteAttributes.push({ name: "meta_ads_fbclid", value: clickIds.fbclid });
    }
  }
  Object.entries(attributionSummary.attributes).forEach(([name, value]) => {
    if (value != null && String(value).trim()) noteAttributes.push({ name, value: String(value).trim().slice(0, 500) });
  });

  const acquisitionParts = [`Acquisition: ${attributionSummary.channel.label} (${attributionSummary.basisLabel}).`];
  if (attributionSummary.primary.landing) acquisitionParts.push(`Page: ${attributionSummary.primary.landing}.`);
  if (attributionSummary.firstEntry.landing) acquisitionParts.push(`First entry: ${attributionSummary.firstEntry.landing}.`);
  const acquisitionNote = acquisitionParts.join(" ");

  const attributionTags = [
    attributionSummary.basis === "last_paid_click" ? "attribution_last_paid" :
      attributionSummary.basis === "first_free_click" ? "attribution_first_free" : "attribution_session",
    ...(paidPlatform ? [`${paidPlatform}_ads_paid`] : []),
    ...(attributionSummary.channel.freeListing ? ["google_free_listing"] : []),
    ...(attributionSummary.channel.seo ? ["seo_organic"] : []),
  ];

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
    note: `Paid via Stripe (${(currency || "").toUpperCase()}). Stripe session: ${sessionId || "n/a"}. ${acquisitionNote} ${note || ""}`.trim(),
    // Machine-readable link back to the Stripe payment (refunds, dedup, audits).
    note_attributes: noteAttributes.length ? noteAttributes : undefined,
    source_identifier: String(sessionId),
    // Shopify tags are limited to 40 characters; keep the full Session ID in
    // source_identifier/note_attributes and use a deterministic short tag.
    tags: [
      "stripe",
      `stripe_${crypto.createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32)}`,
      ...attributionTags,
    ].join(", "),
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
          // The order exists, but the delivery that created it may have died
          // before persisting the GA4 intention. Rebuild it here — BEFORE the
          // done marker and before the cart is deleted — otherwise this path
          // acknowledges the webhook and the conversion is lost for good.
          // Failing to PERSIST a tracking intention must fail the webhook.
          // Writing done: anyway would make Stripe's redelivery answer
          // `duplicate: true` and the conversion would be lost for good.
          // Deliberate abstention (a `null` return: no real ga_client_id, or
          // Meta credentials not configured) is a SUCCESS, not a failure, and
          // never lands here.
          const reconcilePersistFailures = [];

          // The cart may already have been deleted (or expired) on this path:
          // read it first, and fall back on session.metadata for the GA4 ids.
          // Reading it obeys exactly the same rule as writing the outbox:
          //   - kvGet returns null  -> the cart is GENUINELY absent (expired
          //     past its 30-day TTL, or already deleted by an earlier run). A
          //     legitimate, definitive state: the degraded intention (no items,
          //     value 0) is persisted below, unchanged, and we answer 200.
          //   - kvGet THROWS        -> TECHNICAL failure (Redis unavailable,
          //     timeout, unusable Upstash response). The cart is probably still
          //     there. Persisting a degraded intention now would be definitive,
          //     because outboxEnqueue is idempotent and would never rebuild it.
          //     So we persist NOTHING, keep the cart, skip done:, and 500 so
          //     Stripe redelivers and the cart is read properly next time.
          let reconciledCart = null;
          let cartReadFailed = false;
          try { reconciledCart = await kvGet(key); }
          catch (e) {
            cartReadFailed = true;
            reconcilePersistFailures.push("cart read: " + String((e && e.message) || e));
            console.error("reconciliation: cart read failed for", key, String((e && e.message) || e));
          }

          // Skipped entirely when the cart read failed technically: an
          // impoverished intention persisted here could never be rebuilt.
          if (!cartReadFailed) {
            try {
              const existingGa4 = await kvGet(`ga4:${session.id}`);
              if (existingGa4 && existingGa4.session_id) {
                console.log("GA4 reconciliation: outbox entry already present for", session.id, "status:", existingGa4.status);
              } else {
                const reconciledClientId =
                  (reconciledCart && reconciledCart.ga_client_id) ||
                  (session.metadata && session.metadata.ga_client_id) || null;
                if (!reconciledClientId) {
                  // A fabricated client_id would create a parasitic
                  // direct/(none) user: no entry at all is the lesser evil.
                  console.error("GA4 reconciliation SKIPPED for", session.id, ": no ga_client_id (cart + session.metadata both empty)");
                } else {
                  // Without the cart there are no lines: the purchase is queued
                  // WITHOUT items (value 0) rather than not queued at all.
                  // existingOrder carries no line_items, so item_name is simply
                  // omitted — never invented. No promo amount was fetched on this
                  // path: discountCents stays 0, so `value` is the GROSS items
                  // total, which may exceed the amount actually charged when a
                  // Stripe promotion code was used. Logged below, never guessed.
                  let reconciledItems = [];
                  if (reconciledCart) {
                    try { reconciledItems = buildGa4Items(reconciledCart, null, 0); }
                    catch (e) { console.error("GA4 reconciliation items build failed", e); reconciledItems = []; }
                  } else {
                    console.warn("GA4 reconciliation for", session.id, ": cart unavailable — queuing purchase WITHOUT items (value 0)");
                  }
                  await ga4PersistIntent({
                    sessionId: session.id,
                    itemsValueCents: ga4ItemsValueCents(reconciledItems),
                    chargedCents: session.amount_total,
                    currency: session.currency || (reconciledCart && reconciledCart.currency),
                    gaClientId: reconciledClientId,
                    gaSessionId: (reconciledCart && reconciledCart.ga_session_id) || (session.metadata && session.metadata.ga_session_id) || null,
                    gaSessionNumber: (reconciledCart && reconciledCart.ga_session_number) || (session.metadata && session.metadata.ga_session_number) || null,
                    items: reconciledItems,
                    timestampMicros: ga4TimestampMicros(event),
                  });
                }
              }
            } catch (e) {
              // Technical failure (Redis/Upstash): refuse to write done: and let
              // Stripe redeliver. The order already exists in Shopify and
              // findShopifyOrder() brings us straight back here.
              reconcilePersistFailures.push("ga4: " + String((e && e.message) || e));
              console.error("GA4 reconciliation outbox persist FAILED for", session.id, e);
            }

            // Same treatment for Meta CAPI, under the same conditions: BEFORE the
            // done marker and BEFORE the cart is deleted, reading the cart above
            // (reconciledCart) before any deletion. outboxEnqueue is idempotent,
            // so an entry already sent by the delivery that created the order is
            // never resurrected. Fully wrapped: no Meta path may fail the order.
            try {
              const rcd = session.customer_details || {};
              const rsd = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
              await metaPersistIntent({
                sessionId: session.id,
                email: rcd.email,
                phone: rcd.phone,
                // Identical semantics to the nominal path: amount actually charged.
                value: (Number(session.amount_total) || 0) / 100,
                currency: session.currency || (reconciledCart && reconciledCart.currency),
                cart: reconciledCart,
                address: rsd.address || rcd.address || {},
                name: rsd.name || rcd.name,
                orderId: existingOrder.legacyResourceId || existingOrder.id,
                orderNumber: existingOrder.name,
                // Cart may be gone: fbp / fbc / browser id survive in Stripe
                // metadata. ua and ip do NOT exist there and stay absent.
                fallback: {
                  fbp: (session.metadata && session.metadata.fbp) || null,
                  fbc: (session.metadata && session.metadata.fbc) || null,
                  external_id: (session.metadata && (session.metadata.browser_id || session.metadata.person_id)) || null,
                },
              });
            } catch (e) {
              reconcilePersistFailures.push("meta: " + String((e && e.message) || e));
              console.error("Meta reconciliation outbox persist FAILED for", session.id, e);
            }
          }

          // Exit BEFORE kvSet(doneKey) and BEFORE the cart kvDel below: the
          // cart must survive so the redelivery can rebuild the payloads.
          if (reconcilePersistFailures.length) {
            try { await kvRelease(claimKey, claimToken); } catch (releaseError) { console.error("lease release failed", releaseError); }
            console.error("cart read or tracking outbox persist failed on the reconciliation path for", session.id, "— order exists in Shopify, asking Stripe to redeliver:", reconcilePersistFailures.join(" | "));
            return res.status(500).json({
              error: "order exists but tracking persistence failed, retry",
              order_created: true,
              tracking_persisted: false,
              detail: reconcilePersistFailures.join(" | "),
            });
          }

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
            attribution: Object.assign({}, session.metadata || {}, cart || {}, {
              // Stripe's client_reference_id is the authoritative copy. Redis
              // remains the fallback for sessions created before this field was
              // added to the webhook order path.
              client_reference_id: session.client_reference_id || (cart && cart.client_reference_id) ||
                (session.metadata && session.metadata.browser_id) || null,
            }),
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

        // GA4 intention persisted BEFORE done:<session>. If the process dies
        // between the two, done: does not exist yet: Stripe redelivers, the
        // reconciliation path above finds the order and creates the outbox
        // entry. ga4Enqueue is idempotent, so a crash between the enqueue and
        // the done write cannot produce a second queue entry.
        // item_name is matched by variant_id against the Shopify order lines,
        // and omitted when the match fails (never invented). The Stripe promo
        // discount is spread over the paying lines so `price` and `value` are
        // the amounts actually paid. Built defensively: a GA4 failure must
        // never touch the order nor the webhook response.
        let ga4Items = [];
        try { ga4Items = buildGa4Items(cart, createdOrder, (discount && discount.cents) || 0); }
        catch (e) { console.error("GA4 items build failed", e); ga4Items = []; }

        // Same rule as the reconciliation path: a persist failure fails the
        // webhook (no done:, no cart deletion, 500) so Stripe redelivers; a
        // deliberate abstention returning null is a success.
        const persistFailures = [];

        let ga4Entry = null;
        try {
          ga4Entry = await ga4PersistIntent({
            sessionId: session.id,
            // GA4 value = SUM(net price x quantity) of items, shipping and
            // tax EXCLUDED, and net of any Stripe promotion code (spread over
            // the paying lines). session.amount_total stays available and is
            // logged, but is no longer sent as `value`.
            itemsValueCents: ga4ItemsValueCents(ga4Items),
            chargedCents: session.amount_total,
            currency: session.currency || cart.currency,
            // Redis may have expired; Stripe metadata is durable, so fall back on it.
            gaClientId: (cart && cart.ga_client_id) || (session.metadata && session.metadata.ga_client_id) || null,
            gaSessionId: (cart && cart.ga_session_id) || (session.metadata && session.metadata.ga_session_id) || null,
            gaSessionNumber: (cart && cart.ga_session_number) || (session.metadata && session.metadata.ga_session_number) || null,
            items: ga4Items,
            timestampMicros: ga4TimestampMicros(event),
          });
        } catch (e) {
          // Technical failure (Redis/Upstash): refuse to write done:. The order
          // is already durable in Shopify, so the redelivery is reconciled and
          // outboxEnqueue is idempotent — no duplicate order, no duplicate entry.
          persistFailures.push("ga4: " + String((e && e.message) || e));
          console.error("GA4 outbox persist FAILED for", session.id, e);
        }

        // Meta CAPI intention persisted BEFORE done:<session>, exactly like
        // GA4 and for exactly the same reason: it used to be SENT after the
        // done marker, so a crash in between made the redelivery answer
        // `duplicate: true` and the Purchase event was never sent at all.
        // Building the body here also freezes event_time and event_id, so any
        // later retry is byte-identical and Meta de-dupes it against the pixel.
        let metaEntry = null;
        try {
          metaEntry = await metaPersistIntent({
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
        } catch (e) {
          persistFailures.push("meta: " + String((e && e.message) || e));
          console.error("Meta outbox persist FAILED for", session.id, e);
        }

        // Exit BEFORE kvSet(doneKey) and BEFORE the cart kvDel further down:
        // the cart must survive so the redelivery can rebuild the payloads.
        if (persistFailures.length) {
          try { await kvRelease(claimKey, claimToken); } catch (releaseError) { console.error("lease release failed", releaseError); }
          console.error("tracking outbox persist failed for", session.id, "— order is created in Shopify, asking Stripe to redeliver:", persistFailures.join(" | "));
          return res.status(500).json({
            error: "order created but tracking persistence failed, retry",
            order_created: true,
            tracking_persisted: false,
            detail: persistFailures.join(" | "),
          });
        }

        // Completion is durable before analytics. If this write fails, Stripe
        // retries and Shopify reconciliation prevents a duplicate order.
        await kvSet(doneKey, { order_id: createdOrder && createdOrder.id, completed_at: Date.now() }, 7776000);
        await kvRelease(claimKey, claimToken);

        // Server-side ad tracking: delivery attempt only (never blocks the
        // order; pixel is the backup). done:<session> is already durable above,
        // so Stripe will never retry a Meta failure: the meta:<session> outbox
        // persisted BEFORE the done marker carries that retry instead.
        try {
          if (metaEntry && metaEntry.status !== "sent" && metaEntry.status !== "expired") await metaTrySend(metaEntry);
        } catch (e) { console.error("Meta CAPI error", e); }

        // Delivery attempt only (never blocks the order; pixel is the backup).
        // done:<session> is already durable above, so Stripe will never retry a
        // GA4 failure: the ga4:<session> outbox persisted BEFORE the done marker
        // carries that retry instead.
        try {
          if (ga4Entry && ga4Entry.status !== "sent" && ga4Entry.status !== "expired") await ga4TrySend(ga4Entry);
        } catch (e) { console.error("GA4 MP error", e); }

        // Opportunistic outbox drain: at most 3 entries, hard time budget, and
        // wrapped so it can never fail the webhook or touch the order state.
        try {
          const drained = await outboxDrain({ max: 3, budgetMs: 4000 });
          if (drained.popped) console.log("outbox drain:", JSON.stringify(drained));
        } catch (e) { console.error("outbox drain error", e); }

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

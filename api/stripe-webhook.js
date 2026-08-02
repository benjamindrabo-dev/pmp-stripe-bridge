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

async function kvGet(key) {
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  if (!r.ok) throw new Error("Upstash get failed: " + r.status);
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}
async function kvDel(key) {
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
}
// Atomic claim (SET NX): if Stripe delivers the same webhook twice concurrently,
// only ONE delivery wins the claim and creates the Shopify order.
// Three-state result: "ok" (claimed), "dup" (someone else holds it), "error"
// (Redis unreachable). An error is NOT a duplicate — the caller returns 5xx so
// Stripe retries. TTL 24h matches the cart TTL; if order creation fails the
// claim is RELEASED so a Stripe retry can succeed.
async function kvClaim(key) {
  try {
    // Canonical Upstash REST form: POST the raw Redis command as a JSON array.
    // (The path style `?NX=true` is NOT accepted and made every call fail.)
    const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, "1", "NX", "EX", "86400"]),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || typeof j !== "object" || "error" in j) {
      console.error("kvClaim error:", r.status, JSON.stringify(j || {}).slice(0, 200));
      return "error";
    }
    return j.result === "OK" ? "ok" : "dup"; // result null => key already set => duplicate
  } catch (e) {
    console.error("kvClaim network error:", String(e && e.message || e));
    return "error";
  }
}
async function kvRelease(key) { try { await kvDel(key); } catch (e) { console.error("claim release failed", key); } }

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
  if (cart && cart.external_id) extIds.push(cart.external_id);
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
        event_source_url: process.env.SUCCESS_URL || undefined,
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

async function createShopifyOrder({ items, currency, email, phone, shipping, billing, note, sessionId }) {
  const order = {
    line_items: items.map((it) => {
      const li = { variant_id: Number(it.variant_id), quantity: Number(it.quantity) };
      // Use the presentment price the customer actually paid, so the order
      // total matches the Stripe charge (esp. for non-shop currencies).
      if (it.price_cents != null) li.price = (Number(it.price_cents) / 100).toFixed(2);
      return li;
    }),
    financial_status: "paid",
    email: email || undefined,
    phone: phone || undefined,
    note: `Paid via Stripe (${(currency || "").toUpperCase()}). Stripe session: ${sessionId || "n/a"}. ${note || ""}`.trim(),
    // Machine-readable link back to the Stripe payment (refunds, dedup, audits).
    note_attributes: sessionId ? [{ name: "stripe_session_id", value: String(sessionId) }] : undefined,
    tags: "stripe",
    send_receipt: true,
    send_fulfillment_receipt: false,
    inventory_behaviour: "decrement_obeying_policy",
  };
  if (currency) order.currency = String(currency).toUpperCase();
  const ship = cleanAddress(shipping);
  const bill = cleanAddress(billing);
  if (ship) order.shipping_address = ship;
  if (bill) order.billing_address = bill;

  const r = await fetch(
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
  const j = await r.json();
  if (!r.ok) throw new Error("Shopify order create failed: " + JSON.stringify(j));
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
        const claimKey = `claim:${session.id}`;

        // Idempotency gate BEFORE any side effect. Redis error ≠ duplicate:
        // return 5xx so Stripe retries (it retries failed deliveries for days).
        const claim = await kvClaim(claimKey);
        if (claim === "error") return res.status(500).json({ error: "lock unavailable, retry" });
        if (claim === "dup") {
          console.log("Duplicate webhook delivery ignored for", session.id);
          return res.status(200).json({ received: true, duplicate: true });
        }

        let cart;
        try { cart = await kvGet(key); }
        catch (e) { await kvRelease(claimKey); console.error("Upstash read failed", e); return res.status(500).json({ error: "cart read failed, retry" }); }

        if (!cart) {
          // Cart truly missing (expired >24h or never stored) — retrying won't help.
          await kvRelease(claimKey);
          console.error("Cart not found in Upstash for", key);
          return res.status(200).json({ received: true });
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

        // Integrity tripwire: cart total (what we charge as line items) vs the
        // amount Stripe actually charged (signed event). Logged, not blocking.
        const cartTotal = (cart.items || []).reduce((s, it) => s + (Number(it.price_cents) || 0) * (Number(it.quantity) || 1), 0);
        if (session.amount_total != null && Math.abs(cartTotal - session.amount_total) > Math.max(2, session.amount_total * 0.01)) {
          console.error(`AMOUNT MISMATCH for ${session.id}: stripe=${session.amount_total} cart=${cartTotal} ${session.currency}`);
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
          });
        } catch (e) {
          // Release the claim so Stripe's retry can create the order later
          // (transient Shopify errors recover instead of losing the order).
          await kvRelease(claimKey);
          console.error("Shopify order create failed — returning 500 so Stripe retries:", e);
          return res.status(500).json({ error: "order create failed, retry" });
        }

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

        try { await kvDel(key); } catch (e) { console.error("cart cleanup failed for", key); }
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    // Unexpected failure: let Stripe retry rather than acknowledging a loss.
    console.error("Unexpected webhook error:", e);
    return res.status(500).json({ error: "unexpected error, retry" });
  }
}

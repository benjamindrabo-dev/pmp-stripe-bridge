// POST /api/stripe-webhook
// Stripe calls this after checkout. On checkout.session.completed (paid) we
// create the matching order in Shopify (marked paid) so inventory + emails fire.
//
// IMPORTANT: bodyParser must be OFF so we can verify the raw-body signature.
export const config = { api: { bodyParser: false } };

import crypto from "crypto";

const SHOPIFY_API = "2025-01";

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
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto
    .createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${t}.${raw}`)
    .digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) return false;
  } catch {
    return false;
  }
  // Reject events older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  return true;
}

async function kvGet(key) {
  const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}
async function kvDel(key) {
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
}

async function createShopifyOrder({ items, email, phone, shipping, note }) {
  const order = {
    line_items: items.map((it) => ({ variant_id: Number(it.variant_id), quantity: Number(it.quantity) })),
    financial_status: "paid",
    email: email || undefined,
    phone: phone || undefined,
    note: `Paid via Stripe. ${note || ""}`.trim(),
    tags: "stripe",
    send_receipt: true,
    send_fulfillment_receipt: false,
    inventory_behaviour: "decrement_obeying_policy",
  };
  if (shipping && shipping.address1) {
    order.shipping_address = {
      name: shipping.name || undefined,
      address1: shipping.address1,
      address2: shipping.address2 || undefined,
      city: shipping.city || undefined,
      province: shipping.province || undefined,
      country: shipping.country || undefined,
      zip: shipping.zip || undefined,
      phone: shipping.phone || undefined,
    };
  }
  const payload = { order };
  const r = await fetch(
    `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API}/orders.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status === "paid") {
        const key = `sess:${session.id}`;
        const cart = await kvGet(key);
        if (cart) {
          const cd = session.customer_details || {};
          const sd = session.shipping_details || {};
          const addr = sd.address || cd.address || {};
          const shipping = {
            name: sd.name || cd.name,
            address1: addr.line1,
            address2: addr.line2,
            city: addr.city,
            province: addr.state,
            country: addr.country,
            zip: addr.postal_code,
            phone: cd.phone,
          };
          await createShopifyOrder({ items: cart.items, email: cd.email, phone: cd.phone, shipping, note: cart.note });
          await kvDel(key); // idempotency: only create once
        }
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ received: false }); // inspect logs; avoid infinite retries
  }
}

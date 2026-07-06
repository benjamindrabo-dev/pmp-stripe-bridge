// POST /api/create-checkout
// Called from the Shopify "Pay with Card (Stripe)" button.
// Body: { items: [{ variant_id, title, quantity, price_cents }], note? }
// Creates a Stripe Checkout Session and stores the cart so the webhook
// can rebuild the Shopify order after payment.

const CURRENCY = (process.env.CURRENCY || "cad").toLowerCase();

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.STORE_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Minimal Upstash Redis REST helper (no npm deps).
async function kvSet(key, value) {
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}?EX=86400`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify(value),
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { items, note } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Empty cart" });
    }

    // Stripe expects form-encoded params.
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", (process.env.SUCCESS_URL || "https://example.com/thank-you") + "?session_id={CHECKOUT_SESSION_ID}");
    params.append("cancel_url", process.env.CANCEL_URL || (process.env.STORE_ORIGIN || "https://example.com") + "/cart");
    params.append("billing_address_collection", "auto");
    // Collect a shipping address (adjust country list as needed).
    params.append("shipping_address_collection[allowed_countries][0]", "CA");
    params.append("shipping_address_collection[allowed_countries][1]", "US");

    items.forEach((it, i) => {
      params.append(`line_items[${i}][price_data][currency]`, CURRENCY);
      params.append(`line_items[${i}][price_data][product_data][name]`, String(it.title || "Item").slice(0, 250));
      params.append(`line_items[${i}][price_data][unit_amount]`, String(Number(it.price_cents)));
      params.append(`line_items[${i}][quantity]`, String(Number(it.quantity) || 1));
    });

    // Optional flat shipping (in cents), e.g. FLAT_SHIPPING_CENTS=699
    const shipping = Number(process.env.FLAT_SHIPPING_CENTS || 0);
    if (shipping > 0) {
      const i = items.length;
      params.append(`line_items[${i}][price_data][currency]`, CURRENCY);
      params.append(`line_items[${i}][price_data][product_data][name]`, "Shipping");
      params.append(`line_items[${i}][price_data][unit_amount]`, String(shipping));
      params.append(`line_items[${i}][quantity]`, "1");
    }

    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Stripe error", data);
      return res.status(502).json({ error: "Stripe create session failed", detail: data.error });
    }

    // Store the Shopify line items keyed by the Stripe session id.
    await kvSet(`sess:${data.id}`, {
      items: items.map((it) => ({ variant_id: it.variant_id, quantity: it.quantity })),
      note: note || "",
    });

    return res.status(200).json({ url: data.url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}

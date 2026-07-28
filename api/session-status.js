// GET /api/session-status?session_id=cs_xxx
// Read-only helper for the thank-you page: returns the REAL paid amount +
// currency from the Stripe Checkout Session so the storefront can fire ad
// conversion events (Meta / Google / TikTok "Purchase"). No secrets leak — only
// the amount, currency, paid flag and email are returned.

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.STORE_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const id = (req.query && req.query.session_id) || "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Bad session_id" });

  try {
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id), {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const s = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: "Stripe retrieve failed", detail: s.error });
    }
    return res.status(200).json({
      status: s.status,                                  // "complete" | "open" | "expired"
      paid: s.payment_status === "paid",                 // only fire events when true
      amount: s.amount_total,                            // in the smallest currency unit (cents)
      currency: String(s.currency || "").toUpperCase(),  // e.g. "USD", "GBP", "CAD"
      email: (s.customer_details && s.customer_details.email) || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", detail: String(e.message || e) });
  }
}

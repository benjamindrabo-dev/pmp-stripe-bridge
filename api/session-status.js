// GET /api/session-status?session_id=cs_xxx
// Read-only helper for the custom thank-you page. It returns the signed Stripe
// payment state, amount and currency so browser ad tags only fire after payment.
// For requests coming from the configured storefront, it can also return
// normalized SHA-256 identifiers for Google Ads enhanced conversions. Raw
// customer identifiers are never returned.

import crypto from "crypto";

function cors(req, res) {
  const configuredOrigin = process.env.STORE_ORIGIN || "https://www.puremajestypet.com";
  const requestOrigin = String(req.headers.origin || "");
  if (requestOrigin === configuredOrigin) {
    res.setHeader("Access-Control-Allow-Origin", configuredOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, private");
}

function requestIsFromStore(req) {
  const configuredOrigin = process.env.STORE_ORIGIN || "https://www.puremajestypet.com";
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");
  return origin === configuredOrigin || referer === configuredOrigin || referer.startsWith(configuredOrigin + "/");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(value) {
  const clean = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  const at = clean.lastIndexOf("@");
  if (at <= 0 || at === clean.length - 1) return null;
  let local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") local = local.replace(/\./g, "");
  return local && domain ? `${local}@${domain}` : null;
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw.startsWith("+")) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

function googleUserData(session) {
  const details = session && session.customer_details || {};
  const data = {};
  const email = normalizeEmail(details.email || session.customer_email);
  const phone = normalizePhone(details.phone);
  if (email) data.sha256_email_address = sha256(email);
  if (phone) data.sha256_phone_number = sha256(phone);
  return Object.keys(data).length ? data : null;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const id = (req.query && req.query.session_id) || "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "Bad session_id" });

  try {
    const response = await fetch("https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(id), {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    const session = await response.json();
    if (!response.ok) {
      return res.status(502).json({ error: "Stripe retrieve failed", detail: session.error });
    }

    const paid = session.payment_status === "paid";
    const payload = {
      status: session.status,
      paid,
      amount: session.amount_total,
      currency: String(session.currency || "").toUpperCase(),
      sessionId: session.id,
    };

    if (paid && requestIsFromStore(req)) {
      const userData = googleUserData(session);
      if (userData) payload.google_user_data = userData;
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error", detail: String(error.message || error) });
  }
}

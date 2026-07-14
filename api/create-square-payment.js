/**
 * PMP Square Bridge — Vercel serverless function (Cowork, 2026-07-13)
 * POST /api/create-square-payment
 *
 * Reçoit { sourceId, currency, email, items:[{variant_id, quantity}] } depuis
 * le snippet pmp-square-bridge.liquid, puis :
 *   1. Recalcule le total CÔTÉ SERVEUR depuis les prix Shopify (jamais confiance au client).
 *   2. Crée le paiement Square (Payments API) avec le token de carte (sourceId).
 *   3. Si payé : crée la commande Shopify marquée payée (tag "square").
 *
 * Variables d'environnement (projet Vercel pmp-stripe-bridge — on réutilise l'existant) :
 *   SQUARE_ACCESS_TOKEN   — console Square > PMP Checkout > Credentials (Sandbox OU Production) [SEUL secret à ajouter]
 *   SQUARE_ENV            — "sandbox" ou "production"
 *   SQUARE_LOCATION_ID    — sandbox: LRA3C4F29P7QE / production: L560C6EGG7CSV
 *   SHOPIFY_STORE_DOMAIN  — DÉJÀ CONFIGURÉE (même variable que le pont Stripe)
 *   SHOPIFY_ADMIN_TOKEN   — DÉJÀ CONFIGURÉE (même variable que le pont Stripe)
 *
 * Aucun secret n'est jamais exposé au navigateur : ils vivent uniquement ici.
 */

const ALLOWED_ORIGINS = [
  "https://www.puremajestypet.com",
  "https://puremajestypet.com",
];

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const {
    SQUARE_ACCESS_TOKEN,
    SQUARE_ENV = "sandbox",
    SQUARE_LOCATION_ID,
    SHOPIFY_STORE_DOMAIN,
    SHOPIFY_SHOP,
    SHOPIFY_ADMIN_TOKEN,
  } = process.env;
  const SHOP = SHOPIFY_STORE_DOMAIN || SHOPIFY_SHOP;

  if (!SQUARE_ACCESS_TOKEN || !SQUARE_LOCATION_ID || !SHOP || !SHOPIFY_ADMIN_TOKEN) {
    return res.status(500).json({ error: "Middleware not configured (missing env vars)." });
  }

  const squareBase = SQUARE_ENV === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

  try {
    const { sourceId, currency = "USD", email = "", items = [] } = req.body || {};
    if (!sourceId) return res.status(400).json({ error: "Missing card token (sourceId)." });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty." });

    /* ---- 1. Recalcule le total depuis Shopify (prix serveur, pas client) ---- */
    let totalCents = 0;
    const lineItems = [];
    for (const it of items) {
      const vid = parseInt(it.variant_id, 10);
      const qty = Math.max(1, parseInt(it.quantity, 10) || 1);
      if (!vid) continue;
      const vRes = await fetch(
        `https://${SHOP}/admin/api/2024-10/variants/${vid}.json`,
        { headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN } }
      );
      if (!vRes.ok) return res.status(400).json({ error: `Unknown product variant ${vid}.` });
      const { variant } = await vRes.json();
      totalCents += Math.round(parseFloat(variant.price) * 100) * qty;
      lineItems.push({ variant_id: vid, quantity: qty });
    }
    if (totalCents < 50) return res.status(400).json({ error: "Order total is too low." });

    /* ---- 2. Paiement Square ---- */
    const idempotencyKey = `pmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const payRes = await fetch(`${squareBase}/v2/payments`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Square-Version": "2025-01-23",
      },
      body: JSON.stringify({
        source_id: sourceId,
        idempotency_key: idempotencyKey,
        location_id: SQUARE_LOCATION_ID,
        amount_money: { amount: totalCents, currency },
        buyer_email_address: email || undefined,
        note: "Pure Majesty Pets — online order",
      }),
    });
    const payData = await payRes.json();
    if (!payRes.ok || !payData.payment || payData.payment.status !== "COMPLETED") {
      const detail = payData.errors && payData.errors[0] && payData.errors[0].detail;
      return res.status(402).json({ error: detail || "Square payment was declined." });
    }
    const paymentId = payData.payment.id;

    /* ---- 3. Commande Shopify marquée payée ---- */
    const orderRes = await fetch(
      `https://${SHOP}/admin/api/2024-10/orders.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order: {
            email: email || undefined,
            line_items: lineItems,
            financial_status: "paid",
            currency,
            tags: "square",
            note: `Paid via Square (${SQUARE_ENV}). Payment ID: ${paymentId}`,
            transactions: [
              { kind: "sale", status: "success", amount: (totalCents / 100).toFixed(2), gateway: "Square" },
            ],
            inventory_behaviour: "decrement_obeying_policy",
            send_receipt: true,
          },
        }),
      }
    );
    const orderData = await orderRes.json();
    if (!orderRes.ok || !orderData.order) {
      // Paiement pris mais commande non créée : à réconcilier à la main.
      return res.status(200).json({
        paymentId,
        warning: "Payment captured but Shopify order creation failed — create it manually.",
        shopifyError: orderData.errors || null,
      });
    }

    return res.status(200).json({
      paymentId,
      orderId: orderData.order.id,
      orderName: orderData.order.name,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Unexpected middleware error." });
  }
};

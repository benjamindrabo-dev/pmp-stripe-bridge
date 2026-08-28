# Stripe ↔ Shopify checkout bridge (Route 2)

A "Pay with Card" flow using **Stripe Checkout** for a Shopify store, since Stripe
is not selectable as a native Shopify gateway in Canada. It builds a Stripe
Checkout Session from the live cart, then rebuilds the paid order in Shopify.

```
Shopify cart ──(button)──> /api/create-checkout ──> Stripe Checkout (hosted) ──> customer pays
                                                                                     │
                                                                                     ▼
Shopify order (paid, inventory decremented) <── /api/stripe-webhook <── checkout.session.completed
```

## Files
- `api/create-checkout.js` — creates the Stripe Checkout Session.
- `api/stripe-webhook.js` — on paid session, creates the Shopify order.
- `api/recover-checkout.js` — rebuilds an abandoned cart across devices from an opaque Stripe Session ID.
- `lib/omnisend.js` — emits the standard Omnisend `started checkout` event when its API key is configured.
- `shopify-snippet-pay-with-stripe.liquid` — the storefront button.
- `.env.example` — every secret/config value.

## Prerequisites
1. **Stripe** (dashboard.stripe.com): Secret key (`sk_test_…` then `sk_live_…`) and, after step 4, a **Webhook signing secret** (`whsec_…`).
2. **Shopify custom app** (Admin → Settings → Apps → *Develop apps*): scopes `write_orders`, `read_products` → **Admin API access token**.
3. **Upstash Redis** (free): REST URL + REST Token.
4. **Vercel** (free): hosts the two functions.

## Deploy (~15 min)
1. Put this folder in a GitHub repo and **Import** in Vercel (or `npx vercel`).
2. Vercel → Project → **Settings → Environment Variables** → add all keys from `.env.example`.
3. Deploy. Note the URL, e.g. `https://your-app.vercel.app`.
4. **Stripe → Developers → Webhooks → Add endpoint**: URL `https://your-app.vercel.app/api/stripe-webhook`, event `checkout.session.completed`. Copy the **Signing secret** into `STRIPE_WEBHOOK_SECRET`. Redeploy.
5. Paste `shopify-snippet-pay-with-stripe.liquid` into your theme; set `MIDDLEWARE_URL` to `https://your-app.vercel.app/api/create-checkout`.

## Checkout correlation and Omnisend

The storefront should send `email`, `shopify_cart_token`, and
`shopify_cart_url` with the cart. The bridge stores the normalized cart token
on both the Checkout Session and its PaymentIntent, and copies it onto the paid
Shopify order. This distinguishes three different states during an audit:

- Checkout Session exists: the Stripe bridge opened.
- PaymentIntent exists: the shopper submitted a payment method.
- `payment_status=paid`: payment succeeded.

Set `OMNISEND_API_KEY` (scope `events.write`) to send `started checkout`
server-side. If it is absent, the storefront can push the same deterministic
event through Omnisend's browser snippet. Paid purchases continue through the
Shopify order sync; do not also send `placed order` directly unless that sync is
disabled, because duplicate real-time order events can trigger duplicate flows.

## Test before going live
- Use `sk_test_…` and Stripe test card `4242 4242 4242 4242`, place an order, confirm a **paid** Shopify order appears with correct items + inventory decremented.
- Switch to `sk_live_…`, update the webhook secret for the live endpoint, do one small real order.

## Known limitations
- **Bypasses Shopify's native checkout.** Shopify does not verify external gateways; on an account already under a risk action this can add account risk.
- **Shipping/tax:** Stripe collects a shipping address; amounts here are cart prices + optional flat shipping. For real tax, enable **Stripe Tax** (`automatic_tax[enabled]=true`) and add tax registration.
- **Discount codes** in Shopify are not applied. (Stripe promo codes can be enabled separately.)
- **Refunds/disputes** are handled in the Stripe dashboard.

## Honest note
Stripe is more risk-averse than high-risk acquirers. Shopify Payments **is** Stripe under the hood — the same 4.48% chargeback rate that got you removed can get a direct Stripe account frozen too. This buys time; clearing the 186 unfulfilled orders and refunding the oldest is what actually protects any processor you use.
```
```

<!-- redeploy marker: 2026-08-08 google-mcp-env -->

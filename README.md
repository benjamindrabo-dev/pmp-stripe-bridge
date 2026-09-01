# Stripe ↔ Shopify checkout bridge (Route 2)

A "Pay with Card" flow using **Stripe Checkout** for a Shopify store, since Stripe
is not selectable as a native Shopify gateway in Canada. It builds a Stripe
Checkout Session from the live cart, then rebuilds the paid order in Shopify.

```
Shopify cart ──(button)──> /api/create-checkout ──> Stripe Embedded Checkout ──> customer pays
                                                                                     │
                                                                                     ▼
Shopify order (paid, inventory decremented) <── /api/stripe-webhook <── checkout.session.completed
```

## Files
- `api/create-checkout.js` — creates the Stripe Checkout Session.
- `api/stripe-webhook.js` — on paid session, creates the Shopify order.
- `api/recover-checkout.js` — rebuilds an abandoned cart across devices from an opaque Stripe Session ID.
- `api/meta-offer-summary.js` — live Shopify ScriptTag that enriches checkout requests and tracks their successful/failed bridge responses.
- `lib/omnisend.js` — emits the standard Omnisend `started checkout` event when its API key is configured.
- `public/pmp-checkout-events.js` — sends an idempotent browser-side GA4/Clarity `begin_checkout` after Embedded Checkout mounts and reports Clarity `checkout_error` events.
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
5. Upload `public/pmp-checkout-events.js` to Shopify theme assets. Paste `shopify-snippet-pay-with-stripe.liquid` into your theme and set `MIDDLEWARE_URL` and `STRIPE_PUBLISHABLE_KEY`.

## Browser funnel events

`/api/create-checkout` returns the validated charge currency, checkout value,
line items, and a deterministic event ID in `analytics.beginCheckout`. The live
ScriptTag emits GA4 `begin_checkout` to `G-KKS5T7SPHR` after a successful
Checkout Session response. This means that Stripe accepted and created the
checkout; it does not mean that payment has succeeded. The standalone example
waits until Stripe Embedded Checkout mounts. Both use the same event/session keys, so a memory +
`sessionStorage` guard prevents the same Stripe session from being counted
twice across callbacks, integrations, or page reloads. The same successful
transition emits a Clarity `begin_checkout`; endpoint or mount failures emit
Clarity `checkout_error` with low-cardinality stage/code tags and no error
message or customer data. The live ScriptTag also drops the theme's legacy
`begin_checkout` call only when it has neither `event_id` nor `items`; complete
bridge events and every other Google tag call pass through unchanged.

Successful Shopify `POST /cart/add.js` and `POST /cart/add` responses emit a
Clarity `add_to_cart`. No additional GA4 `add_to_cart` is sent because Shopify's
pixel already owns that event; duplicating it here would inflate the funnel.

## Acquisition attribution (90 days, consent-aware)

The live ScriptTag keeps up to three independent browser records for at most 90
days. They are not three competing versions of the same source:

- **First entry** — the first page, referrer, source, medium, campaign, and time
  observed by this version of the tracker. It is set once, even when that first
  visit is direct.
- **First free touch** — the first identifiable non-paid acquisition, such as
  organic search, a Google free listing, a referral, a tagged Instagram DM, or
  a tagged profile link. It is set once and is not replaced by later free or
  direct visits.
- **Last paid touch** — the newest visit that contains reliable evidence of a
  paid click. A newer paid click replaces the older paid touch.

At checkout, the primary order attribution model is
`last_paid_else_first_free_v1`: use the latest paid touch when one exists;
otherwise use the first free touch. If neither exists, the current session is
the fallback. A later direct return does not overwrite an earlier identified
source. The tracker also re-reads the shared record immediately before checkout
so a newer paid visit captured in another tab is not missed.

Paid classification is deliberately strict. `gclid`, `gbraid`, `wbraid`,
`msclkid`, `ttclid`, or an explicitly paid medium such as `cpc`, `ppc`,
`paid_search`, or `paid_social` are paid evidence. `fbclid` and `_fbc` identify
a Facebook/Instagram click but, on their own, do **not** prove that the click
was an ad. For Meta ads, keep an explicit paid medium in the destination URL.

Examples of tagged destination links (append the parameters to the real product
URL):

- Meta ad: `?utm_source=meta&utm_medium=paid_social&utm_campaign=yeast_sales`
- Instagram DM: `?utm_source=instagram&utm_medium=dm&utm_campaign=customer_dm`
- Instagram profile: `?utm_source=instagram&utm_medium=organic_social&utm_campaign=profile`

Add `utm_content=person_name` to a DM link when the report must distinguish the
person or account that shared it. This only identifies a person when the shopper
actually clicks that specific tagged link.

For continuity with earlier deployments, unexpired legacy records are read as a
fallback. A legacy visit is migrated only when it can be classified clearly:
paid evidence can seed the last paid touch, while a clearly free visit can seed
the first free touch. Legacy last-touch data does not invent a historical first
entry, and a stored legacy landing URL is not replayed as if it were a new paid
visit. The literal first-entry record therefore starts with the first page seen
by this tracker version.

The Shopify Customer Privacy API is checked when it is available. If it does
not affirmatively allow tracking, the ScriptTag does not read or write these
attribution records and does not inject advertising or analytics identifiers
into the checkout request. A consent change to allowed is re-evaluated at
checkout. See Shopify's [Customer Privacy API](https://shopify.dev/docs/api/customer-privacy).

The chosen attribution and the raw records are carried through Stripe and into
the Shopify order as a readable acquisition note plus machine-readable
`attribution_*`, `first_entry_*`, `first_touch_*`/`first_free_*`, and
`last_touch_*`/`last_paid_*` fields for reporting.

These records have unavoidable limits:

- They follow the same browser profile and device; they cannot automatically
  join a phone visit to a later desktop purchase.
- Clearing storage, private browsing, browser restrictions, expiry, or denied
  consent can remove or prevent continuity.
- An unclicked Instagram/Facebook impression, an untagged DM, a manually typed
  URL, or a later Google brand search cannot be connected honestly to the
  earlier social exposure.
- The new records improve future orders. They cannot reconstruct a first touch
  that was never captured for a historical order.

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

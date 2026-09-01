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
- `api/meta-offer-summary.js` — Vercel-served storefront helper, currently loaded by a Shopify theme section, that captures transition attribution, enriches checkout requests, and tracks bridge responses.
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
line items, and a deterministic event ID in `analytics.beginCheckout`. The
theme-loaded storefront helper emits GA4 `begin_checkout` to `G-KKS5T7SPHR`
after a successful
Checkout Session response. This means that Stripe accepted and created the
checkout; it does not mean that payment has succeeded. The standalone example
waits until Stripe Embedded Checkout mounts. Both use the same event/session keys, so a memory +
`sessionStorage` guard prevents the same Stripe session from being counted
twice across callbacks, integrations, or page reloads. The same successful
transition emits a Clarity `begin_checkout`; endpoint or mount failures emit
Clarity `checkout_error` with low-cardinality stage/code tags and no error
message or customer data. The storefront helper also drops the theme's legacy
`begin_checkout` call only when it has neither `event_id` nor `items`; complete
bridge events and every other Google tag call pass through unchanged.

Successful Shopify `POST /cart/add.js` and `POST /cart/add` responses emit a
Clarity `add_to_cart`. No additional GA4 `add_to_cart` is sent because Shopify's
pixel already owns that event; duplicating it here would inflate the funnel.

## Acquisition attribution (native Shopify Custom Pixel, 90 days)

The permanent owner is the Shopify Custom Pixel **PMP Paid Attribution**, whose
paste-ready source is `shopify/pmp-paid-attribution.custom-pixel.js`. Install it
once in **Settings → Customer events → Add custom pixel**, connect it, and test
it before disconnecting the old theme capture. It stores schema version 3 under
the sole canonical key `pmp:attribution`; publishing a theme cannot remove the
pixel because Customer Events configuration belongs to the shop.

The pixel recognizes `gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `msclkid`,
`ttclid`, and `sccid`. Under this shop's explicit contract, any one of those
eight identifiers is a paid click. An explicitly paid UTM medium such as `cpc`
or `paid_social` is also retained when a platform supplies no click ID. A newer
paid touch replaces `lastPaid` and starts a new 90-day window. The pixel also
keeps the earliest identifiable unpaid acquisition in `firstFree`. Direct or
organic navigation, including Shopify Markets paths such as `/en-ca/`, never
clears or renews an active paid click. Events are serialized within each pixel
runtime; because Shopify's asynchronous storage API has no compare-and-swap,
bounded re-read/repair rounds also make simultaneous tabs converge on the newest
dated click on a best-effort basis. Storage dates are Unix milliseconds.
The sole public state contract remains `pmp:attribution`. Small immutable
`pmp:attribution:paid:<event-id>` journal entries prevent a genuinely concurrent
tab from destroying a paid click; the pixel removes them after their 90-day TTL,
retains at most the 64 newest active entries, and lets the checkout bridge repair
a briefly stale canonical state.

Persistent URLs retain only validated click IDs and the five explicit `utm_*`
fields. Arbitrary query parameters, fragments, credentials, email-like values
and sensitive checkout/account/order paths are removed before storage. A direct
journey with no paid click rotates after 90 days; an active paid journey rotates
when its own 90-day paid window expires.

Before capture, the pixel checks `pmp_paid_attribution_v3` and
`pmp:attribution:v1`. It imports each new or changed legacy record once, selects
the newest reliably dated paid click, never lets an empty record win, and leaves
both legacy keys intact. This also recovers valid clicks written during a
temporary rollback. An undated legacy click is retained with
`dateUncertain: true` and `expiresAt: 0`: it remains auditable but is not silently
granted a new 90-day validity period. Expired dated paid records are removed
from the canonical state on the next pixel event. Migration is idempotent.

Shopify custom pixels run in a sandbox. Their official `browser.localStorage`
API is asynchronous, and pixels can subscribe to `checkout_started` and
`checkout_completed`; they do not have storefront DOM access and should not be
assumed able to mutate Ajax cart attributes. This code adds no consent popup or
visitor interaction; it runs automatically whenever Shopify executes the
connected pixel. See Shopify's
[custom pixel API](https://shopify.dev/docs/api/web-pixels-api/standard-api/browser) and
[standard events](https://shopify.dev/docs/api/web-pixels-api/standard-events).

This shop uses **external Stripe Embedded Checkout**, not native Shopify
checkout. Therefore no cart-attribute theme bridge is needed. Until the Custom
Pixel can be connected, `api/meta-offer-summary.js` is a transitional schema-v3
writer identified by `writer: "pmp-storefront-fallback-v3"`. It runs on page
load, migrates the two legacy keys without deleting them, and applies the same
last-paid-click 90-day rule. Direct, email, organic, referral and Markets-path
visits do not replace or renew `lastPaid`. It also reads the canonical state
immediately before `/api/create-checkout`. The request carries `journey_id`, the active
click IDs, and capture time into Stripe Session metadata and Redis. The Stripe
webhook then creates the Shopify order
and writes `pmp_journey_id` plus platform click identifiers into its note
attributes. This provides a deterministic pixel → Stripe Session → Shopify
order join without a third-party app once the canonical pixel state exists.
The helper writes the immutable paid journal before the canonical record, scans
the complete browser keyspace, resolves equal timestamps by event ID, and merges
same-journey `firstEntry`/`firstFree` context. Existing session/event guards
prevent duplicate checkout analytics.

This fallback is **not theme-independent**: live-store inspection found its
`<script>` loader inside a Shopify theme section. The JavaScript file survives a
Vercel deployment, but a newly published theme must still include that section.
The connected Custom Pixel remains the no-app durable solution because Customer
Events configuration belongs to the shop rather than to a theme.

### Deployment and rollback

1. Deploy this bridge revision and confirm the production deployment is Ready.
   Keep the existing theme section enabled during this step. Its transitional
   writer prevents an attribution gap before step 2.
2. Paste the pixel source with the exact name **PMP Paid Attribution**, save,
   connect, and verify the fake-ID scenarios in Shopify Pixel Helper/browser
   storage. Then confirm a Stripe **test-mode** Session and test Shopify order
   share `journey_id`/`pmp_journey_id`. Do not place a paid order.
3. Neutralize the attribution section of `pmp-uniform-hotfix.js` in the source
   theme (retain its unrelated functions). After the Custom Pixel is verified,
   remove the transitional writer from this helper in a separate bridge revision;
   its checkout enrichment must remain.
4. Roll back the Custom Pixel phase by disconnecting **PMP Paid Attribution**
   while leaving this fallback deployed. Do not delete `pmp:attribution` or
   either legacy key; reconnecting the pixel imports every still-valid legacy
   record that changed while it was off.

Remaining limits are browser/device continuity, storage clearing/private mode,
Shopify privacy enforcement, the theme-section dependency of the temporary
fallback, and the manual Shopify Admin installation step. Repository
code cannot inspect the shop's configured app pixels/app embeds or connect a
Custom Pixel without authenticated Admin access; audit those panels and browser
storage/network listeners separately before retiring an unknown writer.
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

# GoDaddy embedded checkout — status, 10 September 2026

## Delivered and deployed

A branded Pure Majesty Pets checkout page is deployed on the GoDaddy preparation branch, not on the live storefront route. It includes contact and delivery sections, order summary, bundle gift and discount lines, an embedded GoDaddy Collect card-form integration, English/French text and responsive layouts.

Page: `/godaddy-checkout.html?lang=fr` (English: `?lang=en`). With no checkout session, the page explicitly displays a demonstration order with illustrative prices and disables contact entry, card interaction and payment submission. These amounts are not a published offer.

Verified Vercel deployment: `dpl_d9XSYKQmUWBKE652jqARFRybcLP8`, commit `d262eafadb40bbeba8ba01be0099669aaf55968b`, READY. Host: `pmp-stripe-bridge-pl6nq1x3o-pet-vault.vercel.app`. Branch alias: `pmp-stripe-bridge-git-prep-godaddy-payments-20260909-pet-vault.vercel.app`.

This is a protected Preview deployment. An HTTP fetch through the connector redirected to Vercel authentication; deployment success alone does not verify the rendered live GoDaddy iframe or a complete checkout.

## Real merchant verification

At 2026-09-10T12:38:04.577Z, the isolated Preview diagnostic authenticated successfully (POST token: HTTP 200) and listed the merchant stores (GET stores: HTTP 200). One store was returned, matching the supplied business, with currency CAD and status ACTIVE. This resolved the previously missing Store ID. Storage and Shopify credential presence were also confirmed without printing their values.

Evidence: build logs of deployment `dpl_CYt3jRJq2v6uMvdz4Qm7AZJQatRr`, `GODADDY_STORE_DISCOVERY` output. No payment, link or payout was created. ACTIVE is not evidence that the risk review or instant payouts are approved.

The verified Store ID and CAD currency are recorded in the preparation branch's deployment configuration. The private key remains in Vercel Preview. The temporary network diagnostic build command has been removed.

## Code prepared

- `lib/godaddy-embedded-core.js`: disabled-by-default launch checks, amount and address validation, captured-transaction checks, permanent attempt reservation after an uncertain charge, and duplicate-order protection.
- `lib/godaddy-embedded.js`: server quote builder, GoDaddy nonce-charge adapter, server transaction verification and Shopify order writer, consent-aware analytics hooks. Real monetary writes are disabled in Preview and require additional production gates.
- `api/godaddy-checkout.js`: quote/status, preparation, nonce submission and discount actions for an existing GoDaddy session.
- `api/godaddy-webhook.js`: raw-body signature verification and durable notification queue; not registered with GoDaddy.
- `api/godaddy-reconcile.js`: authenticated reconciliation worker; not scheduled.
- `public/godaddy-checkout.html` and `public/godaddy-checkout.js`: branded page and official Collect integration. The completed-order rendering bug was fixed before the verified deployment.

## Tests actually performed

Local Node tests: 95 passed, 0 failed (44 existing Pay Links adapter tests and 51 new embedded-core tests), using synthetic fixtures and mocked payment/storage operations. The 51-test source remains in the working container; its attempted GitHub upload was blocked and is not present in the branch.

Chromium in-memory DOM checks: 12 passed, 0 failed. Covered English/French at widths 390, 768 and 1440, disabled demo submission, a synthetic payment flow, completed-order reload, disabled account, unavailable SDK, expired checkout and safe text rendering of product titles. These checks used a mocked SDK and API, no navigation to a real payment page, no real card and no network payment.

Static in-memory layout rendering at 390, 768 and 1440 showed no horizontal overflow. These are offline visual checks, not a successful live iframe or account payment test.

## Not yet delivered / blockers

1. The shared server-validated cart entrypoint and storefront provider switch are NOT wired to the new module. The attempted installer write was blocked by the tool and was not retried. No existing checkout routing was changed.
2. Production credential availability, webhook registration/signature delivery, the reconciliation schedule, taxes/shipping rules and the actual merchant's charge permissions remain to be validated.
3. A complete authorized end-to-end test (real or provider-approved sandbox), including the GoDaddy frame, capture, Shopify order, notifications, stock and attribution, has NOT been executed.
4. GoDaddy review approval has not been verified in this work. Production activation flags remain off. No live payment, refund or payout has been executed.

The page is available for design review, but it must not be described as a completed or live-sales migration. Existing Stripe/Square checkout and main-branch routing remain unchanged.

## Official implementation references

- https://docs.poynt.com/app-integration/poynt-collect/getting-started/
- https://docs.poynt.com/app-integration/poynt-collect/getting-started/nonce.html
- https://docs.poynt.com/app-integration/cloudApps/webhooks.html

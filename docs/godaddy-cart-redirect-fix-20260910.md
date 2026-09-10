# Cart-to-GoDaddy redirect fix — 10 September 2026

The merchant reported that Buy Now remained on /cart. Production logs showed HTTP 400 responses from /api/create-checkout. The merchant's exact browser cart/cookies were not accessed; the cause in that particular session is not asserted.

## Reproduced defect
An anonymous US cart containing one collagen and Shopify-applied WELCOME20 had a merchandise total of USD 25.60 (3199 cents minus Shopify's 639-cent discount). Before the correction, the actual production bridge returned HTTP 400 / SHOPIFY_CART_TOTAL_CHANGED. Bundle-only carts in the same diagnostic passed. Evidence: GitHub Actions run 34506702872, job 102970544695, GODADDY_PROPERTY_DIAGNOSTIC, 2026-09-10T17:11:48Z–17:12:02Z.

The handoff discarded discount identifiers; server verification rebuilt the merchandise without reapplying the existing Shopify code. It correctly rejected the resulting unequal total, but could not process that legitimate discounted cart.

## Published correction
The browser helper and compact cart now preserve bounded discount identifiers and bundle properties. The verification cart reapplies codes through Shopify before exact currency, line and total checks. Those checks remain mandatory. The entrypoint does not apply a requested promotion a second time when the source cart already includes it. An older-helper URL compatibility correction retains its original trusted host/path, and optional analytics errors can no longer block a valid redirect. No payment account, card, bank, or secret was changed.

## Actual browser verification after publication
GitHub Actions run 34507512173, job 102973228166, artifact 10164452152; measured from 2026-09-10T17:20:08.820Z to 17:20:42.627Z. Real anonymous Shopify carts, actual native Buy Now button, actual production HTTP endpoint and GoDaddy SDK; no cart or SDK mock.

- US collagen with Shopify-applied WELCOME20: HTTP 200, processor godaddy, navigation to /godaddy-checkout.html, USD 25.60 in both cart and checkout, zero amount difference, payment button enabled, notice Will be charged in CAD.
- US collagen without a promotion: HTTP 200, same GoDaddy navigation, USD 31.99 in both cart and checkout, zero difference, payment button enabled.
- Canadian five-unit bundle with attempted WELCOME20: Shopify did not apply a code discount (13500 CAD cents, discount 0). The test stopped at DISCOUNT_NOT_PRESENT before clicking Buy Now. This third scenario did NOT pass and is not evidence of successful checkout with that promotion. The overall three-case workflow result is therefore false; two cases passed.

The production health check at 2026-09-10T17:20:35Z returned HTTP 200, launchEnabled true, newCheckoutRouting godaddy, API access and stored webhook configuration verified. Provider review and payout availability were not verified by these checks.

No card data was entered, no monetary request was submitted, and no Shopify order was created. Existing open browser tabs must reload the helper to receive the corrected discount handoff. These results validate the reproduced discounted-cart redirect, not every cart or the final financial transaction.

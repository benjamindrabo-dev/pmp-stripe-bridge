# GoDaddy express checkout — 11 September 2026

Apple Pay and Google Pay are connected through the official GoDaddy Collect SDK, in the Express checkout block before the email field. Existing card processing stays below. Wallet tokens use the existing server-side prepare/pay flow, frozen CAD quote, and durable duplicate-charge protection. No payment gateway credentials or account routing were changed.

## Domain registration
The production registration check in Vercel deployment dpl_6VPcW32vj7zkCk567esK6t6CeNjU at 2026-09-11T01:08:47.507Z confirmed exact official association-file matches and registration readback for checkout.puremajestypet.com and pmp-stripe-bridge.vercel.app. Result: registered-and-verified. The old static association file was shadowing the GoDaddy route; its earlier bytes remain in Git history. The temporary registration build command has been removed.

## Real browser verification
GitHub Actions run 34550029254, artifact 10180452781 (SHA256 eff5a1e9210356a61fbe12db204c472f25a8b182571d35ff6fe3848ad7124347) recorded:

- Started 2026-09-11T01:17:43.083Z; finished 2026-09-11T01:17:58.497Z; passed true.
- Actual anonymous Shopify test-product cart and actual GoDaddy SDK; neither mocked.
- Cart and checkout total both 100 USD cents; existing server charge quote 138 CAD cents.
- Wallet configuration: Apple Pay true, Google Pay true, merchant country CA, charge currency CAD.
- On Chromium, Google Pay was supported and displayed. The Apple Pay button was not displayed on this test device; it remains conditional on the SDK's device and merchant compatibility check.
- At 1440px and 390px widths: Express checkout above email, email still empty, normal card Pay button enabled, no horizontal overflow.
- Google Pay button opened the official pay.google.com sheet without filling the email field. It was dismissed without logging in or authorizing payment.
- No checkout CSP violations after allowing the SDK's observed https://google.com/pay connection.
- Zero payment submissions, zero card entries, zero Shopify orders created.

Pure offline tests additionally exercised Apple/Google event handling, exact CAD cent allocation including gifts, invalid contact rejection, cancellation, prepare-before-pay ordering, duplicate callbacks, and uncertain-response locking with synthetic fixtures. These are not real bank transaction tests.

Apple Pay merchant registration is verified, but an actual Apple-device payment authorization has not been performed. Neither wallet has been used to execute a bank debit in these checks. Provider review and payout availability are outside this change and have not been inferred.

# Collagen-exclusive probiotic checkout offer

Offer: buy one existing probiotic product pack, receive a second identical pack free. The current catalogue product is a 2 × 60 mL pack, so the offer fulfils two packs. It requires paid collagen variant 43349565112394. It applies once per checkout; no automatic paid addition.

The first visit to the existing Stripe checkout displays a dismissible modal. A persistent offer card remains available until payment. Declining does not prevent payment. Accepting creates a replacement server quote with two probiotic lines: one at the destination's catalogue price, the second at zero. Both appear in the order and fulfilment. Removing the offer removes both lines. Removing collagen invalidates the pair. Other cart products are unaffected.

Supported copy: English, French, German, Spanish, Italian, Portuguese, Dutch, Swedish and Finnish. Prices follow the checkout destination and currency. Stock and published product status are checked server-side. The existing discount-code policy still applies to the paid items; the free line remains zero after repricing.

Anonymous Redis counters expire after 90 days. Keys `offer:collagen-probiotic:stats:YYYY-MM-DD:COUNTRY` use the original checkout's UTC cohort date. Stages: shown, declined, accepted, removed, purchased (paid with the pair), completed (paid with collagen). Events are deduplicated by original checkout and stage. No contact or payment details are stored in these counters. They are operational measurements, not a randomized conversion experiment. A checkout may both decline and subsequently accept. Market changes can move later stages to another country. Compare completed collagen orders against existing checkout-start statistics, and account for traffic mix and test sessions before attributing conversion changes to the offer.

Emergency switch: set `PMP_COLLAGEN_PROBIOTIC_OFFER_ENABLED=0` in Vercel and redeploy to stop presenting/accepting new offers. Existing accepted quotes retain their free pack. Alternatively restore the prior production commit `a6348b223ab7df2752481c79b6758d4d6e5a49f4`.

Validation: 397 Node tests passed, including server price enforcement, duplicate prevention, stock/currency eligibility, zero-priced gift preservation, repricing/removal and Shopify order quantities. Browser checks passed at mobile width 390 px across all nine languages, including dismissal and failed-add recovery. Validation does not place or charge a real order.

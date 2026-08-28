import { AsyncLocalStorage } from "node:async_hooks";
import baseHandler from "../lib/create-checkout-base.js";

// Automatic 20% offer reserved for the Meta liquid retargeting campaign.
// The browser already sends these UTMs to this endpoint. We validate all three
// values server-side, so normal/direct/Google/other Meta traffic is unaffected.
const META_OFFER = Object.freeze({
  source: "meta",
  medium: "paid_social",
  campaign: "liquid_retargeting_product_view",
  promotionCodeId: "promo_1U6IEuA0auDoBNzsRt1kuqge", // Stripe WELCOME20 (20% once)
});

const requestScope = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch.bind(globalThis);

function normalized(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function qualifiesForMetaOffer(body) {
  return normalized(body && body.utm_source) === META_OFFER.source &&
    normalized(body && body.utm_medium) === META_OFFER.medium &&
    normalized(body && body.utm_campaign) === META_OFFER.campaign;
}

// The existing checkout implementation talks directly to Stripe with fetch().
// AsyncLocalStorage lets us alter only the Stripe request belonging to the
// qualifying HTTP request, without leaking the discount to concurrent shoppers.
globalThis.fetch = async function pmpCampaignAwareFetch(input, init) {
  const ctx = requestScope.getStore();
  const url = typeof input === "string" ? input : (input && input.url) || "";

  if (ctx && ctx.applyMetaOffer && url === "https://api.stripe.com/v1/checkout/sessions") {
    const nextInit = { ...(init || {}) };
    const params = new URLSearchParams(String(nextInit.body || ""));

    // Stripe rejects allow_promotion_codes together with a pre-applied discount.
    // Remove the manual-code field for this campaign session and pre-apply the
    // verified live Stripe promotion code WELCOME20 instead.
    params.delete("allow_promotion_codes");
    params.delete("discounts[0][coupon]");
    params.delete("discounts[0][promotion_code]");
    params.set("discounts[0][promotion_code]", META_OFFER.promotionCodeId);
    params.set("metadata[automatic_offer]", "WELCOME20");
    params.set("metadata[automatic_offer_source]", "meta_liquid_retargeting");
    nextInit.body = params.toString();

    return nativeFetch(input, nextInit);
  }

  return nativeFetch(input, init);
};

export default async function handler(req, res) {
  const applyMetaOffer = qualifiesForMetaOffer(req && req.body);
  return requestScope.run({ applyMetaOffer }, () => baseHandler(req, res));
}

// Checkout rule requested for the United States market. It remains active
// until the merchant confirms that the USD Stripe currency has been removed
// and explicitly asks us to disable it. There is deliberately no time-based
// expiry or environment-variable kill switch.

export function normalizeCountry(value) {
  const country = String(value == null ? "" : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

export function shouldApplyUsCadOverride({
  displayCurrency,
  checkoutCountry,
} = {}) {
  if (String(displayCurrency || "").toUpperCase() !== "USD") return false;

  const country = normalizeCountry(checkoutCountry);
  return country === "US";
}

export function convertLinePricesByCatalog({
  items,
  sourcePriceById,
  targetPriceById,
} = {}) {
  if (!Array.isArray(items)) throw new Error("Invalid items");

  return items.map((item) => {
    const variantId = Number(item && item.variant_id);
    const gid = `gid://shopify/ProductVariant/${variantId}`;
    const cents = Number(item && item.price_cents);

    if (!Number.isFinite(cents) || cents < 0) throw new Error("Invalid price");
    if (cents === 0) return { ...item, price_cents: 0 };

    const sourcePrice = Number(sourcePriceById && sourcePriceById[gid]);
    const targetPrice = Number(targetPriceById && targetPriceById[gid]);
    if (!Number.isFinite(sourcePrice) || sourcePrice <= 0 ||
        !Number.isFinite(targetPrice) || targetPrice <= 0) {
      throw new Error("Currency conversion price unavailable");
    }

    const convertedCents = Math.round(cents * targetPrice / sourcePrice);
    if (!Number.isSafeInteger(convertedCents) || convertedCents < 1) {
      throw new Error("Currency conversion failed");
    }

    return { ...item, price_cents: convertedCents };
  });
}

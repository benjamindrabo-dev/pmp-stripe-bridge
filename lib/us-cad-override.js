// Temporary checkout rule requested for the United States market.
// 2026-09-02 20:30 in America/Toronto is 2026-09-03 00:30 UTC (EDT).
export const DEFAULT_US_CAD_OVERRIDE_UNTIL = "2026-09-03T00:30:00.000Z";

export function normalizeCountry(value) {
  const country = String(value == null ? "" : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
}

export function shouldApplyUsCadOverride({
  displayCurrency,
  checkoutCountry,
  now = Date.now(),
  until = process.env.TEMP_US_CAD_UNTIL || DEFAULT_US_CAD_OVERRIDE_UNTIL,
} = {}) {
  if (String(displayCurrency || "").toUpperCase() !== "USD") return false;

  const deadline = Date.parse(String(until || ""));
  if (!Number.isFinite(deadline) || Number(now) >= deadline) return false;

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

// Notification-only data. Never changes order, transaction or refund currency.
export function usdEmailAttributes({ cart, items, currency, chargedCents, discount }) {
  if (cart?.currency_override !== 'US_USD_TO_CAD' || cart?.checkout_country !== 'US' ||
      cart?.display_currency !== 'usd' || String(currency).toUpperCase() !== 'CAD') return [];
  const display = cart.display_items;
  if (!Array.isArray(display) || !display.length || display.length !== items?.length) return [];
  let usd = 0, cad = 0;
  for (let i = 0; i < items.length; i++) {
    const a = display[i], b = items[i];
    if (Number(a.variant_id) !== Number(b.variant_id) || Number(a.quantity) !== Number(b.quantity)) return [];
    const q = Number(a.quantity), u = Number(a.price_cents), c = Number(b.price_cents);
    if (![q, u, c].every(Number.isSafeInteger) || q < 1 || u < 0 || c < 0 || (u === 0) !== (c === 0)) return [];
    usd += u * q; cad += c * q;
  }
  if (!Number.isSafeInteger(usd) || !Number.isSafeInteger(cad) || usd <= 0 || cad <= 0) return [];
  const ratio = usd / cad;
  // Do not infer a single exchange ratio for mixed market-specific prices.
  if (items.some((b, i) => Math.round(Number(b.price_cents) * ratio) !== Number(display[i].price_cents))) return [];
  const promo = Number(discount?.cents || 0);
  // Unknown extra charges (shipping/tax/tips) must not be silently converted.
  if (!Number.isSafeInteger(promo) || promo < 0 || promo > cad ||
      !Number.isSafeInteger(chargedCents) || chargedCents !== cad - promo) return [];
  return Object.entries({
    pmp_email_currency: 'USD',
    pmp_email_usd_ratio: String(ratio),
    pmp_email_cad_total_cents: String(chargedCents),
    pmp_email_usd_total_cents: String(usd - Math.round(promo * ratio)),
  }).map(([name, value]) => ({ name, value }));
}

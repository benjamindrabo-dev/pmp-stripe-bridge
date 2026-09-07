// Daily FX for Square CAD payments. This module never changes storefront prices.
// Persist each quote with the order; notifications must use displayAmount, never
// convert the CAD payment back using a later exchange rate.
export const FX_URL = 'https://open.er-api.com/v6/latest/CAD';
export const FX_ATTRIBUTION_URL = 'https://www.exchangerate-api.com';
const MAX_RATE_AGE_MS = 36 * 60 * 60 * 1000;
const QUOTE_LIFETIME_MS = 30 * 60 * 1000;

function fraction(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) || text.length > 60) throw new Error('Invalid positive decimal');
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  const [integer, decimal = ''] = mantissa.split('.');
  const scale = decimal.length - Number(exponent);
  if (Math.abs(scale) > 20) throw new Error('Decimal precision out of range');
  const n = BigInt(integer + decimal);
  return scale >= 0 ? [n, 10n ** BigInt(scale)] : [n * 10n ** BigInt(-scale), 1n];
}

function rounded(numerator, denominator) {
  if (denominator <= 0n) throw new Error('Invalid denominator');
  const value = (numerator * 2n + denominator) / (2n * denominator);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount too large');
  return Number(value);
}

export function validateDailyRates(data, now = Date.now()) {
  const updated = Number(data?.time_last_update_unix) * 1000;
  if (data?.result !== 'success' || data?.base_code !== 'CAD' ||
      !Number.isFinite(updated) || updated > now + 5 * 60 * 1000 ||
      now - updated > MAX_RATE_AGE_MS || Number(data?.rates?.CAD) !== 1) {
    throw new Error('Current daily exchange rates unavailable');
  }
  return data;
}

// Cache is supplied by the caller (normally Redis); raw rates stay server-side.
// Reject stale/absent rates rather than silently charging with an invented rate.
export async function loadDailyRates({ readCache, writeCache, fetcher = fetch, now = Date.now() } = {}) {
  let cached = null;
  if (readCache) {
    try { cached = await readCache(); } catch { /* Fetch fresh if cache is down. */ }
  }
  if (cached && Number(cached.fetchedAt) <= now && now - Number(cached.fetchedAt) < 60 * 60 * 1000) {
    try { return validateDailyRates(cached.data, now); } catch { /* Refresh. */ }
  }
  const response = await fetcher(FX_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Exchange rate service unavailable');
  const data = validateDailyRates(await response.json(), now);
  if (writeCache) await writeCache({ fetchedAt: now, data });
  return data;
}

export function createFxQuote({ displayCurrency, displayAmount, rates, now = Date.now() }) {
  const currency = String(displayCurrency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid currency');
  const [amountN, amountD] = fraction(displayAmount);
  if (amountN <= 0n) throw new Error('Amount must be positive');
  if (currency !== 'CAD') validateDailyRates(rates, now);
  const rate = currency === 'CAD' ? 1 : rates.rates[currency];
  if (!Number.isFinite(Number(rate)) || Number(rate) <= 0) throw new Error('Exchange rate unavailable for ' + currency);
  const [rateN, rateD] = fraction(rate);
  // rates[currency] = display units per CAD. Divide once, round once to CAD cents.
  const chargeMinor = rounded(amountN * rateD * 100n, amountD * rateN);
  if (chargeMinor < 1) throw new Error('Converted payment amount is too small');
  return Object.freeze({
    version: 1,
    displayCurrency: currency,
    displayAmount: String(displayAmount),
    chargeCurrency: 'CAD',
    chargeMinor,
    displayUnitsPerCad: String(rate),
    ratePublishedAt: currency === 'CAD' ? null : new Date(rates.time_last_update_unix * 1000).toISOString(),
    rateSource: currency === 'CAD' ? null : 'ExchangeRate-API',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + QUOTE_LIFETIME_MS).toISOString(),
  });
}

export function assertPayableQuote(quote, now = Date.now()) {
  if (quote?.version !== 1 || quote.chargeCurrency !== 'CAD' ||
      !Number.isSafeInteger(quote.chargeMinor) || quote.chargeMinor < 1 ||
      !Number.isFinite(Date.parse(quote.createdAt)) || Date.parse(quote.createdAt) > now ||
      !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= now) {
    throw new Error('Payment quote expired or invalid');
  }
  return quote;
}

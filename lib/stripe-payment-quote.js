// Charge the exact Shopify market total in its local currency. CAD accounting
// remains separate from Stripe presentment and from actual bank settlement.
// Existing version-1 CAD and version-2 MXN quotes are intentionally immutable.
import {assertPayableQuote} from './square-fx.js';

// Stripe API denominations, not Intl display precision. ISK and UGX use a
// two-decimal API amount but cannot contain fractional major units.
const ZERO_DECIMAL = new Set('BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF'.split(' '));
export const stripeMoneyScale = currency => ZERO_DECIMAL.has(currency) ? 1 : 100;

function localAmount(currency, total, scale) {
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(total) || total < 1 ||
      ![100,1000].includes(scale)) throw Error('Invalid local payment amount');
  const chargeScale = stripeMoneyScale(currency);
  const numerator = BigInt(total) * BigInt(chargeScale);
  if (numerator % BigInt(scale) !== 0n) throw Error('Invalid local payment precision');
  const value = numerator / BigInt(scale);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Local payment amount too large');
  const chargeMinor = Number(value);
  if (['ISK','UGX'].includes(currency) && chargeMinor % 100 !== 0) throw Error('Invalid local payment precision');
  return {chargeMinor,chargeScale};
}

export function stripePaymentQuote(accountingQuote, country, total, scale, supportedCurrencies = null) {
  const currency = accountingQuote.displayCurrency;
  // Never invent currency support. A rare unsupported market retains the
  // established CAD quote and the frontend's explicit actual-debit disclosure.
  if (supportedCurrencies && !supportedCurrencies.has(currency)) return accountingQuote;
  const amount = localAmount(currency,total,scale);
  if (Number(accountingQuote.displayAmount) !== total / scale) throw Error('Invalid local payment total');
  return {...accountingQuote,version:3,chargeCurrency:currency,...amount};
}

export function assertStripeQuote(cart) {
  if (cart.quote?.version === 1) return assertPayableQuote(cart.quote);
  if (![2,3].includes(cart.quote?.version)) throw Error('Invalid payment quote version');
  assertPayableQuote(cart.accountingQuote);
  if (cart.quote.version === 2) {
    // Preserve pre-migration Mexican OXXO/card sessions, including delayed payers.
    const minor = cart.total * 100 / cart.scale;
    if (cart.country !== 'MX' || cart.accountingQuote.displayCurrency !== 'MXN' ||
        !Number.isSafeInteger(minor) || minor < 1 || cart.quote.chargeCurrency !== 'MXN' ||
        cart.quote.chargeMinor !== minor || cart.quote.displayCurrency !== 'MXN' ||
        cart.quote.displayAmount !== cart.accountingQuote.displayAmount ||
        cart.quote.expiresAt !== cart.accountingQuote.expiresAt) throw Error('Invalid MXN payment quote');
    return cart.quote;
  }
  const expected = stripePaymentQuote(cart.accountingQuote,cart.country,cart.total,cart.scale);
  for (const key of ['version','displayCurrency','displayAmount','chargeCurrency','chargeMinor','chargeScale','createdAt','expiresAt','displayUnitsPerCad']) {
    if (cart.quote[key] !== expected[key]) throw Error('Invalid local payment quote');
  }
  if (cart.displayCurrency !== expected.displayCurrency) throw Error('Invalid local payment currency');
  return cart.quote;
}

export function oxxoVoucher(payment) {
  if (payment.status !== 'requires_action' || payment.next_action?.type !== 'oxxo_display_details') return null;
  const details = payment.next_action.oxxo_display_details;
  let url;
  try { url = new URL(details.hosted_voucher_url); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'payments.stripe.com') return null;
  return {url:url.href,expiresAt:details.expires_after};
}

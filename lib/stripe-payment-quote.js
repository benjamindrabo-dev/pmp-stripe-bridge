// Mexico pays the exact displayed MXN total. Keep the frozen CAD accounting
// quote separately so existing Shopify order accounting remains consistent.
import {assertPayableQuote} from './square-fx.js';

export function stripePaymentQuote(accountingQuote, country, total, scale) {
  if (country !== 'MX' || accountingQuote.displayCurrency !== 'MXN') return accountingQuote;
  const minor = total * 100 / scale;
  if (!Number.isSafeInteger(minor) || minor < 1) throw Error('Invalid MXN payment amount');
  return {...accountingQuote, version:2, chargeCurrency:'MXN', chargeMinor:minor};
}

export function assertStripeQuote(cart) {
  if (cart.quote?.version !== 2) return assertPayableQuote(cart.quote);
  assertPayableQuote(cart.accountingQuote);
  const expected = stripePaymentQuote(cart.accountingQuote,cart.country,cart.total,cart.scale);
  if (expected.version !== 2 || cart.quote.chargeCurrency !== expected.chargeCurrency ||
      cart.quote.chargeMinor !== expected.chargeMinor || cart.quote.displayAmount !== expected.displayAmount ||
      cart.quote.expiresAt !== expected.expiresAt) throw Error('Invalid MXN payment quote');
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

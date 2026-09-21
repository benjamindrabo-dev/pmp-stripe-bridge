// Read-only Stripe country capabilities; never changes payout/bank settings.
// https://docs.stripe.com/api/country_specs/retrieve
const CORE_CA_CURRENCIES = 'CAD USD EUR GBP AUD NZD MXN'.split(' ');
export function createStripeCurrencyLoader() {
  let cached = new Set(CORE_CA_CURRENCIES), refreshAt = 0, pending = null;
  return async function load(stripe, now = Date.now()) {
    if (now < refreshAt) return new Set(cached);
    if (!pending) pending = (async () => {
      try {
        const spec = await stripe('/country_specs/CA');
        if (spec.id !== 'CA' || !Array.isArray(spec.supported_payment_currencies)) throw Error('Invalid currency capabilities');
        const codes = spec.supported_payment_currencies.map(c=>String(c).toUpperCase());
        if (!codes.includes('CAD') || codes.some(c=>!/^[A-Z]{3}$/.test(c))) throw Error('Invalid currency capabilities');
        cached = new Set(codes);
        refreshAt = now + 86400000;
      } catch {
        // A capability-service outage must not break previously verified core
        // markets or make otherwise supported currencies revert after caching.
        refreshAt = now + 60000;
        console.warn('Stripe currency capabilities refresh unavailable');
      }
      return cached;
    })().finally(()=>{pending=null;});
    return new Set(await pending);
  };
}
export const loadStripePaymentCurrencies = createStripeCurrencyLoader();

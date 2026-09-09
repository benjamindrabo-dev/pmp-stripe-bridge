// Only the merchant's existing checkout host can be registered here.
// The caller verifies the Stripe account before calling this helper.
export const STRIPE_WALLET_DOMAIN='checkout.puremajestypet.com';
export async function ensureStripeWalletDomain(stripeApi) {
  const list=await stripeApi('/payment_method_domains?domain_name='+STRIPE_WALLET_DOMAIN+'&limit=100');
  if(!Array.isArray(list.data))throw new Error('Stripe wallet domain lookup unavailable');
  let domain=list.data.find(d=>d.domain_name===STRIPE_WALLET_DOMAIN&&d.livemode===true);
  if(!domain)domain=await stripeApi('/payment_method_domains',
    {domain_name:STRIPE_WALLET_DOMAIN,enabled:'true'},'pmp-checkout-wallet-domain-v1');
  if(domain?.domain_name!==STRIPE_WALLET_DOMAIN||domain.livemode!==true)throw new Error('Stripe wallet domain mismatch');
  return {registered:true,enabled:domain.enabled===true,
    applePay:domain.apple_pay?.status||'not_verified',googlePay:domain.google_pay?.status||'not_verified'};
}

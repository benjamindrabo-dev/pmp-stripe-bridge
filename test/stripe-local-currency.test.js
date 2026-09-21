import test from 'node:test';
import assert from 'node:assert/strict';
import {stripePaymentQuote,assertStripeQuote,stripeMoneyScale} from '../lib/stripe-payment-quote.js';
import {createStripeCurrencyLoader} from '../lib/stripe-payment-currencies.js';
const now=Date.now();
function fixture(currency,total=3199,scale=100){
 const accountingQuote={version:1,chargeCurrency:'CAD',chargeMinor:4400,displayCurrency:currency,displayAmount:String(total/scale),displayUnitsPerCad:'0.727045',createdAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+1800000).toISOString()};
 return {country:'US',displayCurrency:currency,total,scale,accountingQuote,quote:stripePaymentQuote(accountingQuote,'US',total,scale)};
}
for(const currency of ['CAD','USD','EUR','GBP','AUD','NZD','MXN','CHF','BRL','ARS','PEN','SEK','NOK','DKK','PLN','HUF','TWD']){
 test('new '+currency+' payment preserves the exact market total',()=>{
  const cart=fixture(currency);assert.equal(cart.quote.version,3);assert.equal(cart.quote.chargeCurrency,currency);assert.equal(cart.quote.chargeMinor,3199);assert.equal(cart.quote.chargeScale,100);
  assert.equal(assertStripeQuote(cart),cart.quote);assert.equal(cart.accountingQuote.chargeCurrency,'CAD');assert.equal(cart.accountingQuote.chargeMinor,4400);
 });
}
for(const currency of ['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF']){
 test('zero-decimal '+currency+' is never charged one hundred times too much',()=>{
  const cart=fixture(currency,400000);assert.equal(stripeMoneyScale(currency),1);assert.equal(cart.quote.chargeMinor,4000);assert.equal(cart.quote.chargeScale,1);assert.equal(assertStripeQuote(cart),cart.quote);
  assert.throws(()=>fixture(currency,400001),/precision/);
 });
}
for(const currency of ['ISK','UGX'])test(currency+' keeps Stripe compatibility units but disallows fractions',()=>{
 const cart=fixture(currency,400000);assert.equal(cart.quote.chargeMinor,400000);assert.equal(cart.quote.chargeScale,100);assert.throws(()=>fixture(currency,400001),/precision/);
});
test('unsupported currencies retain disclosed CAD instead of reaching Stripe with an invalid currency',()=>{
 const cart=fixture('USD');assert.equal(stripePaymentQuote(cart.accountingQuote,'US',cart.total,100,new Set(['CAD'])),cart.accountingQuote);
});
test('currency, amount, scale, total, display data and quote lifetime cannot be tampered with',()=>{
 const cart=fixture('USD');
 for(const change of [{chargeMinor:1},{chargeCurrency:'CAD'},{displayCurrency:'CAD'},{chargeScale:1},{displayAmount:'1.00'},{version:99},{createdAt:new Date(0).toISOString()},{expiresAt:new Date(now+3600000).toISOString()},{displayUnitsPerCad:'1000'}])assert.throws(()=>assertStripeQuote({...cart,quote:{...cart.quote,...change}}));
 assert.throws(()=>assertStripeQuote({...cart,total:1}));assert.throws(()=>assertStripeQuote({...cart,scale:1}));assert.throws(()=>assertStripeQuote({...cart,displayCurrency:'CAD'}));
 assert.throws(()=>assertStripeQuote({...cart,accountingQuote:{...cart.accountingQuote,expiresAt:new Date(0).toISOString()}}),/expired/);
 for(const total of [0,-1,NaN,Infinity,1.1,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>fixture('USD',total));
});
test('currency capability lookup is read-only, shared across callers, cached and not mutable by callers',async()=>{
 const load=createStripeCurrencyLoader();let calls=0;
 const stripe=async path=>{calls++;assert.equal(path,'/country_specs/CA');return {id:'CA',supported_payment_currencies:['cad','usd','jpy','eur']};};
 const [a,b]=await Promise.all([load(stripe,1000),load(stripe,1000)]);assert.equal(calls,1);assert.ok(a.has('JPY'));a.clear();assert.ok(b.has('CAD'));
 assert.ok((await load(stripe,2000)).has('JPY'));assert.equal(calls,1);
 await load(stripe,86402000);assert.equal(calls,2);
});
test('capability-service failures preserve core local payments and recover without resetting payouts',async()=>{
 const load=createStripeCurrencyLoader();let calls=0;
 const failed=()=>{calls++;throw Error('offline');};
 const a=await load(failed,1000);for(const code of ['CAD','USD','EUR','GBP','AUD','NZD','MXN'])assert.ok(a.has(code));assert.equal(calls,1);
 await load(failed,2000);assert.equal(calls,1);
 const recovered=await load(async()=>({id:'CA',supported_payment_currencies:['cad','usd','jpy']}),62000);assert.ok(recovered.has('JPY'));
 const cached=await load(failed,86464000);assert.ok(cached.has('JPY'));
});

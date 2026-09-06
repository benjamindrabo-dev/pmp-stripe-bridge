import test from 'node:test';
import assert from 'node:assert/strict';
import { usdEmailAttributes } from '../lib/usd-email.js';
const items = [{variant_id: 1, quantity: 2, price_cents: 9000}];
const cart = {currency_override:'US_USD_TO_CAD',checkout_country:'US',display_currency:'usd',display_items:[{variant_id:1,quantity:2,price_cents:6398}]};
const args = {cart,items,currency:'cad',chargedCents:18000};
test('preserves original USD total instead of using current FX',()=> {
 assert.equal(Object.fromEntries(usdEmailAttributes(args).map(x=>[x.name,x.value])).pmp_email_usd_total_cents,'12796');
 assert.equal(args.chargedCents,18000);
});
test('applies the checkout discount to USD reference',()=> {
 assert.equal(Object.fromEntries(usdEmailAttributes({...args,chargedCents:14400,discount:{cents:3600}}).map(x=>[x.name,x.value])).pmp_email_usd_total_cents,'10237');
});
test('falls back for missing historical data, other markets and unpriced charges',()=> {
 for (const override of [{cart:{}},{currency:'usd'},{chargedCents:18500},{cart:{...cart,checkout_country:'CA'}},{cart:{...cart,display_items:[{variant_id:2,quantity:2,price_cents:6398}]}}]) assert.deepEqual(usdEmailAttributes({...args,...override}),[]);
});

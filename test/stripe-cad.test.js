import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildStripeOrder,validId,PUBLIC_KEY} from '../lib/stripe-cad-bridge.js';
import {createFxQuote} from '../lib/square-fx.js';
const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('Stripe IDs and public key are account specific',()=>{assert.ok(validId('st_'+'a'.repeat(32)));assert.ok(!validId('sq_'+'a'.repeat(32)));assert.ok(PUBLIC_KEY.startsWith('pk_live_51UDbyTPw2Aen0E79'));});
for(const [currency,scale,total,charge] of [['USD',100,2899,4000],['EUR',100,2699,4050],['GBP',100,2299,4300],['CAD',100,3899,3899],['AUD',100,4399,4050],['JPY',100,400000,3950]]){
 test('CAD charge, local display and physical order: '+currency,()=>{
  const cart={id:'st_'+'a'.repeat(32),displayCurrency:currency,scale,total,subtotal:total,shippingDisplay:0,items:[{variant_id:123,title:'Product',quantity:1,price_cents:total,original_price_cents:total}],attribution:{},quote:{chargeMinor:charge,displayAmount:String(total/scale),displayUnitsPerCad:total/scale/(charge/100)},country:'CA'};
  const a={email:'test@example.invalid',shipping:{first_name:'Test',last_name:'Buyer',address_line_1:'123 Test',locality:'Ottawa',country:'CA'},billing:{first_name:'Test',last_name:'Buyer',address_line_1:'123 Test',locality:'Ottawa',country:'CA'}};
  const o=buildStripeOrder(cart,{id:'pi_test_not_real',livemode:true},a);
  assert.equal(o.currency,'CAD');assert.equal(o.presentmentCurrency,currency);assert.equal(o.transactions[0].gateway,'Stripe');assert.equal(Number(o.transactions[0].amountSet.shopMoney.amount),charge/100);assert.equal(Number(o.transactions[0].amountSet.presentmentMoney.amount),total/scale);assert.equal(o.lineItems[0].requiresShipping,true);assert.equal(o.test,false);assert.ok(!o.tags.includes('square'));
 });
}
test('Stripe surface preserves local formatter and uses CAD payment amount',()=>{const s=source('public/stripe-checkout.js');assert.ok(s.includes('currency:data.quote.displayCurrency'));assert.ok(s.includes("currency:'cad',amount:data.quote.chargeMinor"));assert.ok(s.includes('stripeClient.confirmPayment'));assert.ok(!s.includes('Square.payments'));assert.ok(s.includes('elements.submit()'));});
test('historical Square payments and both webhook families remain present',()=>{assert.ok(source('public/square-checkout.js').includes('Square.payments'));const w=source('api/stripe-webhook.js');assert.ok(w.includes('payment_intent.succeeded'));assert.ok(w.includes('checkout.session.completed'));});

test('new customer checkouts use Stripe CAD without deleting Square settlement',()=>{const s=source('api/create-checkout.js');assert.ok(s.includes('req.body?.payment_provider === "square"'));assert.ok(s.includes('req.stripeCadMode = true'));});

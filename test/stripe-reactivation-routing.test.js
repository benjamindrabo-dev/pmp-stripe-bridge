import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../api/create-checkout.js',import.meta.url),'utf8');
const handlerSource=source.slice(source.indexOf('export default async function handler')).replace('export default async function handler','async function handler');
for(const flag of [undefined,'1','0']) test('storefront Square payload routes to Stripe CAD with legacy flag '+flag,async()=>{
  const handler=vm.runInNewContext(handlerSource+'; handler',{
    process:{env:{PMP_LEGACY_CHECKOUT:flag}},
    baseHandler:async req=>({squareMode:req.squareMode,stripeCadMode:req.stripeCadMode}),
    qualifiesForMetaOffer:()=>false,requestScope:{run:(_,fn)=>fn()}
  });
  const result=await handler({body:{payment_provider:'square'}},{});
  assert.equal(result.squareMode,true);assert.equal(result.stripeCadMode,true);
});
test('Stripe status requires PaymentIntent completion and exposes only wallet statuses',()=>{
  const health=readFileSync(new URL('../api/stripe-health.js',import.meta.url),'utf8');
  assert.ok(health.includes("checkoutProvider: 'stripe'"));
  assert.ok(health.includes("'payment_intent.succeeded'].every"));
  assert.ok(health.includes('report.wallets ='));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareStripePayment,settleStripePayment,pendingStripePayment} from '../lib/stripe-cad-bridge.js';
import {stripePaymentQuote} from '../lib/stripe-payment-quote.js';
const id='st_'+'d'.repeat(32);
function fixture(t,{lostResponse=false,mexico=false}={}){
 const original=globalThis.fetch;
 const env={...process.env};
 Object.assign(process.env,{STRIPE_SECRET_KEY:'sk_live_mock_for_offline_test',UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'test',SHOPIFY_STORE_DOMAIN:'test.myshopify.com',SHOPIFY_ADMIN_TOKEN:'test'});
 delete process.env.GA4_API_SECRET;delete process.env.META_CAPI_TOKEN;delete process.env.META_PIXEL_ID;
 const cart={id,provider:'stripe',displayCurrency:'USD',scale:100,total:2899,subtotal:2899,shippingDisplay:0,items:[{variant_id:123,title:'Product',quantity:1,price_cents:2899,original_price_cents:2899}],attribution:{},country:'US',quote:{version:1,createdAt:new Date(Date.now()-1000).toISOString(),displayCurrency:'USD',displayAmount:'28.99',chargeCurrency:'CAD',chargeMinor:4000,displayUnitsPerCad:'0.72475',expiresAt:new Date(Date.now()+1800000).toISOString()}};
 if(mexico){
  Object.assign(cart,{country:'MX',displayCurrency:'MXN',total:56300,subtotal:56300,items:[{variant_id:123,title:'Product',quantity:1,price_cents:56300,original_price_cents:56300}]});
  cart.accountingQuote={...cart.quote,displayCurrency:'MXN',displayAmount:'563.00',displayUnitsPerCad:'14.075'};
  cart.quote=stripePaymentQuote(cart.accountingQuote,'MX',cart.total,cart.scale);
 }
 const db=new Map([['sess:'+id,JSON.stringify(cart)]]),intents=new Map(),counts={created:0,orders:0,posts:0,reads:0,clears:0};
 const createBodies=new Map(),createResponses=new Map(),requests=[];
 const control={failClear:0,loseClearResponse:0,statusDuringClear:null,keepReceipt:false};
 let existingOrder=null,shouldLose=lostResponse;
 const ok=x=>new Response(JSON.stringify(x),{status:200,headers:{'Content-Type':'application/json'}});
 globalThis.fetch=async(url,options={})=>{
  const u=String(url);
  if(u==='https://redis.invalid'){
   const [command,key,...args]=JSON.parse(options.body);
   let result=null;
   if(command==='GET')result=db.get(key)??null;
   else if(command==='SET'){if(args.includes('NX')&&db.has(key))result=null;else{db.set(key,args[0]);result='OK';}}
   else if(command==='EVAL'){const actualKey=args[1],token=args[2];if(db.get(actualKey)===token){db.delete(actualKey);result=1;}else result=0;}
   else if(command==='DEL'){db.delete(key);result=1;}
   else if(['SADD','SREM','RPUSH'].includes(command))result=1;
   else if(['SRANDMEMBER','LPOP'].includes(command))result=[];
   else throw Error('Unexpected Redis command '+command);
   return ok({result});
  }
  if(u==='https://api.stripe.com/v1/payment_intents'&&options.method==='POST'){
   counts.posts++;
   const p=new URLSearchParams(options.body),idem=options.headers['Idempotency-Key'];
   assert.equal(p.get('currency'),mexico?'mxn':'cad');assert.equal(Number(p.get('amount')),cart.quote.chargeMinor);assert.equal(p.get('metadata[pmp_checkout_id]'),id);assert.equal(idem,id);
   requests.push({method:'create',body:options.body,idempotencyKey:idem});
   if(createBodies.has(idem))assert.equal(options.body,createBodies.get(idem),'Create retries must preserve the exact stored request');
   else createBodies.set(idem,options.body);
   let pi=intents.get(idem);
   if(!pi){counts.created++;pi={id:'pi_mock',status:'requires_payment_method',currency:p.get('currency'),amount:Number(p.get('amount')),amount_received:0,metadata:{pmp_checkout_id:id,pmp_provider:'stripe_cad'},receipt_email:p.get('receipt_email'),livemode:true,client_secret:'pi_mock_secret_TEST_ONLY'};intents.set(idem,pi);createResponses.set(idem,structuredClone(pi));}
   if(shouldLose){shouldLose=false;throw Error('Simulated lost API response');}
   return ok(createResponses.get(idem));
  }
  if(u==='https://api.stripe.com/v1/payment_intents/pi_mock'){
   const pi=intents.get(id);
   if(options.method==='POST'){
    counts.clears++;requests.push({method:'clear',body:options.body});
    assert.deepEqual([...new URLSearchParams(options.body)],[['receipt_email','']]);
    assert.equal(options.headers['Idempotency-Key'],undefined,'Receipt updates must not reuse the creation key');
    if(control.failClear-->0)return new Response(JSON.stringify({error:{code:'receipt_update_failed'}}),{status:503});
    if(control.statusDuringClear)pi.status=control.statusDuringClear;
    if(!control.keepReceipt)pi.receipt_email=null;
    if(control.loseClearResponse-->0)throw Error('Simulated lost receipt update response');
   }else{counts.reads++;requests.push({method:'read'});}
   return ok(pi);
  }
  if(u==='https://test.myshopify.com/admin/api/2026-01/graphql.json'){
   const request=JSON.parse(options.body);
   if(request.query.includes('StripeExisting'))return ok({data:{orders:{nodes:existingOrder?[existingOrder]:[]}}});
   if(request.query.includes('orderCreate')){
    counts.orders++;assert.equal(request.variables.options.sendReceipt,true);assert.equal(request.variables.order.email,body.email);assert.equal(request.variables.order.transactions[0].gateway,'Stripe');assert.equal(request.variables.order.currency,'CAD');assert.equal(request.variables.order.presentmentCurrency,mexico?'MXN':'USD');
    if(mexico){
     assert.deepEqual(request.variables.order.transactions[0].amountSet,{shopMoney:{amount:'40.00',currencyCode:'CAD'},presentmentMoney:{amount:'563.00',currencyCode:'MXN'}});
     assert.equal(request.variables.order.customAttributes.find(a=>a.key==='pmp_payment_currency').value,'MXN');
     assert.equal(request.variables.order.customAttributes.find(a=>a.key==='pmp_payment_amount').value,'563.00');
    }
    existingOrder={id:'gid://shopify/Order/1',legacyResourceId:'1',name:'#TEST'};
    return ok({data:{orderCreate:{order:existingOrder,userErrors:[]}}});
   }
  }
  throw Error('Unexpected external request '+u);
 };
 t.after(()=>{globalThis.fetch=original;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);});
 function seedLegacy({savedPaymentId=true,status='requires_payment_method'}={}){
  const request={amount:'4000',currency:'cad','automatic_payment_methods[enabled]':'true','metadata[pmp_checkout_id]':id,'metadata[pmp_provider]':'stripe_cad',receipt_email:body.email};
  const pi={id:'pi_mock',status,currency:'cad',amount:4000,amount_received:status==='succeeded'?4000:0,metadata:{pmp_checkout_id:id,pmp_provider:'stripe_cad'},receipt_email:body.email,livemode:true,client_secret:'pi_mock_secret_TEST_ONLY'};
  intents.set(id,pi);counts.created=1;
  createBodies.set(id,new URLSearchParams(request).toString());
  // Stripe's idempotent create response can remain payable after the real intent succeeds.
  createResponses.set(id,{...structuredClone(pi),status:'requires_payment_method',amount_received:0});
  db.set('stripe:attempt:'+id,JSON.stringify({email:body.email,shipping:address,billing:address,request,createdAt:Date.now()-1000,...(savedPaymentId?{paymentId:pi.id}:{})}));
  return structuredClone(request);
 }
 return {counts,db,intents,cart,requests,control,seedLegacy};
}
const address={first_name:'Test',last_name:'Buyer',address_line_1:'123 Example',locality:'Example',postal_code:'12345',country:'US'};
const body={email:'qa@example.invalid',shipping:address,billing:address,confirmedChargeMinor:4000};
const mxBody={...body,shipping:{...address,country:'MX'},billing:{...address,country:'MX'},confirmedChargeMinor:56300};
test('MX charges the exact displayed pesos and fulfills only once after delayed OXXO success',async t=>{
 const f=fixture(t,{mexico:true});
 const result=await prepareStripePayment(id,mxBody);
 assert.equal(result.currency,'MXN');assert.equal(result.amount,56300);
 const pi=f.intents.get(id);
 Object.assign(pi,{status:'requires_action',next_action:{type:'oxxo_display_details',oxxo_display_details:{hosted_voucher_url:'https://payments.stripe.com/oxxo/voucher_test',expires_after:1900000000}}});
 assert.equal((await settleStripePayment(pi.id)).paid,false);assert.equal(f.counts.orders,0);
 const pending=await prepareStripePayment(id,mxBody);
 assert.equal(pending.pending,true);assert.ok(pending.voucher);assert.equal(pending.clientSecret,undefined);
 // Reopening after the 30-minute quote expires must still display the same voucher.
 f.cart.quote.expiresAt=new Date(Date.now()-1000).toISOString();f.db.set('sess:'+id,JSON.stringify(f.cart));
 assert.equal((await pendingStripePayment(f.cart)).voucher.url,pending.voucher.url);
 assert.equal(f.counts.created,1);
 Object.assign(pi,{status:'succeeded',amount_received:56300});
 const paid=await settleStripePayment(pi.id);await settleStripePayment(pi.id);
 assert.equal(paid.paid,true);assert.equal(paid.currency,'MXN');assert.equal(paid.amount,56300);assert.equal(f.counts.orders,1);
});
test('MX refuses a wrong payment amount or currency before fulfillment',async t=>{
 const f=fixture(t,{mexico:true});
 await assert.rejects(prepareStripePayment(id,{...mxBody,confirmedChargeMinor:4000}),/refresh/);
 await prepareStripePayment(id,mxBody);
 Object.assign(f.intents.get(id),{status:'succeeded',currency:'cad',amount_received:56300});
 await assert.rejects(settleStripePayment('pi_mock'),/amount mismatch/);assert.equal(f.counts.orders,0);
});
test('a changed CAD amount cannot create a PaymentIntent',async t=>{const f=fixture(t);await assert.rejects(prepareStripePayment(id,{...body,confirmedChargeMinor:1}),/refresh your payment total/);assert.equal(f.counts.created,0);});
test('repeated payment preparation reuses one Stripe intent',async t=>{const f=fixture(t);const a=await prepareStripePayment(id,body);const b=await prepareStripePayment(id,body);assert.equal(a.clientSecret,b.clientSecret);assert.equal(f.counts.created,1);assert.equal(f.counts.posts,1);});
test('a lost create response retries the same immutable idempotent request',async t=>{const f=fixture(t,{lostResponse:true});await assert.rejects(prepareStripePayment(id,body),/lost API response/);await prepareStripePayment(id,body);assert.equal(f.counts.created,1);assert.equal(f.counts.posts,2);});
test('only a succeeded matching CAD intent creates one Shopify order',async t=>{const f=fixture(t);await prepareStripePayment(id,body);assert.equal((await settleStripePayment('pi_mock')).paid,false);assert.equal(f.counts.orders,0);Object.assign(f.intents.get(id),{status:'succeeded',amount_received:4000});const a=await settleStripePayment('pi_mock');const b=await settleStripePayment('pi_mock');assert.equal(a.paid,true);assert.equal(b.orderId,a.orderId);assert.equal(f.counts.orders,1);assert.equal(a.currency,'USD');assert.equal(a.amount,2899);});
test('a succeeded intent with the wrong received amount is not fulfilled',async t=>{const f=fixture(t);await prepareStripePayment(id,body);Object.assign(f.intents.get(id),{status:'succeeded',amount_received:3999});await assert.rejects(settleStripePayment('pi_mock'),/amount mismatch/);assert.equal(f.counts.orders,0);});



test('new Stripe intents retain contact and attribution without requesting a Stripe receipt',async t=>{
 const f=fixture(t);
 f.cart.attribution={journey_id:'journey_test',shopify_cart_token:'cart_test',gclid:'click_test'};
 f.db.set('sess:'+id,JSON.stringify(f.cart));
 const result=await prepareStripePayment(id,body);
 const request=new URLSearchParams(f.requests[0].body);
 assert.equal(request.has('receipt_email'),false);
 assert.equal(request.get('metadata[journey_id]'),'journey_test');
 assert.equal(request.get('metadata[shopify_cart_token]'),'cart_test');
 assert.equal(request.get('metadata[gclid]'),'click_test');
 assert.equal(request.get('shipping[name]'),'Test Buyer');
 assert.equal(JSON.parse(f.db.get('stripe:attempt:'+id)).email,body.email);
 assert.equal(result.clientSecret,'pi_mock_secret_TEST_ONLY');
 assert.equal(f.counts.clears,0);
});

test('an existing payable intent is cleared before reuse without creating a second payment',async t=>{
 const f=fixture(t),originalRequest=f.seedLegacy();
 const result=await prepareStripePayment(id,body);
 assert.equal(result.clientSecret,'pi_mock_secret_TEST_ONLY');
 assert.equal(f.intents.get(id).receipt_email,null);
 assert.deepEqual(f.requests.map(x=>x.method),['read','clear']);
 await prepareStripePayment(id,body);
 assert.equal(f.counts.created,1);assert.equal(f.counts.posts,0);assert.equal(f.counts.clears,1);
 assert.deepEqual(JSON.parse(f.db.get('stripe:attempt:'+id)).request,originalRequest);
});

test('a legacy lost-response replay keeps its original receipt parameter and key then clears the current intent',async t=>{
 const f=fixture(t),originalRequest=f.seedLegacy({savedPaymentId:false});
 const result=await prepareStripePayment(id,body);
 assert.equal(result.clientSecret,'pi_mock_secret_TEST_ONLY');
 assert.equal(f.intents.get(id).receipt_email,null);
 assert.deepEqual(f.requests.map(x=>x.method),['create','read','clear']);
 assert.equal(new URLSearchParams(f.requests[0].body).get('receipt_email'),body.email);
 assert.equal(f.requests[0].idempotencyKey,id);
 assert.deepEqual(JSON.parse(f.db.get('stripe:attempt:'+id)).request,originalRequest);
 assert.equal(f.counts.created,1);assert.equal(f.counts.posts,1);
});

test('a failed legacy receipt update withholds the secret and retries using the saved payment ID',async t=>{
 const f=fixture(t);f.seedLegacy({savedPaymentId:false});f.control.failClear=1;
 await assert.rejects(prepareStripePayment(id,body),/receipt_update_failed/);
 assert.equal(JSON.parse(f.db.get('stripe:attempt:'+id)).paymentId,'pi_mock');
 assert.equal(f.intents.get(id).receipt_email,body.email);
 const result=await prepareStripePayment(id,body);
 assert.equal(result.clientSecret,'pi_mock_secret_TEST_ONLY');
 assert.equal(f.intents.get(id).receipt_email,null);
 assert.equal(f.counts.created,1);assert.equal(f.counts.posts,1);assert.equal(f.counts.clears,2);
});

test('a lost successful receipt-update response is recovered without a second update',async t=>{
 const f=fixture(t);f.seedLegacy();f.control.loseClearResponse=1;
 await assert.rejects(prepareStripePayment(id,body),/lost receipt update response/);
 assert.equal(f.intents.get(id).receipt_email,null);
 const result=await prepareStripePayment(id,body);
 assert.equal(result.clientSecret,'pi_mock_secret_TEST_ONLY');
 assert.equal(f.counts.created,1);assert.equal(f.counts.clears,1);
});

for(const status of ['succeeded','processing','requires_capture']){
 test('an existing '+status+' intent receives no receipt update',async t=>{
  const f=fixture(t);f.seedLegacy({status});
  assert.deepEqual(await prepareStripePayment(id,body),{pending:true});
  assert.equal(f.counts.clears,0);assert.equal(f.counts.posts,0);
 });
 test('a stale create replay retrieves current '+status+' status without updating the intent',async t=>{
  const f=fixture(t);f.seedLegacy({savedPaymentId:false,status});
  assert.deepEqual(await prepareStripePayment(id,body),{pending:true});
  assert.deepEqual(f.requests.map(x=>x.method),['create','read']);
  assert.equal(f.counts.clears,0);assert.equal(f.counts.created,1);
 });
}

test('a payment that succeeds during receipt cleanup returns pending without a client secret',async t=>{
 const f=fixture(t);f.seedLegacy();f.control.statusDuringClear='succeeded';
 assert.deepEqual(await prepareStripePayment(id,body),{pending:true});
 assert.equal(f.counts.clears,1);
});

test('a canceled legacy intent cannot be updated or prepared for another payment',async t=>{
 const f=fixture(t);f.seedLegacy({status:'canceled'});
 await assert.rejects(prepareStripePayment(id,body),/start a new checkout/);
 assert.equal(f.counts.clears,0);assert.equal(f.counts.posts,0);
});

test('a mismatched legacy intent is rejected before attempting receipt cleanup',async t=>{
 const f=fixture(t);f.seedLegacy();f.intents.get(id).metadata.pmp_checkout_id='st_'+'e'.repeat(32);
 await assert.rejects(prepareStripePayment(id,body),/amount mismatch/);
 assert.equal(f.counts.clears,0);
});

test('a response that still contains a receipt email cannot release a client secret',async t=>{
 const f=fixture(t);f.seedLegacy();f.control.keepReceipt=true;
 await assert.rejects(prepareStripePayment(id,body),/receipt settings unavailable/);
 assert.equal(f.counts.clears,1);
});

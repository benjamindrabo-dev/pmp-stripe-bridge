import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareStripePayment,settleStripePayment} from '../lib/stripe-cad-bridge.js';
const id='st_'+'d'.repeat(32);
function fixture(t,{lostResponse=false}={}){
 const original=globalThis.fetch;
 const env={...process.env};
 Object.assign(process.env,{STRIPE_SECRET_KEY:'sk_live_mock_for_offline_test',UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'test',SHOPIFY_STORE_DOMAIN:'test.myshopify.com',SHOPIFY_ADMIN_TOKEN:'test'});
 delete process.env.GA4_API_SECRET;delete process.env.META_CAPI_TOKEN;delete process.env.META_PIXEL_ID;
 const cart={id,provider:'stripe',displayCurrency:'USD',scale:100,total:2899,subtotal:2899,shippingDisplay:0,items:[{variant_id:123,title:'Product',quantity:1,price_cents:2899,original_price_cents:2899}],attribution:{},country:'US',quote:{displayCurrency:'USD',displayAmount:'28.99',chargeCurrency:'CAD',chargeMinor:4000,displayUnitsPerCad:'0.72475',expiresAt:new Date(Date.now()+1800000).toISOString()}};
 const db=new Map([['sess:'+id,JSON.stringify(cart)]]),intents=new Map(),counts={created:0,orders:0,posts:0};
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
   assert.equal(p.get('currency'),'cad');assert.equal(Number(p.get('amount')),4000);assert.equal(p.get('metadata[pmp_checkout_id]'),id);assert.equal(idem,id);
   let pi=intents.get(idem);
   if(!pi){counts.created++;pi={id:'pi_mock',status:'requires_payment_method',currency:'cad',amount:4000,amount_received:0,metadata:{pmp_checkout_id:id,pmp_provider:'stripe_cad'},livemode:true,client_secret:'pi_mock_secret_TEST_ONLY'};intents.set(idem,pi);}
   if(shouldLose){shouldLose=false;throw Error('Simulated lost API response');}
   return ok(pi);
  }
  if(u==='https://api.stripe.com/v1/payment_intents/pi_mock')return ok(intents.get(id));
  if(u==='https://test.myshopify.com/admin/api/2026-01/graphql.json'){
   const request=JSON.parse(options.body);
   if(request.query.includes('StripeExisting'))return ok({data:{orders:{nodes:existingOrder?[existingOrder]:[]}}});
   if(request.query.includes('orderCreate')){
    counts.orders++;assert.equal(request.variables.order.transactions[0].gateway,'Stripe');assert.equal(request.variables.order.currency,'CAD');assert.equal(request.variables.order.presentmentCurrency,'USD');
    existingOrder={id:'gid://shopify/Order/1',legacyResourceId:'1',name:'#TEST'};
    return ok({data:{orderCreate:{order:existingOrder,userErrors:[]}}});
   }
  }
  throw Error('Unexpected external request '+u);
 };
 t.after(()=>{globalThis.fetch=original;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);});
 return {counts,db,intents,cart};
}
const address={first_name:'Test',last_name:'Buyer',address_line_1:'123 Example',locality:'Example',postal_code:'12345',country:'US'};
const body={email:'qa@example.invalid',shipping:address,billing:address,confirmedChargeMinor:4000};
test('a changed CAD amount cannot create a PaymentIntent',async t=>{const f=fixture(t);await assert.rejects(prepareStripePayment(id,{...body,confirmedChargeMinor:1}),/refresh your payment total/);assert.equal(f.counts.created,0);});
test('repeated payment preparation reuses one Stripe intent',async t=>{const f=fixture(t);const a=await prepareStripePayment(id,body);const b=await prepareStripePayment(id,body);assert.equal(a.clientSecret,b.clientSecret);assert.equal(f.counts.created,1);assert.equal(f.counts.posts,1);});
test('a lost create response retries the same immutable idempotent request',async t=>{const f=fixture(t,{lostResponse:true});await assert.rejects(prepareStripePayment(id,body),/lost API response/);await prepareStripePayment(id,body);assert.equal(f.counts.created,1);assert.equal(f.counts.posts,2);});
test('only a succeeded matching CAD intent creates one Shopify order',async t=>{const f=fixture(t);await prepareStripePayment(id,body);assert.equal((await settleStripePayment('pi_mock')).paid,false);assert.equal(f.counts.orders,0);Object.assign(f.intents.get(id),{status:'succeeded',amount_received:4000});const a=await settleStripePayment('pi_mock');const b=await settleStripePayment('pi_mock');assert.equal(a.paid,true);assert.equal(b.orderId,a.orderId);assert.equal(f.counts.orders,1);assert.equal(a.currency,'USD');assert.equal(a.amount,2899);});
test('a succeeded intent with the wrong received amount is not fulfilled',async t=>{const f=fixture(t);await prepareStripePayment(id,body);Object.assign(f.intents.get(id),{status:'succeeded',amount_received:3999});await assert.rejects(settleStripePayment('pi_mock'),/amount mismatch/);assert.equal(f.counts.orders,0);});

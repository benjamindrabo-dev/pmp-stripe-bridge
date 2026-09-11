import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {normalizeGoDaddyAttribution as normalize} from '../lib/godaddy-attribution.js';
import {orderAttributionAttributes} from '../api/stripe-webhook.js';
import {createFromSnapshot,revise} from '../lib/godaddy-cart.js';
import {loadCart,buildGoDaddyOrder} from '../lib/godaddy-embedded.js';

const LANDING='https://www.puremajestypet.com/en-ca/products/liquid-collagen-for-dogs';
const WHEN='2026-09-10T12:00:00.000Z';
const touch=(prefix,source,medium)=>({[prefix+'_landing_url']:LANDING,[prefix+'_referrer']:'https://www.'+source+'.com/',[prefix+'_source']:source,[prefix+'_medium']:medium,[prefix+'_at']:WHEN});
const fixtures=[
 ['Google organic', {...touch('first_entry','google','organic'),...touch('first_touch','google','organic')},'Google organic search / SEO (inferred)','first_free_click'],
 ['Bing organic',{...touch('first_entry','bing','organic'),...touch('first_touch','bing','organic')},'Bing organic search / SEO (inferred)','first_free_click'],
 ['Google free listing',{...touch('first_touch','google','product_sync'),first_touch_campaign:'sag_organic'},'Google free listing (inferred)','first_free_click'],
 ['Google Ads after SEO then direct',{...touch('first_touch','google','organic'),...touch('last_touch','google','cpc'),gclid:'SYNTHETIC_GCLID_12345'},'Google Ads (paid)','last_paid_click'],
 ['Meta retargeting after SEO',{...touch('first_touch','google','organic'),...touch('last_touch','meta','paid_social'),last_touch_campaign:'retargeting fall'},'Meta Ads (paid)','last_paid_click'],
 ['Email',{...touch('first_touch','omnisend','email')},'Email','first_free_click'],
 ['Referral',{first_touch_landing_url:LANDING,first_touch_referrer:'https://dogjournal.example.test/article',first_touch_at:WHEN},'Referral: dogjournal.example.test','first_free_click'],
 ['No known source',{landing_url:LANDING},'Direct / unknown','current_session'],
];
for(const [name,input,channel,basis] of fixtures)test(name+' keeps the existing Stripe attribution decision',()=>{
 const before=JSON.stringify(input),out=normalize(input),expected=orderAttributionAttributes(input),actual=orderAttributionAttributes(out);
 assert.equal(actual.channel.label,channel);assert.equal(actual.basis,basis);
 assert.equal(actual.channel.label,expected.channel.label);assert.equal(actual.basis,expected.basis);
 assert.equal(actual.primary.landing,expected.primary.landing);assert.equal(actual.primary.referrer,expected.primary.referrer);
 assert.equal(JSON.stringify(input),before);assert.equal(out.marketing_allowed,false);
});
test('all touch aliases survive normalization with original timestamps',()=>{
 const payload={...touch('first_entry','google','organic'),...touch('first_touch','google','organic'),...touch('last_touch','google','cpc')};
 const out=normalize(payload);for(const p of ['first_entry','first_touch','last_touch']){assert.equal(out[p+'_landing'],LANDING);assert.equal(out[p+'_at'],WHEN);}
 assert.deepEqual(normalize(out),out);
});
test('paid IDs, GA4 session identity and consent retain strict types',()=>{
 const out=normalize({dclid:'SYNTHETIC_DCLID_123',ga_client_id:'123456.987654',ga_session_id:'1789051210',ga_session_number:'2',journey_id:'fixture-journey-123',marketing_allowed:true});
 assert.equal(out.dclid,'SYNTHETIC_DCLID_123');assert.equal(out.ga_session_id,'1789051210');assert.equal(out.marketing_allowed,true);
 for(const value of [false,'true',1,undefined])assert.equal(normalize({marketing_allowed:value}).marketing_allowed,false);
});
test('never creates source, medium or paid identifiers to repair missing history',()=>{
 const out=normalize({journey_id:'fixture-journey-123'});assert.equal(out.utm_source,undefined);assert.equal(out.gclid,undefined);assert.equal(out.first_touch_at,undefined);
});
test('URLs lose credentials, queries, fragments and email-bearing paths',()=>{
 const out=normalize({landing_url:LANDING+'?email=user@example.test&gclid=secret#private',referrer:'https://user:pass@www.google.com/?q=private',first_touch_landing_url:'https://www.puremajestypet.com/user%2540example.test'});
 assert.equal(out.landing_page,LANDING);assert.equal(out.referrer,'https://www.google.com/');assert.equal(out.first_touch_landing,'https://www.puremajestypet.com/');
 assert.doesNotMatch(JSON.stringify(out),/pass|private|%2540|secret/);
});
test('arbitrary PII, secrets, payment details and unsafe types are never carried over',()=>{
 const out=normalize({utm_campaign:'user%2540example.test',first_entry_source:'user@example.test',gclid:'bad',ga_client_id:'email@example.test',email:'user@example.test',private_key:'secret',nonce:'secret',customer:{name:'x'},first_touch_referrer:'javascript:alert(1)',utm_source:{x:1},first_touch_at:'not-a-date'});
 assert.equal(out.utm_campaign,undefined);assert.equal(out.first_entry_source,undefined);assert.equal(out.ga_client_id,undefined);assert.equal(out.first_touch_referrer,undefined);assert.equal(out.first_touch_at,undefined);
 assert.doesNotMatch(JSON.stringify(out),/secret|example.test|nonce|customer/);
});
test('campaign punctuation, length limits and cart return host are handled safely',()=>{
 const out=normalize({utm_campaign:'Canada | Collagen - Fall (1)',utm_content:'x'.repeat(1000),shopify_cart_url:'https://outside.example.test/cart'});
 assert.equal(out.utm_campaign,'Canada | Collagen - Fall (1)');assert.equal(out.utm_content.length,200);assert.equal(out.shopify_cart_url,undefined);
});

test('real GoDaddy cart writer and Shopify order builder preserve provenance without a financial call',async()=>{
 const oldEnv={...process.env},native=globalThis.fetch,db=new Map();
 const business='11111111-1111-4111-8111-111111111111',store='22222222-2222-4222-8222-222222222222';
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 Object.assign(process.env,{VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'prep/godaddy-payments-20260909',VERCEL_URL:'fixture.example.test',GODADDY_BUSINESS_ID:business,GODADDY_STORE_ID:store,GODADDY_APPLICATION_ID:'urn:aid:33333333-3333-4333-8333-333333333333',GODADDY_PRIVATE_KEY:privateKey.export({format:'pem',type:'pkcs8'}),GODADDY_CHARGE_CURRENCY:'CAD',UPSTASH_REDIS_REST_URL:'https://redis.example.test',UPSTASH_REDIS_REST_TOKEN:'synthetic-token',SHOPIFY_STORE_DOMAIN:'shop.example.test',SHOPIFY_ADMIN_TOKEN:'synthetic-token',FLAT_SHIPPING_CENTS:'0'});
 const snapshot={currency:'CAD',total_price:4500,items_subtotal_price:4500,item_count:1,cart_level_discount_applications:[],items:[{variant_id:123,quantity:1,final_line_price:4500,original_line_price:4500,product_title:'Synthetic product'}]};
 const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);
  assert.ok(!/cards\/tokenize\/charge|\/payments$|google-analytics|graph.facebook|googleads/.test(u.href),'unexpected financial or advertising request');
  if(u.hostname==='redis.example.test'){
   const [op,key,value,...rest]=JSON.parse(init.body);
   if(op==='GET')return json({result:db.get(key)||null});
   if(op==='SET'){if(rest.includes('NX')&&db.has(key))return json({result:null});db.set(key,value);return json({result:'OK'});}
   if(op==='EVAL'){db.delete(rest[0]||key);return json({result:1});}
   throw Error('Unexpected Redis operation '+op);
  }
  if(u.hostname==='www.puremajestypet.com')return json(u.pathname.endsWith('/cart.js')?snapshot:{});
  if(u.hostname==='shop.example.test'){
   const body=JSON.parse(init.body);assert.ok(body.query.startsWith('query GoDaddyCartProducts'),'only catalog queries');
   return json({data:{nodes:body.variables.ids.map(id=>({id,title:'Default',contextualPricing:{price:{amount:id.endsWith('/123')?'45.00':'68.00',currencyCode:'CAD'}},product:{id:'gid://shopify/Product/1',title:'Synthetic product',status:'ACTIVE'}}))}});
  }
  if(u.hostname==='services.poynt.net'){
   if(u.pathname==='/token')return json({accessToken:'synthetic-token',expiresIn:3600});
   assert.equal(init.method,'GET');assert.equal(u.pathname,`/businesses/${business}/stores/${store}`);
   return json({id:store,businessId:business,currency:'CAD',status:'ACTIVE'});
  }
  throw Error('Unexpected network destination');
 };
 try{
  for(const [,payload,channel] of fixtures){
   const result=await createFromSnapshot({cart:snapshot,country:'CA',locale:'en',attribution:{...payload,journey_id:'fixture-journey-123',marketing_allowed:false}});
   const cart=await loadCart(result.sessionId);
   assert.equal(cart.total,4500);assert.equal(cart.quote.chargeMinor,4500);assert.equal(cart.attribution.journey_id,'fixture-journey-123');
   const address={first_name:'Test',last_name:'Fixture',address_line_1:'1 Test Street',locality:'Test',country:'CA',postal_code:'A1A1A1',administrative_district_level_1:'ON'};
   const order=buildGoDaddyOrder(cart,{id:'synthetic-payment-not-submitted'},{email:'fixture@example.test',shipping:address,billing:address});
   const attrs=Object.fromEntries(order.customAttributes.map(a=>[a.key,a.value]));
   assert.equal(attrs.attribution_channel,channel);assert.equal(attrs.tracking_version,'pmp_v4');assert.equal(attrs.pmp_journey_id,'fixture-journey-123');
   // Existing mutations preserve the same attribution object through quote revision.
   const added=await revise(result.sessionId,{action:'add-dental'}),next=await loadCart(added.sessionId);
   assert.deepEqual(next.attribution,cart.attribution);assert.equal(next.total,11300);
   const removed=await revise(added.sessionId,{action:'remove-dental'}),restored=await loadCart(removed.sessionId);
   assert.deepEqual(restored.attribution,cart.attribution);assert.equal(restored.total,4500);
  }
 }finally{globalThis.fetch=native;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);}
});

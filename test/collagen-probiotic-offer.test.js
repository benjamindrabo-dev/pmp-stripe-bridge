import test from 'node:test';
import assert from 'node:assert/strict';
import {COLLAGEN_VARIANT,PROBIOTIC_VARIANT,COLLAGEN_PROBIOTIC_OFFER,addOfferPair,assertOfferPair,retainEligibleOffer,recordOfferEvent} from '../lib/collagen-probiotic-offer.js';
import {reviseCart,collagenProbioticOffer} from '../lib/stripe-cad-cart.js';
import {publicQuote,buildStripeOrder,prepareStripePayment} from '../lib/stripe-cad-bridge.js';

const collagen={variant_id:COLLAGEN_VARIANT,title:'Collagen',quantity:1,price_cents:3199};
function product(currency='CAD',amount='49.99',stock=20){return {id:'gid://shopify/ProductVariant/'+PROBIOTIC_VARIANT,inventoryQuantity:stock,inventoryPolicy:'DENY',contextualPricing:{price:{amount,currencyCode:currency}},product:{id:'gid://shopify/Product/8224043761738',status:'ACTIVE',title:'Probiotic (2 × 60 mL)',featuredImage:{url:'https://example.invalid/probiotic.png'}}};}

test('collagen-only offer charges one catalog pack, includes one zero-price pack, and cannot repeat',()=>{
 const pair=addOfferPair([collagen],product(),{scale:100,currency:'CAD'});
 assertOfferPair(pair);assert.equal(pair.length,3);assert.equal(pair[1].price_cents,4999);assert.equal(pair[2].price_cents,0);assert.equal(pair[1].quantity+pair[2].quantity,2);
 assert.throws(()=>addOfferPair(pair,product(),{scale:100,currency:'CAD'}),/already/);
 assert.throws(()=>addOfferPair([{...collagen,variant_id:999}],product(),{scale:100,currency:'CAD'}),/requires collagen/);
 assert.throws(()=>addOfferPair([{...collagen,price_cents:0}],product(),{scale:100,currency:'CAD'}),/requires collagen/);
});
test('destination availability, stock, wrong variant and zero catalog prices reject the offer',()=>{
 for(const p of [product('USD'),product('CAD','0'),product('CAD','49.99',1),{...product(),id:'gid://shopify/ProductVariant/999'}, {...product(),product:{...product().product,status:'DRAFT'}}])assert.throws(()=>addOfferPair([collagen],p,{scale:100,currency:'CAD'}),/unavailable/);
 const p={...product('CAD','49.99',-20),inventoryPolicy:'CONTINUE'};assert.equal(addOfferPair([collagen],p,{scale:100,currency:'CAD'}).length,3);
});
test('local currencies and zero-decimal markets preserve their exact offer price',()=>{
 for(const [currency,amount,expected]of [['USD','43.99',4399],['EUR','39.95',3995],['GBP','34.99',3499],['CLP','41990',4199000]]){
  const pair=addOfferPair([collagen],product(currency,amount),{scale:100,currency});assert.equal(pair[1].price_cents,expected);assert.equal(pair[2].price_cents,0);
 }
});
test('removing collagen removes the complete promotional pair and preserves unrelated probiotics',()=>{
 const regular={variant_id:PROBIOTIC_VARIANT,quantity:3,price_cents:4999};
 const pair=addOfferPair([collagen,regular],product(),{scale:100,currency:'CAD'});
 assert.deepEqual(retainEligibleOffer(pair.filter(it=>it.variant_id!==COLLAGEN_VARIANT)),[regular]);
 assert.throws(()=>assertOfferPair(pair.slice(1)),/Invalid/);
 assert.throws(()=>assertOfferPair(pair.map(it=>it.offerGift?{...it,quantity:2}:it)),/Invalid/);
});
test('operational event retries and revised checkout IDs share the same deduplication key',async()=>{
 const calls=[],root='st_'+'a'.repeat(32),cart={id:root,country:'CA',createdAt:Date.now()};
 await recordOfferEvent(async c=>calls.push(c),cart,'shown');
 await recordOfferEvent(async c=>calls.push(c),{...cart,id:'st_'+'b'.repeat(32),offerCheckoutId:root},'shown');
 assert.equal(calls[0][3],calls[1][3]);assert.ok(calls[0][1].includes("'NX'"));assert.ok(calls[0][1].includes('HINCRBY'));
});

test('checkout API revisions keep both fulfilment units, exact totals, remove together, and lock old payments',async t=>{
 const native=globalThis.fetch,env={...process.env};
 Object.assign(process.env,{STRIPE_SECRET_KEY:'sk_live_offline_mock',STRIPE_WEBHOOK_SECRET:'whsec_offline_mock',SHOPIFY_STORE_DOMAIN:'test.myshopify.com',SHOPIFY_ADMIN_TOKEN:'test',UPSTASH_REDIS_REST_URL:'https://redis.invalid',UPSTASH_REDIS_REST_TOKEN:'test',FLAT_SHIPPING_CENTS:'0'});
 const id='st_'+'c'.repeat(32),cart={id,provider:'stripe',items:[{...collagen,original_price_cents:3199}],country:'CA',displayCurrency:'CAD',scale:100,attribution:{},email:'',createdAt:Date.now(),suggestions:[]};
 const db=new Map([['sess:'+id,JSON.stringify(cart)]]),calls=[];
 const ok=x=>new Response(JSON.stringify(x),{status:200});
 globalThis.fetch=async(url,opts={})=>{
  calls.push(String(url));
  if(url==='https://redis.invalid'){
   const [op,k,...args]=JSON.parse(opts.body);let result=null;
   if(op==='GET')result=db.get(k)||null;
   else if(op==='SET'){if(!args.includes('NX')||!db.has(k)){db.set(k,args[0]);result='OK';}}
   else if(op==='EVAL'){if(args[0]==='2')result=1;else{const key=args[1],token=args[2];if(db.get(key)===token){db.delete(key);result=1;}}}
   else throw Error('Unexpected Redis '+op);
   return ok({result});
  }
  if(String(url).includes('/admin/api/'))return ok({data:{nodes:[product()]}});
  if(String(url).endsWith('/account'))return ok({id:'acct_1UDbyTPw2Aen0E79',charges_enabled:true});
  if(String(url).includes('/country_specs/'))return ok({id:'CA',supported_payment_currencies:['cad','usd']});
  if(String(url).includes('/payment_method_domains'))return ok({data:[]});
  throw Error('Unexpected network '+url);
 };
 t.after(()=>{globalThis.fetch=native;process.env=env;});
 assert.equal((await collagenProbioticOffer(cart)).price,'49.99');
 const next=await reviseCart(id,{addCollagenProbioticOffer:true});
 const withOffer=JSON.parse(db.get('sess:'+next.sessionId));
 assert.equal(withOffer.total,8198);assert.equal(withOffer.quote.chargeCurrency,'CAD');assert.equal(withOffer.quote.chargeMinor,8198);assert.equal(withOffer.items.length,3);
 assertOfferPair(withOffer.items);assert.equal(withOffer.offerCheckoutId,id);
 assert.equal(await collagenProbioticOffer(withOffer),null);
 assert.equal(publicQuote(withOffer).items.filter(it=>it.offerGift).length,1);
 await assert.rejects(()=>prepareStripePayment(id,{confirmedChargeMinor:3199}),/updated/);
 await assert.rejects(()=>reviseCart(next.sessionId,{addCollagenProbioticOffer:true}),/already/);
 const again=await reviseCart(next.sessionId,{promotionCode:'WELCOME20'});
 const discounted=JSON.parse(db.get('sess:'+again.sessionId));assert.equal(discounted.total,6558);assert.equal(discounted.items.find(it=>it.offerGift).price_cents,0);
 const clean=await reviseCart(again.sessionId,{removeCollagenProbioticOffer:true,promotionCode:''});
 const without=JSON.parse(db.get('sess:'+clean.sessionId));assert.equal(without.total,3199);assert.equal(without.items.length,1);
 assert.equal(calls.some(u=>u.includes('/payment_intents')),false,'No payment is created by an offer edit');
 const order=buildStripeOrder(withOffer,{id:'pi_offline',livemode:false},{email:'test@example.invalid',shipping:{country:'CA'},billing:{country:'CA'}});
 assert.ok(order.tags.includes(COLLAGEN_PROBIOTIC_OFFER));assert.equal(order.lineItems.filter(it=>it.variantId.endsWith('/'+PROBIOTIC_VARIANT)).reduce((n,it)=>n+it.quantity,0),2);
 assert.equal(order.customAttributes.find(it=>it.key==='pmp_offer_free_quantity').value,'1');
});

import countries from './square-countries.js';
import crypto from 'node:crypto';
import { createFxQuote, loadDailyRates, assertPayableQuote } from './square-fx.js';
import { deterministicEventId, normalizeEmail, trySendStartedCheckout } from './omnisend.js';
import { orderAttributionAttributes, ga4PersistIntent, ga4TrySend, metaPersistIntent, metaTrySend } from '../api/stripe-webhook.js';

export const BRIDGE_ORIGIN = 'https://checkout.puremajestypet.com';
export const WEBHOOK_URL = 'https://pmp-stripe-bridge.vercel.app/api/square-webhook';
export function squareAccountScope(env=process.env) {
  return crypto.createHash('sha256').update([env.SQUARE_ENV,env.SQUARE_APPLICATION_ID,env.SQUARE_LOCATION_ID].join('|')).digest('hex').slice(0,24);
}
export const squareWebhookKey = () => 'square:webhook:v2:'+squareAccountScope();
export const squareApplePayKey = () => 'square:apple-pay:v2:'+squareAccountScope()+':'+new URL(BRIDGE_ORIGIN).hostname;
export const squareVerificationKey = () => 'square:verification:v2:'+squareAccountScope();
// Fixed configuration checks only: no payment creation or card information.
async function verifySquareWebhook(subscription) {
  const prior=await get(squareVerificationKey());
  if(prior?.squareDeliveryStatus===200 && prior?.invalidSignatureRejected)return;
  if(prior?.checkedAt && Date.now()-prior.checkedAt<60000)return;
  const result={checkedAt:Date.now(),squareDeliveryStatus:null,invalidSignatureRejected:false};
  try {
    const tested=await square('/webhooks/subscriptions/'+encodeURIComponent(subscription.id)+'/test',{event_type:'payment.created'});
    result.squareDeliveryStatus=tested.subscription_test_result?.status_code ?? null;
    const invalid=await fetch(WEBHOOK_URL,{
      method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json','x-square-hmacsha256-signature':'invalid-configuration-probe'},
      body:JSON.stringify({type:'pmp.configuration_probe',data:{}}),signal:AbortSignal.timeout(10000)
    });
    result.invalidSignatureRejected=invalid.status===401;
  } catch { /* Keep the subscription and retry verification on a later quote. */ }
  await set(squareVerificationKey(),result,86400*30);
}
export const validId = value => /^sq_[a-f0-9]{32}$/.test(String(value || ''));
export const moneyScale = code => 10 ** Math.max(2, new Intl.NumberFormat('en', {style:'currency',currency:code}).resolvedOptions().maximumFractionDigits);
export const major = (value, scale = 100) => (value / scale).toFixed(Math.log10(scale));
export async function ensureApplePay(){
 const key=squareApplePayKey();const saved=await get(key);if(saved?.status==='VERIFIED')return saved;
 const result=await square('/apple-pay/domains',{domain_name:new URL(BRIDGE_ORIGIN).hostname});await set(key,result,86400*30);return result;
}
// Explicit restoration requested by the merchant; do not let an obsolete Stripe flag disable Square.
export const activeSquare = () => true;
export function error(message, status = 503) { return Object.assign(new Error(message), {status}); }
export async function redis(command) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {method:'POST',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(8000)});
  const data = await r.json();
  if (!r.ok || data.error) throw error('Checkout storage unavailable');
  return data.result;
}
export async function get(key) { const raw=await redis(['GET',key]); return raw ? JSON.parse(raw) : null; }
export async function set(key,value,ttl=7776000) { const result=await redis(['SET',key,JSON.stringify(value),'EX',String(ttl)]); if(result!=='OK')throw error('Checkout storage unavailable'); }
export async function release(key,token) { return redis(['EVAL',"if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",'1',key,token]); }
export async function square(path, body) {
  const env=process.env.SQUARE_ENV;
  if (!['production','sandbox'].includes(env) || !process.env.SQUARE_ACCESS_TOKEN || !process.env.SQUARE_LOCATION_ID) throw error('Square not configured');
  const host=env==='production'?'https://connect.squareup.com':'https://connect.squareupsandbox.com';
  const r=await fetch(host+'/v2'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+process.env.SQUARE_ACCESS_TOKEN,'Content-Type':'application/json','Square-Version':'2026-08-19'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
  const data=await r.json();
  if(!r.ok) { const e=error('Square: '+(data.errors?.[0]?.code || r.status),r.status>=500?503:422); e.squareErrors=data.errors; e.definitive=r.status>=400 && r.status<500 && r.status!==429; throw e; }
  return data;
}
export async function ensureWebhook() {
  const key=squareWebhookKey();
  const existing=await get(key);
  if(existing?.signature_key){await verifySquareWebhook(existing);return existing;}
  // Fixed destination and stable key: concurrent requests cannot create duplicates.
  const result=await square('/webhooks/subscriptions',{idempotency_key:crypto.createHash('sha256').update(WEBHOOK_URL+squareAccountScope()).digest('hex').slice(0,40),subscription:{name:'PMP Shopify payment confirmation',enabled:true,event_types:['payment.created','payment.updated'],notification_url:WEBHOOK_URL,api_version:'2026-08-19'}});
  if(!result.subscription?.signature_key)throw error('Square webhook setup failed');
  await set(key,result.subscription,315360000);
  await verifySquareWebhook(result.subscription);
  return result.subscription;
}
export async function rates() { return loadDailyRates({readCache:()=>get('square:daily-fx'),writeCache:v=>set('square:daily-fx',v,172800)}); }
export function safeReturnPath(attribution, country) {
  let prefix='';
  try { const u=new URL(attribution.shopify_cart_url || attribution.landing_page || 'https://www.puremajestypet.com'); if(['puremajestypet.com','www.puremajestypet.com'].includes(u.hostname))prefix=u.pathname.match(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/|$)/)?.[0] || ''; } catch {}
  if(!prefix)prefix=({GB:'/en-gb',FR:'/fr-fr',DE:'/de-de',ES:'/es-es',IT:'/it-it',PT:'/pt-pt',AU:'/en-au',CA:'/en-ca'})[country] || '';
  return 'https://www.puremajestypet.com'+prefix+'/pages/thank-you';
}
export async function createSquareQuote(input) {
  await ensureWebhook();
  const {location}=await square('/locations/'+encodeURIComponent(process.env.SQUARE_LOCATION_ID));
  if(location?.currency!=='CAD'||location.status!=='ACTIVE'||!location.capabilities?.includes('CREDIT_CARD_PROCESSING'))throw error('Square card payments unavailable');
  try{await ensureApplePay();}catch(e){console.warn('Apple Pay registration',e.message);}
  const fx=input.displayCurrency==='CAD'?null:await rates();
  const automatic=input.attribution.utm_source?.toLowerCase()==='meta' && input.attribution.utm_medium?.toLowerCase()==='paid_social' && input.attribution.utm_campaign?.toLowerCase()==='liquid_retargeting_product_view';
  const code=String(input.promotionCode || (automatic?'WELCOME20':'')).trim().toUpperCase();
  // Preserve the two active Stripe promotions and the first-order restriction.
  if(code && !['WELCOME20','THANK10'].includes(code))throw error('This promotion code is not available.',400);
  if(code==='THANK10')await assertFirstOrder(input.email);
  const discount=code==='WELCOME20'?0.8:code==='THANK10'?0.9:1;
  const digits=new Intl.NumberFormat('en',{style:'currency',currency:input.displayCurrency}).resolvedOptions().maximumFractionDigits;
  const quantum=input.scale / 10**digits;
  const items=input.items.map(it=>({...it,original_price_cents:Number(it.price_cents),price_cents:code?Math.round(Number(it.price_cents)*discount/quantum)*quantum:Number(it.price_cents)}));
  const subtotal=items.reduce((n,it)=>n+it.price_cents*it.quantity,0);
  // The existing flat shipping configuration is in CAD cents; freeze its display equivalent.
  const shippingCad=Number(process.env.FLAT_SHIPPING_CENTS||0);
  if(!Number.isSafeInteger(shippingCad)||shippingCad<0)throw error('Invalid shipping configuration');
  const rate=input.displayCurrency==='CAD'?1:Number(fx.rates[input.displayCurrency]);
  const shippingDisplay=Math.round(shippingCad/100*rate*input.scale/quantum)*quantum;
  const total=subtotal+shippingDisplay;
  const quote=createFxQuote({displayCurrency:input.displayCurrency,displayAmount:major(total,input.scale),rates:fx});
  const id='sq_'+crypto.randomUUID().replaceAll('-','');
  const cart={...input,locale:input.locale&&input.locale!=='auto'?input.locale:'en',items,quote,id,subtotal,shippingDisplay,total,promotionCode:code,provider:'square',createdAt:Date.now()};
  await set('sess:'+id,cart);
  const checkoutUrl=BRIDGE_ORIGIN+'/square-checkout.html?session_id='+id;
  const eventId=deterministicEventId('begin checkout',id);
  const eventItems=items.map(it=>({item_id:String(it.variant_id),item_name:it.title,price:it.price_cents/input.scale,quantity:it.quantity}));
  let omnisendStarted=false;
  if(input.email) {
    const result=await trySendStartedCheckout({eventID:deterministicEventId('started checkout',id),email:input.email,session:{id,created:Math.floor(cart.createdAt/1000),currency:input.displayCurrency.toLowerCase(),amount_total:Math.round(total/input.scale*100)},cart:{token:input.attribution.shopify_cart_token||id,items:items.map(it=>({...it,price_cents:Math.round(it.price_cents/input.scale*100)}))},abandonedCheckoutURL:checkoutUrl},{timeoutMs:1200});
    omnisendStarted=Boolean(result?.ok);
  }
  return {provider:'square',checkoutUrl,sessionId:id,displayCurrency:input.displayCurrency,currency:input.displayCurrency,amountTotal:Math.round(total/input.scale*100),checkoutLocale:input.locale,omnisendStarted,abandonedCheckoutURL:checkoutUrl,analytics:{beginCheckout:{eventId,currency:input.displayCurrency,value:subtotal/input.scale,items:eventItems}}};
}
export async function captureSquareContact(id,value) {
  if(!validId(id))throw error('Invalid checkout',400);
  const email=normalizeEmail(value);if(!email)throw error('Invalid email',400);
  const cart=await get('sess:'+id);if(!cart)throw error('Checkout expired',410);
  if(await get('done:'+id))return {ok:true};
  if(await get('square:contact:'+id))return {ok:true};
  cart.email=email;await set('sess:'+id,cart);
  const result=await trySendStartedCheckout({eventID:deterministicEventId('started checkout',id),email,session:{id,created:Math.floor(cart.createdAt/1000),currency:cart.displayCurrency.toLowerCase(),amount_total:Math.round(cart.total/cart.scale*100)},cart:{token:cart.attribution.shopify_cart_token||id,items:cart.items.map(it=>({...it,price_cents:Math.round(it.price_cents/cart.scale*100)}))},abandonedCheckoutURL:BRIDGE_ORIGIN+'/square-checkout.html?session_id='+id},{timeoutMs:1200});
  if(result?.ok)await set('square:contact:'+id,true);
  return {ok:true};
}
export function publicQuote(cart) {
  return {countries,successor:cart.supersededBy||null,sessionId:cart.id,quote:cart.quote,items:cart.items.map(it=>({title:it.title,quantity:it.quantity,price:major(it.price_cents,cart.scale),originalPrice:major(it.original_price_cents,cart.scale),variantId:it.variant_id,addon:Boolean(it.addon)})),shipping:major(cart.shippingDisplay,cart.scale),country:cart.country,locale:cart.locale,promotionCode:cart.promotionCode,applicationId:process.env.SQUARE_APPLICATION_ID,locationId:process.env.SQUARE_LOCATION_ID,environment:process.env.SQUARE_ENV,returnUrl:safeReturnPath(cart.attribution,cart.country)};
}
function address(raw) {
  const s=v=>String(v||'').trim().slice(0,200);
  const a={first_name:s(raw?.first_name),last_name:s(raw?.last_name),address_line_1:s(raw?.address_line_1),address_line_2:s(raw?.address_line_2),locality:s(raw?.locality),administrative_district_level_1:s(raw?.administrative_district_level_1),postal_code:s(raw?.postal_code),country:s(raw?.country).toUpperCase()};
  if(!a.first_name||!a.last_name||!a.address_line_1||!a.locality||!a.country.match(/^[A-Z]{2}$/))throw error('Please complete your delivery address.',400);
  return a;
}
export async function paySquare(id, body) {
  if(!validId(id))throw error('Invalid checkout',400);
  const cart=await get('sess:'+id); if(!cart)throw error('Checkout expired',410);
  const done=await get('done:'+id); if(done)return {paid:true,...done};
  const lock='square:pay-lock:'+id, token=crypto.randomUUID();
  if(await redis(['SET',lock,token,'NX','EX','90'])!=='OK')throw error('Payment processing. Please wait.',409);
  try {
    if((await get('sess:'+id))?.supersededBy)throw error('This checkout was updated. Refresh to use the latest total.',409);
    let attempt=await get('square:attempt:'+id);
    // Never resubmit an earlier account's uncertain payment against the new account.
    if(attempt?.request?.location_id && attempt.request.location_id!==process.env.SQUARE_LOCATION_ID)throw error('This payment belongs to the previous checkout account. Contact us before trying another payment.',409);
    if(attempt?.paymentId)return await settleSquarePayment(attempt.paymentId);
    if(!attempt || attempt.failed) {
      assertPayableQuote(cart.quote);
      if(body.confirmedChargeMinor!==cart.quote.chargeMinor)throw error('Please refresh your payment total.',409);
      const email=normalizeEmail(body.email); if(!email)throw error('Please enter a valid email.',400);
      if(cart.promotionCode==='THANK10')await assertFirstOrder(email);
      if(typeof body.sourceId!=='string'||body.sourceId.length>1000||!body.sourceId)throw error('Missing payment token',400);
      const shipping=address(body.shipping), billing=address(body.billing || body.shipping);
      if(shipping.country!==cart.country)throw error('Select your delivery country on the store before paying.',400);
      const request={source_id:body.sourceId,idempotency_key:id+'_'+crypto.createHash('sha256').update(body.sourceId).digest('hex').slice(0,8),location_id:process.env.SQUARE_LOCATION_ID,reference_id:id,amount_money:{amount:cart.quote.chargeMinor,currency:'CAD'},buyer_email_address:email,shipping_address:shipping,billing_address:billing,autocomplete:true,note:'Pure Majesty Pets '+cart.quote.displayAmount+' '+cart.displayCurrency+'; daily FX '+cart.quote.ratePublishedAt};
      if(typeof body.verificationToken==='string'&&body.verificationToken.length<2000)request.verification_token=body.verificationToken;
      attempt={request,email,shipping,billing,createdAt:Date.now()};
      // Persist before calling Square: webhook recovery doesn't depend on this response.
      await set('square:attempt:'+id,attempt);
    }
    let data;
    try { data=await square('/payments',attempt.request); }
    catch(e) { if(e.definitive)await set('square:attempt:'+id,{...attempt,failed:true}); throw e; }
    if(!data.payment?.id)throw error('Payment confirmation pending');
    await set('square:attempt:'+id,{...attempt,paymentId:data.payment.id});
    if(['FAILED','CANCELED'].includes(data.payment.status)){await set('square:attempt:'+id,{...attempt,failed:true});throw error('Payment declined',422);}
    if(data.payment.status!=='COMPLETED')return {paid:false,pending:true};
    return await settleSquarePayment(data.payment.id);
  } finally { await release(lock,token); }
}
const ORDER_QUERY='query SquareExisting($q:String!){orders(first:1,query:$q){nodes{id name legacyResourceId} pageInfo{hasNextPage endCursor}}}';
export const ORDER_MUTATION='mutation SquareOrder($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){orderCreate(order:$order,options:$options){order{id name legacyResourceId totalPriceSet{shopMoney{amount currencyCode} presentmentMoney{amount currencyCode}}} userErrors{field message}}}';
export async function shopify(query,variables) {
  const r=await fetch('https://'+process.env.SHOPIFY_STORE_DOMAIN+'/admin/api/2026-01/graphql.json',{method:'POST',headers:{'X-Shopify-Access-Token':process.env.SHOPIFY_ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(12000)});
  const j=await r.json(); if(!r.ok||j.errors)throw error('Shopify request failed'); return j.data;
}
async function assertFirstOrder(value) {
  const email=normalizeEmail(value);
  if(!email)throw error('Enter your email before applying THANK10.',400);
  const data=await shopify('query FirstOrder($q:String!){orders(first:1,query:$q){nodes{id} pageInfo{hasNextPage endCursor}}}',{q:'email:'+JSON.stringify(email)});
  if(data.orders.nodes.length)throw error('THANK10 is reserved for your first order.',400);
}
// Largest-remainder allocation preserves the exact captured CAD total.
export function allocate(total,weights) {
  const sum=weights.reduce((a,b)=>a+b,0); if(!sum)return weights.map(()=>0);
  const entries=weights.map((w,i)=>{const n=BigInt(total)*BigInt(w);return {i,value:Number(n/BigInt(sum)),remainder:n%BigInt(sum)};});
  let left=total-entries.reduce((n,e)=>n+e.value,0);
  for(const e of [...entries].sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1)) { if(left<=0)break; e.value++; left--; }
  return entries.map(e=>e.value);
}
export function buildOrder(cart,payment,attempt) {
  const cc=cart.displayCurrency,scale=cart.scale;
  const bag=(cad,display)=>({shopMoney:{amount:major(cad),currencyCode:'CAD'},presentmentMoney:{amount:major(display,scale),currencyCode:cc}});
  const allocations=allocate(cart.quote.chargeMinor,[...cart.items.map(it=>it.price_cents*it.quantity),cart.shippingDisplay]);
  // Store the real discount separately so Shopify notifications show savings.
  // Use the frozen checkout amounts, not a new percentage/FX calculation.
  const originals=cart.items.map(it=>Number(it.original_price_cents ?? it.price_cents));
  const discountDisplay=cart.promotionCode?cart.items.reduce((sum,it,i)=>sum+(originals[i]-it.price_cents)*it.quantity,0):0;
  const discountCad=discountDisplay>0?Math.round(discountDisplay/scale/Number(cart.quote.displayUnitsPerCad)*100):0;
  const discountAllocations=allocate(discountCad,cart.items.map((it,i)=>(originals[i]-it.price_cents)*it.quantity));
  const percent={WELCOME20:20,THANK10:10}[cart.promotionCode];
  const discountCode=discountDisplay>0?{itemFixedDiscountCode:{code:cart.promotionCode+(percent?' ('+percent+'% off)':''),amountSet:bag(discountCad,discountDisplay)}}:undefined;
  const lines=[];
  cart.items.forEach((it,i)=>{
    const floor=Math.floor((allocations[i]+discountAllocations[i])/it.quantity), extra=(allocations[i]+discountAllocations[i])%it.quantity;
    for(const [quantity,cad] of [[it.quantity-extra,floor],[extra,floor+1]])if(quantity)lines.push({variantId:'gid://shopify/ProductVariant/'+it.variant_id,quantity,requiresShipping:true,priceSet:bag(cad,discountDisplay>0?originals[i]:it.price_cents),taxable:false,taxLines:[]});
  });
  const addr=a=>({firstName:a.first_name,lastName:a.last_name,address1:a.address_line_1,address2:a.address_line_2||undefined,city:a.locality,...(/^[A-Z0-9]{1,3}$/.test(a.administrative_district_level_1)?{provinceCode:a.administrative_district_level_1}:{province:a.administrative_district_level_1||undefined}),zip:a.postal_code||undefined,countryCode:a.country});
  const attribution=orderAttributionAttributes(cart.attribution);
  const attrs={square_payment_id:payment.id,pmp_square_session:cart.id,pmp_journey_id:cart.attribution.journey_id||'',pmp_payment_currency:'CAD',pmp_payment_amount:major(cart.quote.chargeMinor),pmp_display_currency:cc,pmp_display_amount:cart.quote.displayAmount,pmp_fx_rate:cart.quote.displayUnitsPerCad,pmp_fx_date:cart.quote.ratePublishedAt||'',...attribution.attributes};
  for(const k of ['gclid','gbraid','wbraid','fbclid','fbc','ttclid','msclkid','sccid','shopify_cart_token'])if(cart.attribution[k])attrs[k]=cart.attribution[k];
  return {currency:'CAD',presentmentCurrency:cc,discountCode,email:attempt.email,financialStatus:'PAID',sourceIdentifier:cart.id,test:process.env.SQUARE_ENV==='sandbox',tags:['square','pmp_square',attribution.channel.paid?'attribution_last_paid':'attribution_session'],note:'Payment processed in CAD via Square. Payment: '+payment.id+'. Purchase: '+cart.quote.displayAmount+' '+cc+'. '+(cart.note||''),customAttributes:Object.entries(attrs).filter(([,v])=>v!=null&&v!=='').map(([key,value])=>({key,value:String(value).slice(0,500)})),lineItems:lines,shippingAddress:addr(attempt.shipping),billingAddress:addr(attempt.billing),shippingLines:cart.shippingDisplay?[{title:'Shipping',code:'SQUARE_SHIPPING',priceSet:bag(allocations.at(-1),cart.shippingDisplay),taxLines:[]}]:[],transactions:[{kind:'SALE',status:'SUCCESS',gateway:'Square',authorizationCode:payment.id,amountSet:bag(cart.quote.chargeMinor,cart.total),test:process.env.SQUARE_ENV==='sandbox'}]};
}
export async function settleSquarePayment(paymentId) {
  const {payment}=await square('/payments/'+encodeURIComponent(paymentId));
  if(payment?.status!=='COMPLETED')return {paid:false,pending:true};
  const id=payment.reference_id;
  if(!validId(id))return {ignored:true};
  const cart=await get('sess:'+id), attempt=await get('square:attempt:'+id);
  if(!cart||!attempt)throw error('Payment awaiting order recovery');
  if(payment.location_id!==process.env.SQUARE_LOCATION_ID || payment.amount_money?.currency!=='CAD' || Number(payment.amount_money.amount)!==cart.quote.chargeMinor)throw error('Payment amount mismatch');
  const done=await get('done:'+id);if(done){if(done.paymentId!==payment.id)throw error('Duplicate payment requires reconciliation');return {paid:true,...done};}
  const lock='square:order-lock:'+id, token=crypto.randomUUID();
  if(await redis(['SET',lock,token,'NX','EX','300'])!=='OK')throw error('Order processing',409);
  let ambiguous=false;
  try {
    let order=(await shopify(ORDER_QUERY,{q:'source_identifier:'+id})).orders.nodes[0];
    if(!order){
      ambiguous=true;
      const data=await shopify(ORDER_MUTATION,{order:buildOrder(cart,payment,attempt),options:{sendReceipt:true,sendFulfillmentReceipt:false,inventoryBehaviour:'DECREMENT_OBEYING_POLICY'}});
      if(data.orderCreate.userErrors.length){ambiguous=false;console.error('Square Shopify order rejected',JSON.stringify(data.orderCreate.userErrors));throw error('Order creation pending');}
      order=data.orderCreate.order;
      if(!order)throw error('Order creation pending');
      ambiguous=false;
    }
    const attrs=cart.attribution;
    const gaItems=cart.items.map(it=>({item_id:String(it.variant_id),item_name:it.title,price:it.price_cents/cart.scale,quantity:it.quantity}));
    const ga=await ga4PersistIntent({sessionId:id,itemsValueCents:Math.round(cart.subtotal/cart.scale*100),chargedCents:Math.round(cart.total/cart.scale*100),currency:cart.displayCurrency,gaClientId:attrs.ga_client_id,gaSessionId:attrs.ga_session_id,gaSessionNumber:attrs.ga_session_number,items:gaItems,timestampMicros:Date.parse(payment.created_at)*1000});
    const meta=await metaPersistIntent({sessionId:id,email:attempt.email,value:cart.total/cart.scale,currency:cart.displayCurrency,cart:{...attrs,ua:cart.ua,ip:cart.ip,items:cart.items.map(it=>({...it,price_cents:it.price_cents/cart.scale*100})),external_id:attrs.external_id||attrs.browser_id},address:{country:attempt.shipping.country,city:attempt.shipping.locality,state:attempt.shipping.administrative_district_level_1,postal_code:attempt.shipping.postal_code},name:attempt.shipping.first_name+' '+attempt.shipping.last_name,orderId:order.legacyResourceId||order.id,orderNumber:order.name});
    if(attrs.gclid||attrs.gbraid||attrs.wbraid) {
      await set('square:ads:'+id,{gclid:attrs.gclid,gbraid:attrs.gbraid,wbraid:attrs.wbraid,orderId:id,value:cart.subtotal/cart.scale,currency:cart.displayCurrency,occurredAt:payment.created_at});
      await redis(['SADD','square:ads-pending',id]);
    }
    const result={paymentId:payment.id,orderId:order.legacyResourceId||order.id,orderName:order.name,returnUrl:safeReturnPath(attrs,cart.country)+'?session_id='+id,amount:Math.round(cart.total/cart.scale*100),currency:cart.displayCurrency};
    await set('done:'+id,result);
    // Erase the single-use card token once no longer needed for recovery.
    await set('square:attempt:'+id,{email:attempt.email,shipping:attempt.shipping,billing:attempt.billing,paymentId:payment.id});
    for(const [entry,send] of [[ga,ga4TrySend],[meta,metaTrySend]]) {try{if(entry)await send(entry);}catch{ /* Durable existing outbox owns retries. */ }}
    try { await drainSquareAds(2); } catch {}
    return {paid:true,...result};
  } finally { if(!ambiguous)await release(lock,token); }
}

// Existing Google Ads importer, with a Square-owned durable retry set.
export async function drainSquareAds(limit=10) {
 const {uploadPurchase,adsConfigured}=await import('../api/google-ads-datamanager.js');
 if(!adsConfigured())return {skipped:'not_configured'};
 const ids=await redis(['SRANDMEMBER','square:ads-pending',String(limit)]);
 let sent=0;
 for(const id of ids||[]) {
  const entry=await get('square:ads:'+id);
  if(!entry){await redis(['SREM','square:ads-pending',id]);continue;}
  try {const result=await uploadPurchase(entry);if(result.ok){await redis(['SREM','square:ads-pending',id]);sent++;}}catch{}
 }
 return {sent};
}

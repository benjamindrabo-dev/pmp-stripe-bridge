import crypto from 'node:crypto';
import countries from './square-countries.js';
import {createFxQuote,assertPayableQuote} from './square-fx.js';
import {BRIDGE_ORIGIN,get,set,redis,release,error,rates,major,moneyScale,safeReturnPath,shopify,buildOrder,ORDER_MUTATION,drainSquareAds} from './square-bridge.js';
import {deterministicEventId,normalizeEmail,trySendStartedCheckout} from './omnisend.js';
import {ga4PersistIntent,ga4TrySend,metaPersistIntent,metaTrySend,metaCheckoutStageIntent} from '../api/stripe-webhook.js';
export const PUBLIC_KEY = 'pk_live_51UDbyTPw2Aen0E79n7XAQrQmr2zo91DhJzeuQDFFlOBjrXdklVDKVxejCQyR02JZkRLZYBy9kbRvVrGqIpQ64vJF00WGwxaelk';
export const validId = value => /^st_[a-f0-9]{32}$/.test(String(value||''));
const EXPECTED_ACCOUNT = 'acct_1UDbyTPw2Aen0E79';
let accountCheckedAt=0;
export async function stripe(path, body, idempotencyKey) {
 const key=process.env.STRIPE_SECRET_KEY;
 if(!/^(sk|rk)_live_/.test(key||''))throw error('Stripe configuration unavailable');
 const headers={Authorization:'Bearer '+key,'Stripe-Version':'2026-08-26.dahlia'};
 if(body)headers['Content-Type']='application/x-www-form-urlencoded';
 if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
 const r=await fetch('https://api.stripe.com/v1'+path,{method:body?'POST':'GET',headers,body:body?new URLSearchParams(body).toString():undefined,signal:AbortSignal.timeout(12000)});
 const result=await r.json();
 if(!r.ok){const e=error('Stripe: '+(result.error?.code||result.error?.type||r.status),r.status>=500?503:422);throw e;}
 return result;
}
export async function ensureStripeReady(){
 if(Date.now()-accountCheckedAt<60000)return;
 const a=await stripe('/account');
 if(a.id!==EXPECTED_ACCOUNT||!a.charges_enabled)throw error('Stripe card payments unavailable');
 if(!process.env.STRIPE_WEBHOOK_SECRET)throw error('Stripe webhook not configured');
 accountCheckedAt=Date.now();
}
export async function createStripeQuote(input) {
  await ensureStripeReady();
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
  const id='st_'+crypto.randomUUID().replaceAll('-','');
  const cart={...input,locale:input.locale&&input.locale!=='auto'?input.locale:'en',items,quote,id,subtotal,shippingDisplay,total,promotionCode:code,provider:'stripe',createdAt:Date.now()};
  await set('sess:'+id,cart);
  const checkoutUrl=BRIDGE_ORIGIN+'/square-checkout.html?session_id='+id;
  const eventId=deterministicEventId('begin checkout',id);
  const eventItems=items.map(it=>({item_id:String(it.variant_id),item_name:it.title,price:it.price_cents/input.scale,quantity:it.quantity}));
  let omnisendStarted=false;
  if(input.email) {
    const result=await trySendStartedCheckout({eventID:deterministicEventId('started checkout',id),email:input.email,session:{id,created:Math.floor(cart.createdAt/1000),currency:input.displayCurrency.toLowerCase(),amount_total:Math.round(total/input.scale*100)},cart:{token:input.attribution.shopify_cart_token||id,items:items.map(it=>({...it,price_cents:Math.round(it.price_cents/input.scale*100)}))},abandonedCheckoutURL:checkoutUrl},{timeoutMs:1200});
    omnisendStarted=Boolean(result?.ok);
  }
  return {provider:'square',paymentProvider:'stripe',checkoutUrl,sessionId:id,displayCurrency:input.displayCurrency,currency:input.displayCurrency,amountTotal:Math.round(total/input.scale*100),checkoutLocale:input.locale,omnisendStarted,abandonedCheckoutURL:checkoutUrl,analytics:{beginCheckout:{eventId,currency:input.displayCurrency,value:subtotal/input.scale,items:eventItems}}};
}
export async function captureStripeContact(id,value) {
  if(!validId(id))throw error('Invalid checkout',400);
  const email=normalizeEmail(value);if(!email)throw error('Invalid email',400);
  const cart=await get('sess:'+id);if(!cart)throw error('Checkout expired',410);
  if(await get('done:'+id))return {ok:true};
  if(await get('stripe:contact:'+id))return {ok:true};
  cart.email=email;await set('sess:'+id,cart);
  const result=await trySendStartedCheckout({eventID:deterministicEventId('started checkout',id),email,session:{id,created:Math.floor(cart.createdAt/1000),currency:cart.displayCurrency.toLowerCase(),amount_total:Math.round(cart.total/cart.scale*100)},cart:{token:cart.attribution.shopify_cart_token||id,items:cart.items.map(it=>({...it,price_cents:Math.round(it.price_cents/cart.scale*100)}))},abandonedCheckoutURL:BRIDGE_ORIGIN+'/square-checkout.html?session_id='+id},{timeoutMs:1200});
  if(result?.ok)await set('stripe:contact:'+id,true);
  return {ok:true};
}
export function publicQuote(cart) {
  return {countries,successor:cart.supersededBy||null,sessionId:cart.id,quote:cart.quote,items:cart.items.map(it=>({title:it.title,quantity:it.quantity,price:major(it.price_cents,cart.scale),originalPrice:major(it.original_price_cents,cart.scale),variantId:it.variant_id,addon:Boolean(it.addon)})),shipping:major(cart.shippingDisplay,cart.scale),country:cart.country,locale:cart.locale,promotionCode:cart.promotionCode,publishableKey:PUBLIC_KEY,paymentProvider:'stripe',returnUrl:safeReturnPath(cart.attribution,cart.country)};
}
function address(raw) {
  const s=v=>String(v||'').trim().slice(0,200);
  const a={first_name:s(raw?.first_name),last_name:s(raw?.last_name),address_line_1:s(raw?.address_line_1),address_line_2:s(raw?.address_line_2),locality:s(raw?.locality),administrative_district_level_1:s(raw?.administrative_district_level_1),postal_code:s(raw?.postal_code),country:s(raw?.country).toUpperCase()};
  if(!a.first_name||!a.last_name||!a.address_line_1||!a.locality||!a.country.match(/^[A-Z]{2}$/))throw error('Please complete your delivery address.',400);
  return a;
}
async function assertFirstOrder(value) {
  const email=normalizeEmail(value);
  if(!email)throw error('Enter your email before applying THANK10.',400);
  const data=await shopify('query FirstOrder($q:String!){orders(first:1,query:$q){nodes{id} pageInfo{hasNextPage endCursor}}}',{q:'email:'+JSON.stringify(email)});
  if(data.orders.nodes.length)throw error('THANK10 is reserved for your first order.',400);
}

export async function prepareStripePayment(id,body){
 if(!validId(id))throw error('Invalid checkout',400);
 const key='stripe:pay-lock:'+id,token=crypto.randomUUID();
 if(await redis(['SET',key,token,'NX','EX','90'])!=='OK')throw error('Payment is being prepared.',409);
 try{
  const cart=await get('sess:'+id);if(!cart||cart.provider!=='stripe')throw error('Checkout expired',410);
  if(cart.supersededBy)throw error('This checkout was updated. Refresh the page.',409);
  const done=await get('done:'+id);if(done)return {paid:true,...done};
  if(body.confirmedChargeMinor!==cart.quote.chargeMinor)throw error('Please refresh your payment total.',409);
  const email=normalizeEmail(body.email);if(!email)throw error('Please enter a valid email.',400);
  const shipping=address(body.shipping),billing=address(body.billing||body.shipping);
  if(shipping.country!==cart.country)throw error('Please select the delivery country before paying.',400);
  if(cart.promotionCode==='THANK10')await assertFirstOrder(email);
  let attempt=await get('stripe:attempt:'+id);
  if(attempt?.paymentId){
   const pi=await stripe('/payment_intents/'+encodeURIComponent(attempt.paymentId));
   if(pi.currency!=='cad'||pi.amount!==cart.quote.chargeMinor||pi.metadata?.pmp_checkout_id!==id)throw error('Payment amount mismatch');
   if(['succeeded','processing','requires_capture'].includes(pi.status))return {pending:true};
   if(pi.status==='canceled')throw error('Please return to the store and start a new checkout.',409);
   // Reuse the existing intent after a decline; a second intent could double-charge.
   await set('stripe:attempt:'+id,{...attempt,email,shipping,billing});
   return {clientSecret:pi.client_secret,amount:pi.amount,currency:'CAD'};
  }
  assertPayableQuote(cart.quote);
  const params={amount:String(cart.quote.chargeMinor),currency:'cad','automatic_payment_methods[enabled]':'true',description:'Pure Majesty Pets '+cart.quote.displayAmount+' '+cart.displayCurrency,'metadata[pmp_checkout_id]':id,'metadata[pmp_provider]':'stripe_cad','metadata[pmp_display_currency]':cart.displayCurrency,'metadata[pmp_display_amount]':String(cart.quote.displayAmount),'metadata[pmp_fx_rate]':String(cart.quote.displayUnitsPerCad),receipt_email:email,'shipping[name]':shipping.first_name+' '+shipping.last_name};
  for(const [k,v]of Object.entries({line1:shipping.address_line_1,line2:shipping.address_line_2,city:shipping.locality,state:shipping.administrative_district_level_1,postal_code:shipping.postal_code,country:shipping.country}))if(v)params['shipping[address]['+k+']']=v;
  for(const k of ['shopify_cart_token','journey_id','gclid','gbraid','wbraid'])if(cart.attribution[k])params['metadata['+k+']']=String(cart.attribution[k]).slice(0,500);
  // Persist exactly the request before any network call. Replays use the same
  // body and idempotency key even if the initial API response was lost.
  if(!attempt){attempt={email,shipping,billing,request:params,createdAt:Date.now()};await set('stripe:attempt:'+id,attempt);}
  const pi=await stripe('/payment_intents',attempt.request,id);
  await set('stripe:attempt:'+id,{...attempt,paymentId:pi.id});
  return {clientSecret:pi.client_secret,amount:pi.amount,currency:'CAD'};
 }finally{await release(key,token);}
}
export function buildStripeOrder(cart,payment,attempt){
 const order=buildOrder(cart,{id:payment.id},attempt);
 order.test=payment.livemode===false;
 order.tags=order.tags.filter(t=>!t.includes('square')).concat(['stripe','pmp_stripe_cad']);
 order.note='Payment processed in CAD via Stripe. Payment: '+payment.id+'. Purchase: '+cart.quote.displayAmount+' '+cart.displayCurrency+'. '+(cart.note||'');
 order.customAttributes=order.customAttributes.filter(a=>!['square_payment_id','pmp_square_session'].includes(a.key));
 order.customAttributes.push({key:'stripe_payment_intent',value:payment.id},{key:'pmp_stripe_session',value:cart.id});
 order.transactions=order.transactions.map(t=>({...t,gateway:'Stripe',test:payment.livemode===false}));
 order.shippingLines=order.shippingLines.map(s=>({...s,code:'STRIPE_SHIPPING'}));
 return order;
}
const ORDER_QUERY='query StripeExisting($q:String!){orders(first:1,query:$q){nodes{id name legacyResourceId} pageInfo{hasNextPage endCursor}}}';
export async function settleStripePayment(paymentId,eventCreated) {
  const payment=await stripe('/payment_intents/'+encodeURIComponent(paymentId));
  payment.created_at=new Date((eventCreated||Math.floor(Date.now()/1000))*1000).toISOString();
  if(payment?.status!=='succeeded')return {paid:false,pending:true};
  const id=payment.metadata?.pmp_checkout_id;
  if(!validId(id))return {ignored:true};
  const cart=await get('sess:'+id), attempt=await get('stripe:attempt:'+id);
  if(!cart||!attempt)throw error('Payment awaiting order recovery');
  if(!payment.livemode || cart.provider!=='stripe' || payment.currency!=='cad' || payment.amount!==cart.quote.chargeMinor || payment.amount_received!==cart.quote.chargeMinor || (attempt.paymentId && attempt.paymentId!==payment.id))throw error('Payment amount mismatch');
  const done=await get('done:'+id);if(done){if(done.paymentId!==payment.id)throw error('Duplicate payment requires reconciliation');return {paid:true,...done};}
  const lock='stripe:order-lock:'+id, token=crypto.randomUUID();
  if(await redis(['SET',lock,token,'NX','EX','300'])!=='OK')throw error('Order processing',409);
  let ambiguous=false;
  try {
    let order=(await shopify(ORDER_QUERY,{q:'source_identifier:'+id})).orders.nodes[0];
    if(!order){
      ambiguous=true;
      const data=await shopify(ORDER_MUTATION,{order:buildStripeOrder(cart,payment,attempt),options:{sendReceipt:true,sendFulfillmentReceipt:false,inventoryBehaviour:'DECREMENT_OBEYING_POLICY'}});
      if(data.orderCreate.userErrors.length){ambiguous=false;console.error('Stripe Shopify order rejected',JSON.stringify(data.orderCreate.userErrors));throw error('Order creation pending');}
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
    await set('stripe:attempt:'+id,{email:attempt.email,shipping:attempt.shipping,billing:attempt.billing,paymentId:payment.id});
    for(const [entry,send] of [[ga,ga4TrySend],[meta,metaTrySend]]) {try{if(entry)await send(entry);}catch{ /* Durable existing outbox owns retries. */ }}
    try { await drainSquareAds(2); } catch {}
    return {paid:true,...result};
  } finally { if(!ambiguous)await release(lock,token); }
}


export async function stripeStatus(id){
 if(!validId(id))throw error('Invalid checkout',400);
 let done=await get('done:'+id);
 if(!done){const attempt=await get('stripe:attempt:'+id);if(attempt?.paymentId){try{await settleStripePayment(attempt.paymentId);}catch{}done=await get('done:'+id);}}
 return done?{status:'complete',paid:true,sessionId:id,...done}:{status:'open',paid:false,sessionId:id};
}
export async function captureProgress(id,stage){
 if(!validId(id)||!['details_started','payment_started','payment_info_added'].includes(stage))throw error('Invalid progress event',400);
 const cart=await get('sess:'+id);if(!cart)throw error('Checkout expired',410);
 if(cart.attribution?.marketing_allowed!==true)return {ok:true};
 const key='stripe:progress:'+id+':'+stage;
 if(await get(key))return {ok:true};
 const eventName={details_started:'CheckoutDetailsStarted',payment_started:'PaymentInfoStarted',payment_info_added:'AddPaymentInfo'}[stage];
 const entry=await metaCheckoutStageIntent({sessionId:id+':'+stage,email:cart.email,value:cart.total/cart.scale,currency:cart.displayCurrency,cart:{...cart.attribution,items:cart.items,external_id:cart.attribution.browser_id}},eventName,Date.now());
 await set(key,true);if(entry){try{await metaTrySend(entry);}catch{}}
 return {ok:true};
}

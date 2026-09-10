// Branded embedded checkout. Monetary writes remain separately gated in production.
import {randomUUID} from 'node:crypto';
import {createGoDaddyAssertion} from './godaddy-payments.js';
import {validSession,UUID,fail,liveEnabled,contact,nonceRequest,validateCaptured,submitOnce,createOrderOnce} from './godaddy-embedded-core.js';
import {get,set,redis,shopify,buildOrder,ORDER_MUTATION,rates,major,safeReturnPath,drainSquareAds} from './square-bridge.js';
import {createFxQuote,assertPayableQuote} from './square-fx.js';
import {deterministicEventId,normalizeEmail,trySendStartedCheckout} from './omnisend.js';
import {ga4PersistIntent,ga4TrySend,metaPersistIntent,metaTrySend} from '../api/stripe-webhook.js';
const HOST='https://services.poynt.net';
const BRANCH='prep/godaddy-payments-20260909';
let token=null,expires=0,storeCheckedAt=0;
export function config(){return {businessId:String(process.env.GODADDY_BUSINESS_ID||''),storeId:String(process.env.GODADDY_STORE_ID||''),applicationId:String(process.env.GODADDY_APPLICATION_ID||''),privateKey:String(process.env.GODADDY_PRIVATE_KEY||'').replace(/\\n/g,'\n'),currency:process.env.GODADDY_CHARGE_CURRENCY};}
export const prefix=()=>`godaddy:${process.env.VERCEL_ENV||'local'}:${config().businessId}:`;
export const storage={get:k=>get(prefix()+k),set:(k,v)=>set(prefix()+k,v),reserve:async(k,v)=>(await redis(['SET',prefix()+k,JSON.stringify(v),'NX']))==='OK'};
export function canPrepare(){return (process.env.VERCEL_ENV==='preview'&&process.env.VERCEL_GIT_COMMIT_REF===BRANCH)||liveEnabled();}
async function request(path,body,requestId){
 const c=config();if(!UUID.test(c.businessId)||!UUID.test(c.storeId)||!c.applicationId.startsWith('urn:aid:')||!c.privateKey||c.currency!=='CAD')throw fail('GODADDY_NOT_CONFIGURED',503);
 const allowed=path===`/businesses/${c.businessId}/stores/${c.storeId}`||new RegExp('^/businesses/'+c.businessId+'/transactions/[a-f0-9-]{36}$','i').test(path)||path===`/businesses/${c.businessId}/cards/tokenize/charge`;
 if(!allowed)throw fail('INVALID_PROVIDER_OPERATION',500);
 if(body&&!liveEnabled())throw fail('GODADDY_PAYMENTS_DISABLED',503);
 if(!token||Date.now()>expires-60000){const r=await fetch(HOST+'/token',{method:'POST',redirect:'error',headers:{'api-version':'1.2','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grantType:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:createGoDaddyAssertion(c)}).toString(),signal:AbortSignal.timeout(10000)});if(!r.ok)throw fail('GODADDY_AUTHENTICATION_FAILED',503);const j=await r.json();if(typeof j.accessToken!=='string'||!(Number(j.expiresIn)>0))throw fail('GODADDY_AUTHENTICATION_FAILED',503);token=j.accessToken;expires=Date.now()+Number(j.expiresIn)*1000;}
 const response=await fetch(HOST+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token,'api-version':'1.2','Content-Type':'application/json',...(requestId?{'Poynt-Request-Id':requestId}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw fail('GODADDY_PROVIDER_ERROR',503);if(!response.headers.get('content-type')?.includes('application/json'))throw fail('GODADDY_INVALID_RESPONSE',503);return response.json();
}
async function ensureStore(){if(Date.now()-storeCheckedAt<30000)return;const c=config();const s=await request(`/businesses/${c.businessId}/stores/${c.storeId}`);if(s.id!==c.storeId||s.businessId!==c.businessId||s.currency!=='CAD'||s.status!=='ACTIVE'||s.mockProcessor===true)throw fail('GODADDY_STORE_UNAVAILABLE',503);storeCheckedAt=Date.now();}
async function firstOrder(email){const e=normalizeEmail(email);if(!e)throw fail('EMAIL_REQUIRED_FOR_PROMOTION');const d=await shopify('query GoDaddyFirst($q:String!){orders(first:1,query:$q){nodes{id}}}',{q:'email:'+JSON.stringify(e)});if(d.orders.nodes.length)throw fail('FIRST_ORDER_ONLY');}
export async function createGoDaddyQuote(input){
 if(!canPrepare())throw fail('GODADDY_CHECKOUT_DISABLED',503);await ensureStore();
 if(input.scale!==100)throw fail('CURRENCY_NOT_SUPPORTED');
 const automatic=input.attribution?.utm_source?.toLowerCase()==='meta'&&input.attribution?.utm_medium?.toLowerCase()==='paid_social'&&input.attribution?.utm_campaign?.toLowerCase()==='liquid_retargeting_product_view';
 const code=String(input.promotionCode||(automatic?'WELCOME20':'')).trim().toUpperCase();if(code&&!['WELCOME20','THANK10'].includes(code))throw fail('INVALID_PROMOTION');if(code==='THANK10')await firstOrder(input.email);
 const factor=code==='WELCOME20'?.8:code==='THANK10'?.9:1;
 const items=input.items.map(i=>({...i,original_price_cents:Number(i.price_cents),price_cents:Math.round(Number(i.price_cents)*factor)}));
 const subtotal=items.reduce((s,i)=>s+i.price_cents*i.quantity,0);if(!Number.isSafeInteger(subtotal)||subtotal<1)throw fail('INVALID_TOTAL');
 const fx=input.displayCurrency==='CAD'?null:await rates();const shippingCad=Number(process.env.FLAT_SHIPPING_CENTS||0);if(!Number.isSafeInteger(shippingCad)||shippingCad<0)throw fail('INVALID_SHIPPING',503);
 const rate=input.displayCurrency==='CAD'?1:Number(fx.rates[input.displayCurrency]);if(!Number.isFinite(rate)||rate<=0)throw fail('FX_UNAVAILABLE',503);
 const shippingDisplay=Math.round(shippingCad*rate),total=subtotal+shippingDisplay;
 const quote=createFxQuote({displayCurrency:input.displayCurrency,displayAmount:major(total),rates:fx});
 const id='gd_'+randomUUID().replaceAll('-','');const cart={...input,id,provider:'godaddy',items,quote,subtotal,shippingDisplay,total,promotionCode:code,createdAt:Date.now(),environment:process.env.VERCEL_ENV};
 await storage.set('cart:'+id,cart);
 const origin=process.env.VERCEL_ENV==='preview'?'https://'+process.env.VERCEL_URL:'https://checkout.puremajestypet.com';
 const checkoutUrl=origin+'/godaddy-checkout.html?session_id='+id+'&lang='+encodeURIComponent(input.locale||'en');
 if(process.env.VERCEL_ENV==='production'&&input.email&&input.attribution?.marketing_allowed===true){try{await trySendStartedCheckout({eventID:deterministicEventId('started checkout',id),email:input.email,session:{id,created:Math.floor(Date.now()/1000),currency:input.displayCurrency.toLowerCase(),amount_total:total},cart:{token:input.attribution.shopify_cart_token||id,items},abandonedCheckoutURL:checkoutUrl},{timeoutMs:1200});}catch{}}
 return {provider:'square',paymentProvider:'godaddy',checkoutUrl,sessionId:id,displayCurrency:input.displayCurrency,currency:input.displayCurrency,amountTotal:total,checkoutLocale:input.locale,analytics:{beginCheckout:{eventId:deterministicEventId('begin checkout',id),currency:input.displayCurrency,value:subtotal/100,items:items.map(i=>({item_id:String(i.variant_id),item_name:i.title,quantity:i.quantity,price:i.price_cents/100}))}}};
}
export async function loadCart(id){if(!validSession(id))throw fail('INVALID_SESSION');const cart=await storage.get('cart:'+id);if(!cart||cart.provider!=='godaddy'||cart.environment!==process.env.VERCEL_ENV)throw fail('CHECKOUT_EXPIRED',410);return cart;}
export function publicQuote(cart){const subtotal=cart.items.reduce((s,i)=>s+i.original_price_cents*i.quantity,0);const c=config();return {sessionId:cart.id,currency:cart.displayCurrency,chargeCurrency:'CAD',chargeMinor:cart.quote.chargeMinor,subtotal,discount:subtotal-cart.subtotal,shipping:cart.shippingDisplay,tax:0,total:cart.total,promotionCode:cart.promotionCode,country:cart.country,countries:[cart.country],businessId:c.businessId,applicationId:c.applicationId,paymentsEnabled:liveEnabled()&&!cart.supersededBy,items:cart.items.map(i=>({title:i.title,quantity:i.quantity,unitMinor:i.original_price_cents,image:i.image||null,subtitle:i.price_cents===0?'Bundle gift':''}))};}
export async function prepare(id,body){
 if(!liveEnabled())throw fail('GODADDY_PAYMENTS_DISABLED',503);const cart=await loadCart(id);if(cart.supersededBy)throw fail('CHECKOUT_UPDATED',409);assertPayableQuote(cart.quote);if(body.confirmedChargeMinor!==cart.quote.chargeMinor)throw fail('AMOUNT_CHANGED',409);
 const done=await storage.get('done:'+id);if(done)return {paid:true,...done};if(await storage.get('attempt:'+id))return {pending:true};
 const person=contact(body,cart.country);if(cart.promotionCode==='THANK10')await firstOrder(person.email);
 const draft={...person,preparedId:randomUUID(),amount:cart.quote.chargeMinor,createdAt:Date.now()};await storage.set('prepared:'+id,draft);return {preparedId:draft.preparedId};
}
export async function pay(id,body){
 if(!liveEnabled())throw fail('GODADDY_PAYMENTS_DISABLED',503);const cart=await loadCart(id);if(cart.supersededBy)throw fail('CHECKOUT_UPDATED',409);
 const done=await storage.get('done:'+id);if(done)return {paid:true,...done};const prepared=await storage.get('prepared:'+id);if(!prepared||prepared.preparedId!==body.preparedId||Date.now()-prepared.createdAt>900000)throw fail('PREPARATION_EXPIRED',409);
 await ensureStore();const c=config(),payload=nonceRequest(cart,prepared,body.nonce,c);
 const result=await submitOnce({sessionId:id,prepared,request:payload,store:storage,charge:(body,requestId)=>request(`/businesses/${c.businessId}/cards/tokenize/charge`,body,requestId)});
 if(!result.transactionId)return {pending:true};await redis(['SADD',prefix()+'pending',result.transactionId]);return settle(result.transactionId);
}
export function buildGoDaddyOrder(cart,payment,attempt){const order=buildOrder(cart,{id:payment.id},attempt);order.test=false;order.tags=order.tags.filter(t=>!t.includes('square')).concat(['godaddy','pmp_godaddy']);order.note='Payment processed by GoDaddy Payments in CAD. Transaction: '+payment.id+'. Purchase: '+cart.quote.displayAmount+' '+cart.displayCurrency+'. '+(cart.note||'');order.customAttributes=order.customAttributes.filter(a=>!['square_payment_id','pmp_square_session'].includes(a.key));order.customAttributes.push({key:'godaddy_transaction_id',value:payment.id},{key:'pmp_godaddy_session',value:cart.id});order.transactions=order.transactions.map(t=>({...t,gateway:'GoDaddy Payments',test:false}));order.shippingLines=order.shippingLines.map(s=>({...s,code:'GODADDY_SHIPPING'}));return order;}
export async function settle(transactionId){
 if(process.env.VERCEL_ENV!=='production')throw fail('LIVE_SETTLEMENT_DISABLED_IN_PREVIEW',503);if(!UUID.test(transactionId))throw fail('INVALID_TRANSACTION');const c=config();const payment=await request(`/businesses/${c.businessId}/transactions/${transactionId}`);
 let mapping=await storage.get('transaction:'+transactionId);if(!mapping){const ref=payment.references?.find(r=>r.type==='CUSTOM'&&r.customType==='pmp_checkout'&&validSession(r.id));if(!ref)return {ignored:true};mapping={sessionId:ref.id};}
 const id=mapping.sessionId,cart=await loadCart(id),attempt=await storage.get('attempt:'+id);if(!attempt)throw fail('ATTEMPT_NOT_FOUND',409);if(attempt.transactionId&&attempt.transactionId!==transactionId)throw fail('DUPLICATE_PAYMENT',409);
 const done=await storage.get('done:'+id);if(done){if(done.paymentId!==transactionId)throw fail('DUPLICATE_PAYMENT',409);return {paid:true,...done};}
 if(['DECLINED','VOIDED','REFUNDED'].includes(payment.status))return {paid:false,declined:true};
 validateCaptured(payment,{transactionId,businessId:c.businessId,storeId:c.storeId,amount:cart.quote.chargeMinor});
 const order=await createOrderOnce({sessionId:id,store:storage,lookup:async()=>{const j=await shopify('query GoDaddyExisting($q:String!){orders(first:1,query:$q){nodes{id name legacyResourceId}}}',{q:'source_identifier:'+id});return j.orders.nodes[0]||null;},create:async()=>{const d=await shopify(ORDER_MUTATION,{order:buildGoDaddyOrder(cart,payment,attempt),options:{sendReceipt:true,sendFulfillmentReceipt:false,inventoryBehaviour:'DECREMENT_OBEYING_POLICY'}});if(d.orderCreate.userErrors?.length)throw fail('SHOPIFY_ORDER_REJECTED',409);return d.orderCreate.order;}});
 const result={paymentId:transactionId,orderId:order.legacyResourceId||order.id,orderName:order.name,amount:cart.total,currency:cart.displayCurrency};
 await storage.set('done:'+id,result);await storage.set('transaction:'+transactionId,{sessionId:id});
 // Existing Shopify -> Omnisend purchase sync owns order email automation.
 // Existing durable analytics outboxes own retries; never send personal data without consent.
 if(cart.attribution?.marketing_allowed===true){const a=cart.attribution;try{const ga=await ga4PersistIntent({sessionId:id,itemsValueCents:cart.subtotal,chargedCents:cart.total,currency:cart.displayCurrency,gaClientId:a.ga_client_id,gaSessionId:a.ga_session_id,gaSessionNumber:a.ga_session_number,items:cart.items.map(i=>({item_id:String(i.variant_id),item_name:i.title,quantity:i.quantity,price:i.price_cents/100})),timestampMicros:Date.parse(payment.createdAt||new Date().toISOString())*1000});const meta=await metaPersistIntent({sessionId:id,email:attempt.email,value:cart.total/100,currency:cart.displayCurrency,cart:{...a,ua:cart.ua,ip:cart.ip,items:cart.items,external_id:a.external_id||a.browser_id},address:{country:attempt.shipping.country,city:attempt.shipping.locality,state:attempt.shipping.administrative_district_level_1,postal_code:attempt.shipping.postal_code},name:attempt.shipping.first_name+' '+attempt.shipping.last_name,orderId:result.orderId,orderNumber:result.orderName});for(const [entry,send] of [[ga,ga4TrySend],[meta,metaTrySend]]){try{if(entry)await send(entry);}catch{}}if(a.gclid||a.gbraid||a.wbraid){await set('square:ads:'+id,{gclid:a.gclid,gbraid:a.gbraid,wbraid:a.wbraid,orderId:id,value:cart.subtotal/100,currency:cart.displayCurrency,occurredAt:payment.createdAt});await redis(['SADD','square:ads-pending',id]);try{await drainSquareAds(2);}catch{}}}catch{await storage.set('analytics-reconcile:'+id,{needed:true});}}
 return {paid:true,...result};
}
export async function status(id){const done=await storage.get('done:'+id);if(done)return {paid:true,...done};await loadCart(id);const a=await storage.get('attempt:'+id);return a?.transactionId?settle(a.transactionId):{paid:false,pending:Boolean(a)};}
export async function promotion(id,body){if(!canPrepare())throw fail('CHECKOUT_DISABLED',503);const cart=await loadCart(id);if(cart.supersededBy||await storage.get('attempt:'+id))throw fail('PAYMENT_ALREADY_STARTED',409);const result=await createGoDaddyQuote({...cart,items:cart.items.map(i=>({...i,price_cents:i.original_price_cents})),promotionCode:String(body.code||''),email:normalizeEmail(body.email)||cart.email});cart.supersededBy=result.sessionId;await storage.set('cart:'+id,cart);return publicQuote(await loadCart(result.sessionId));}

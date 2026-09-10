import {randomUUID} from 'node:crypto';
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const validSession=id=>/^gd_[a-f0-9]{32}$/.test(String(id||''));
export function fail(code,status=400){return Object.assign(new Error(code),{code,status});}
// Operator launch authorization, not an assertion of provider review/payout status.
export function liveEnabled(env=process.env){return env.VERCEL_ENV==='production'&&env.PMP_GODADDY_ENABLED==='1'&&env.PMP_GODADDY_LAUNCH_AUTHORIZED==='1'&&env.PMP_GODADDY_ACCEPTANCE_VERIFIED==='1'&&Boolean(env.GODADDY_PRIVATE_KEY)&&UUID.test(env.GODADDY_BUSINESS_ID||'')&&UUID.test(env.GODADDY_STORE_ID||'')&&/^urn:aid:[a-f0-9-]{36}$/i.test(env.GODADDY_APPLICATION_ID||'')&&env.GODADDY_CHARGE_CURRENCY==='CAD';}
const text=(v,max=200)=>typeof v==='string'?v.trim().replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max):'';
export function contact(body,country){
 const email=text(body?.email,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail('INVALID_EMAIL');
 function addr(v){const a={first_name:text(v?.first_name,100),last_name:text(v?.last_name,100),address_line_1:text(v?.address_line_1),address_line_2:text(v?.address_line_2),locality:text(v?.locality,100),administrative_district_level_1:text(v?.administrative_district_level_1,100),postal_code:text(v?.postal_code,20),country:text(v?.country,2).toUpperCase()};if(!a.first_name||!a.last_name||!a.address_line_1||!a.locality||!/^[A-Z]{2}$/.test(a.country))throw fail('INVALID_ADDRESS');if(['US','CA','GB'].includes(a.country)&&!a.postal_code)throw fail('POSTAL_CODE_REQUIRED');if(['US','CA'].includes(a.country)&&!a.administrative_district_level_1)throw fail('REGION_REQUIRED');return a;}
 const shipping=addr(body.shipping),billing=addr(body.billing||body.shipping);if(shipping.country!==country)throw fail('DELIVERY_COUNTRY_MISMATCH');return {email,shipping,billing};
}
export function nonceRequest(cart,prepared,nonce,config){
 if(!validSession(cart?.id)||cart?.quote?.chargeCurrency!=='CAD'||!Number.isSafeInteger(cart?.quote?.chargeMinor)||cart.quote.chargeMinor<1)throw fail('INVALID_SERVER_QUOTE');
 if(!UUID.test(config.businessId)||!UUID.test(config.storeId)||config.currency!=='CAD')throw fail('INVALID_MERCHANT_CONFIGURATION',503);
 if(typeof nonce!=='string'||nonce.length<8||nonce.length>4096||/[\s\u0000-\u001f]/.test(nonce))throw fail('INVALID_NONCE');
 if(!UUID.test(prepared?.preparedId)||prepared.amount!==cart.quote.chargeMinor)throw fail('PREPARATION_MISMATCH',409);
 if(!Number.isFinite(Date.parse(cart.quote.expiresAt))||Date.parse(cart.quote.expiresAt)<=Date.now())throw fail('QUOTE_EXPIRED',409);
 return {action:'SALE',context:{businessId:config.businessId,storeId:config.storeId},amounts:{transactionAmount:cart.quote.chargeMinor,orderAmount:cart.quote.chargeMinor,currency:'CAD'},fundingSource:{nonce},emailReceipt:false,references:[{type:'CUSTOM',customType:'pmp_checkout',id:cart.id}]};
}
export function validateCaptured(transaction,expected){
 if(!UUID.test(transaction?.id)||transaction.context?.businessId!==expected.businessId||transaction.context?.storeId!==expected.storeId||transaction.id!==expected.transactionId)throw fail('TRANSACTION_MISMATCH',409);
 if(transaction.status!=='CAPTURED'||transaction.action!=='SALE'||transaction.voided!==false||transaction.partiallyApproved===true||transaction.actionVoid===true||transaction.reversalVoid===true)throw fail('PAYMENT_NOT_CAPTURED',409);
 if(transaction.amounts?.transactionAmount!==expected.amount||transaction.amounts?.currency!=='CAD')throw fail('AMOUNT_MISMATCH',409);
 if(transaction.context?.businessType==='TEST_MERCHANT'||transaction.processorResponse?.processor==='MOCK')throw fail('TEST_PAYMENT_REJECTED',409);
 return true;
}
/** Reserve permanently before network. A lost response must not create a new charge. */
export async function submitOnce({sessionId,prepared,request,store,charge}){
 if(!validSession(sessionId))throw fail('INVALID_SESSION');
 const existing=await store.get('attempt:'+sessionId);if(existing)return {pending:true,transactionId:existing.transactionId||null};
 const attempt={...prepared,requestId:randomUUID(),state:'SUBMITTING',createdAt:Date.now()};
 if(!await store.reserve('attempt:'+sessionId,attempt))return {pending:true};
 try {const transaction=await charge(request,attempt.requestId);if(!UUID.test(transaction?.id))throw fail('INVALID_PAYMENT_RESPONSE',502);await store.set('attempt:'+sessionId,{...attempt,state:'RECEIVED',transactionId:transaction.id});await store.set('transaction:'+transaction.id,{sessionId});return {transactionId:transaction.id};}
 catch(e){await store.set('attempt:'+sessionId,{...attempt,state:'UNCERTAIN'});throw fail('PAYMENT_RECONCILIATION_REQUIRED',409);}
}
/** Prevent a second Shopify create after a timeout, even if search is eventually consistent. */
export async function createOrderOnce({sessionId,store,lookup,create}){
 const saved=await store.get('order:'+sessionId);if(saved)return saved;
 const found=await lookup(sessionId);if(found){await store.set('order:'+sessionId,found);return found;}
 if(!await store.reserve('order-request:'+sessionId,{createdAt:Date.now()}))throw fail('ORDER_RECONCILIATION_REQUIRED',409);
 const order=await create();if(!order?.id)throw fail('ORDER_RECONCILIATION_REQUIRED',409);await store.set('order:'+sessionId,order);return order;
}

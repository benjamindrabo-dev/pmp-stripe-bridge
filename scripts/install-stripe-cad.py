"""Install the independently routed Stripe/CAD checkout. No keys or live charges in this script."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent

def read(path): return (root / path).read_text()
def write(path, value): (root / path).write_text(value)
def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Expected exactly one occurrence: ' + old[:120])
    return text.replace(old, new, 1)
def between(text, start, end): return text[text.index(start):text.index(end)]

if (root/'lib/stripe-cad-bridge.js').exists():
    raise SystemExit('Stripe CAD files already installed; refusing to overwrite changes.')

square = read('lib/square-bridge.js')
imports = '''import crypto from 'node:crypto';
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
'''
create=between(square,'export async function createSquareQuote(input)', 'export async function captureSquareContact')
start=create.index('  await ensureWebhook();')
end=create.index('  const fx=',start)
create=create[:start]+'  await ensureStripeReady();\n'+create[end:]
create=create.replace('createSquareQuote','createStripeQuote').replace("const id='sq_'", "const id='st_'").replace("provider:'square'", "provider:'stripe'")
# The legacy transport discriminator keeps already-open storefront tabs compatible.
create=create.replace("return {provider:'stripe',checkoutUrl", "return {provider:'square',paymentProvider:'stripe',checkoutUrl")
contact=between(square,'export async function captureSquareContact','export function publicQuote')
contact=contact.replace('captureSquareContact','captureStripeContact').replace("'square:contact:'", "'stripe:contact:'")
public=between(square,'export function publicQuote','function address(raw)')
public=replace_once(public,'applicationId:process.env.SQUARE_APPLICATION_ID,locationId:process.env.SQUARE_LOCATION_ID,environment:process.env.SQUARE_ENV,','publishableKey:PUBLIC_KEY,paymentProvider:\'stripe\',')
address=between(square,'function address(raw)','export async function paySquare')
firstorder=between(square,'async function assertFirstOrder','// Largest-remainder allocation')
prepare='''
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
'''
settle=between(square,'export async function settleSquarePayment','// Existing Google Ads importer')
settle=settle.replace('settleSquarePayment(paymentId)', 'settleStripePayment(paymentId,eventCreated)')
settle=replace_once(settle,"const {payment}=await square('/payments/'+encodeURIComponent(paymentId));", "const payment=await stripe('/payment_intents/'+encodeURIComponent(paymentId));\n  payment.created_at=new Date((eventCreated||Math.floor(Date.now()/1000))*1000).toISOString();")
settle=settle.replace("payment?.status!=='COMPLETED'", "payment?.status!=='succeeded'").replace('payment.reference_id','payment.metadata?.pmp_checkout_id')
settle=settle.replace("'square:attempt:'", "'stripe:attempt:'").replace("'square:order-lock:'", "'stripe:order-lock:'")
settle=replace_once(settle,"if(payment.location_id!==process.env.SQUARE_LOCATION_ID || payment.amount_money?.currency!=='CAD' || Number(payment.amount_money.amount)!==cart.quote.chargeMinor)","if(!payment.livemode || cart.provider!=='stripe' || payment.currency!=='cad' || payment.amount!==cart.quote.chargeMinor || payment.amount_received!==cart.quote.chargeMinor || (attempt.paymentId && attempt.paymentId!==payment.id))")
settle=settle.replace('buildOrder(cart,payment,attempt)','buildStripeOrder(cart,payment,attempt)').replace('Square Shopify order rejected','Stripe Shopify order rejected')
# Reuse the durable Ads outbox importer; its queue name is historical only.
orderquery="const ORDER_QUERY='query StripeExisting($q:String!){orders(first:1,query:$q){nodes{id name legacyResourceId} pageInfo{hasNextPage endCursor}}}';\n"
status='''
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
'''
write('lib/stripe-cad-bridge.js',imports+create+contact+public+address+firstorder+prepare+orderquery+settle+status)

cart=read('lib/square-cart.js')
cart=cart.replace("import {get,set,redis,release,error,validId,shopify,createSquareQuote,moneyScale} from './square-bridge.js';", "import {get,set,redis,release,error,shopify,moneyScale} from './square-bridge.js';\nimport {validId,createStripeQuote} from './stripe-cad-bridge.js';")
cart=cart.replace('createSquareQuote','createStripeQuote').replace("'square:pay-lock:'", "'stripe:pay-lock:'").replace("'square:attempt:'", "'stripe:attempt:'")
write('lib/stripe-cad-cart.js',cart)

write('api/stripe-checkout.js','''import {get,error} from '../lib/square-bridge.js';
import {validId,publicQuote,captureStripeContact,prepareStripePayment,captureProgress,stripeStatus} from '../lib/stripe-cad-bridge.js';
import {reviseCart,suggestions} from '../lib/stripe-cad-cart.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
 const origin=String(req.headers.origin||'');
 if(req.method==='POST'&&origin&&!['https://checkout.puremajestypet.com','https://pmp-stripe-bridge.vercel.app'].includes(origin))return res.status(403).json({error:'Origin not allowed'});
 try{
  const id=req.method==='GET'?req.query?.session_id:req.body?.sessionId;
  if(!validId(id))throw error('Invalid checkout',400);
  const cart=await get('sess:'+id);if(!cart||cart.provider!=='stripe')throw error('Checkout expired',410);
  if(req.method==='GET'){
   if(req.query?.view==='status')return res.status(200).json(await stripeStatus(id));
   if(req.query?.view==='options')return res.status(200).json({suggestions:await suggestions(cart)});
   const done=await get('done:'+id);
   return res.status(200).json({...publicQuote(cart),completed:Boolean(done)});
  }
  const body=req.body||{};
  if(body.action==='prepare')return res.status(200).json(await prepareStripePayment(id,body));
  if(body.action==='contact')return res.status(200).json(await captureStripeContact(id,body.email));
  if(body.action==='progress')return res.status(200).json(await captureProgress(id,body.stage));
  return res.status(200).json(await reviseCart(id,body));
 }catch(e){console.error('Stripe checkout',e.message);return res.status(e.status||503).json({error:e.status&&e.status<500?e.message:'Secure checkout temporarily unavailable. Please refresh.'});}
}
''')

base=read('lib/create-checkout-base.js')
base=replace_once(base,'const { createSquareQuote } = await import("./square-bridge.js");','const createSquareQuote = req.stripeCadMode ? (await import("./stripe-cad-bridge.js")).createStripeQuote : (await import("./square-bridge.js")).createSquareQuote;')
write('lib/create-checkout-base.js',base)
createapi=read('api/create-checkout.js')
createapi=replace_once(createapi,'export default async function handler(req, res) {','export default async function handler(req, res) {\n  if (req.body?.payment_provider === "stripe_cad_preview") { req.squareMode = true; req.stripeCadMode = true; return baseHandler(req,res); }')
createapi=createapi.replace('promo_1U6IEuA0auDoBNzsRt1kuqge','promo_1UDccgPw2Aen0E79qBO3wtV4')
write('api/create-checkout.js',createapi)
webhook=read('api/stripe-webhook.js')
webhook=replace_once(webhook,'    // async_payment_succeeded covers delayed methods (bank debits etc.) that', '''    if(event.type === 'payment_intent.succeeded' && event.data?.object?.metadata?.pmp_provider === 'stripe_cad') {
      const {settleStripePayment}=await import('../lib/stripe-cad-bridge.js');
      await settleStripePayment(event.data.object.id,event.created);
      return res.status(200).json({received:true});
    }
    // async_payment_succeeded covers delayed methods (bank debits etc.) that''')
write('api/stripe-webhook.js',webhook)
ss=read('api/session-status.js')
ss=replace_once(ss,'  if (validId(id)) {', '''  if (/^st_[a-f0-9]{32}$/.test(id)) {
    try { const {stripeStatus}=await import('../lib/stripe-cad-bridge.js');return res.status(200).json(await stripeStatus(id)); }
    catch {return res.status(503).json({error:'Payment verification unavailable'});}
  }
  if (validId(id)) {''')
write('api/session-status.js',ss)
helper=read('api/meta-offer-summary.js')
helper=replace_once(helper,"/^sq_[a-f0-9]{32}$/", "/^(?:sq|st)_[a-f0-9]{32}$/")
write('api/meta-offer-summary.js',helper)

# Keep the exact existing page and its CSS. Add only Stripe SDK permissions.
html=read('public/square-checkout.html')
html=replace_once(html,"script-src 'self'", "script-src 'self' https://js.stripe.com")
html=replace_once(html,"connect-src 'self'", "connect-src 'self' https://api.stripe.com https://*.stripe.com https://r.stripe.com https://m.stripe.network")
html=replace_once(html,"frame-src ", "frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com ")
write('public/square-checkout.html',html)
js=read('public/square-checkout.js')
stripejs=js.replace('/api/square-checkout','/api/stripe-checkout').replace('/api/square-options?session_id=','/api/stripe-checkout?view=options&session_id=').replace('/api/square-pay','/api/stripe-checkout').replace('pmp:square-','pmp:stripe-').replace('/^sq_', '/^st_')
stripejs=replace_once(stripejs,"const walletMethods={};let selectedMethod='card';", "const walletMethods={};let selectedMethod='card',stripeClient,elements;")
a=stripejs.index('async function submit(');b=stripejs.index('function extra()',a)
stripejs=stripejs[:a]+'''async function submit(walletEvent){
 if(busy)return;
 $('cardholder').required=false;
 if(!valid()){if(walletEvent)walletEvent.paymentFailed({reason:'fail'});return;}
 if(Date.now()>=Date.parse(data.quote.expiresAt)){$('status').textContent=t.expired;if(walletEvent)walletEvent.paymentFailed({reason:'fail'});return;}
 setBusy(true);$('status').className='';$('status').textContent=t.processing;
 try{
  const check=await elements.submit();if(check.error)throw Error(check.error.message);
  const shipping=addr(),billing=$('same').checked?shipping:addr('b');
  const result=await json('/api/stripe-checkout',{action:'prepare',sessionId,email:$('email').value,shipping,billing,confirmedChargeMinor:data.quote.chargeMinor});
  if(result.paid&&result.returnUrl){location.assign(result.returnUrl);return;}
  if(result.pending){$('status').textContent=t.pending;await poll();return;}
  if(result.currency!=='CAD'||result.amount!==data.quote.chargeMinor)throw Error('Payment amount changed. Please refresh.');
  trackStage('payment_info_added');
  const name=$('cardholder').value.trim()||billing.first_name+' '+billing.last_name;
  const confirmed=await stripeClient.confirmPayment({elements,clientSecret:result.clientSecret,confirmParams:{return_url:location.origin+'/square-checkout.html?session_id='+sessionId,payment_method_data:{billing_details:{name,email:$('email').value,address:{line1:billing.address_line_1,line2:billing.address_line_2,city:billing.locality,state:billing.administrative_district_level_1,postal_code:billing.postal_code,country:billing.country}}}},redirect:'if_required'});
  if(confirmed.error)throw Error(confirmed.error.message);
  $('status').textContent=t.pending;
  if(await poll())return;
  $('status').textContent=t.pending;
 }catch(e){if(walletEvent)walletEvent.paymentFailed({reason:'fail'});$('status').className='error';$('status').textContent=e.message;setBusy(false);}
}
''' + stripejs[b:]
# After a redirect from bank authentication, verify the existing payment before displaying any pay button.
stripejs=replace_once(stripejs," data=await json('/api/stripe-checkout?session_id='+sessionId);", " data=await json('/api/stripe-checkout?session_id='+sessionId);\n if(new URL(location.href).searchParams.has('payment_intent')){const s=await json('/api/session-status?session_id='+sessionId);if(s.paid&&s.returnUrl){location.assign(s.returnUrl);return;}const rs=new URL(location.href).searchParams.get('redirect_status');if(rs==='succeeded'||rs==='processing'){$('status').textContent=t.pending;await poll();return;}}")
a=stripejs.index(" const script=document.createElement('script');")
b=stripejs.index("\n}catch(e){$('status').className='error';",a)
stripejs=stripejs[:a]+''' const script=document.createElement('script');script.src='https://js.stripe.com/v3/';await new Promise((resolve,reject)=>{script.onload=resolve;script.onerror=()=>reject(Error('Secure payment could not load. Please refresh.'));document.head.append(script);});
 stripeClient=Stripe(data.publishableKey,{locale:data.locale||'auto'});
 elements=stripeClient.elements({mode:'payment',currency:'cad',amount:data.quote.chargeMinor,appearance:{theme:'stripe',variables:{colorPrimary:'#4595c5',colorText:'#111111',colorBackground:'#ffffff',borderRadius:'8px',fontFamily:'Arial, sans-serif',fontSizeBase:'14px',spacingUnit:'4px'},rules:{'.Input':{borderColor:'#dedede'},'.Input:focus':{borderColor:'#4595c5',boxShadow:'0 0 0 1px #4595c5'}}}});
 const cardChoice=document.querySelector('#card-panel')?.parentElement?.querySelector('.method-choice');if(cardChoice)cardChoice.hidden=true;
 $('card').style.lineHeight='normal';
 card=elements.create('payment',{layout:{type:'accordion',defaultCollapsed:false,radios:true,spacedAccordionItems:false},fields:{billingDetails:{name:'never',email:'never',address:'never'}}});
 card.mount('#card');card.on('change',e=>{if(!e.empty)trackStage('payment_started');});
 restoreDraft();$('cardholder').required=false;showSuggestions();
 card.on('ready',()=>setBusy(false));
 card.on('loaderror',()=>{$('status').className='error';$('status').textContent='Secure payment could not load. Please refresh.';});
 $('checkout-form').addEventListener('submit',e=>{e.preventDefault();submit();});
 // Official Stripe wallet buttons, rendered only when actually supported.
 const grid=document.querySelector('.wallet-grid');grid.replaceChildren();
 const express=elements.create('expressCheckout',{buttonHeight:48,buttonTheme:{applePay:'black',googlePay:'black'},layout:{maxColumns:2,maxRows:2},paymentMethods:{amazonPay:'never',paypal:'never'}});
 express.mount(grid);express.on('ready',e=>{$('wallets').hidden=!e.availablePaymentMethods||!Object.values(e.availablePaymentMethods).some(Boolean);});
 express.on('click',e=>{if(valid())e.resolve();else e.reject();});
 express.on('confirm',e=>submit(e));
''' + stripejs[b:]
write('public/stripe-checkout.js',stripejs)
js=replace_once(js,"'use strict';", "'use strict';\nif(/^st_[a-f0-9]{32}$/.test(new URL(location.href).searchParams.get('session_id')||'')){await import('/stripe-checkout.js');return;}")
write('public/square-checkout.js',js)

vc=__import__('json').loads(read('vercel.json'))
vc.setdefault('functions',{})['api/stripe-checkout.js']={'maxDuration':60}
vc['functions']['api/stripe-webhook.js']={'maxDuration':60}
write('vercel.json',__import__('json').dumps(vc,indent=2)+'\n')

write('test/stripe-cad.test.js','''import test from 'node:test';
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
''')
print('Installed Stripe CAD checkout with preview-only routing; no customer traffic switched.')

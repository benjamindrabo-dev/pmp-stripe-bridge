// Explicit Preview-only integration test. Creates anonymous carts and isolated quote records, never payments/orders.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const BRANCH='prep/godaddy-payments-20260909';
export async function run(){
 const report={type:'real-anonymous-Shopify-cart-to-GoDaddy-quote',startedAt:new Date().toISOString(),cases:[],paymentsSubmitted:0,ordersCreated:0,productionRoutingChanged:false};
 if(process.env.VERCEL_ENV!=='preview'||process.env.VERCEL_GIT_COMMIT_REF!==BRANCH)throw Error('PREVIEW_BRANCH_REQUIRED');
 const deployed=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8')).env||{};
 for(const [key,value]of Object.entries(deployed))if(process.env[key]==null)process.env[key]=value;
 if(['PMP_GODADDY_ENABLED','PMP_GODADDY_REVIEW_APPROVED','PMP_GODADDY_ACCEPTANCE_VERIFIED'].some(k=>process.env[k]!=='0'))throw Error('DISABLED_PAYMENTS_REQUIRED');
 const {default:handler}=await import('../api/godaddy-cart.js');
 const {default:paymentHandler}=await import('../api/godaddy-checkout.js');
 const origin='https://'+process.env.VERCEL_URL;
 async function endpoint(body,query,fn=handler){
  let code=200,data;
  const res={setHeader(){},status(n){code=n;return this;},json(v){data=v;return this;},end(){return this;}};
  await fn({method:body?'POST':'GET',headers:{origin,'content-type':'application/json'},body,query:query||{}},res);
  return {code,data};
 }
 async function session(country,locale){
  const jar=new Map();const site='https://www.puremajestypet.com';
  async function request(path,init={}){
   const response=await fetch(site+path,{...init,redirect:'manual',headers:{'User-Agent':'PMP-owned-checkout-QA/1.0',...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...init.headers},signal:AbortSignal.timeout(15000)});
   for(const cookie of response.headers.getSetCookie?.()||[]){const first=cookie.split(';')[0],eq=first.indexOf('=');if(eq>0)jar.set(first.slice(0,eq),first.slice(eq+1));}
   return response;
  }
  await request('/');
  await request('/localization',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({form_type:'localization',_method:'put',country_code:country,language_code:locale,return_to:'/cart'}).toString()});
  await request('/cart');
  return {request};
 }
 const scenarios=[
  {name:'collagen-1-CA',country:'CA',locale:'en',items:[{id:43349565112394,quantity:1}]},
  {name:'collagen-2-plus-yeast-1-CA-FR',country:'CA',locale:'fr',items:[{id:43349565112394,quantity:2},{id:43405787168842,quantity:1}]},
  {name:'four-products-US',country:'US',locale:'en',items:[{id:43349565112394,quantity:1},{id:43405787168842,quantity:1},{id:43660092473418,quantity:1},{id:43449159516234,quantity:1}]},
  {name:'dental-2-plus-ear-1-FR',country:'FR',locale:'fr',items:[{id:43668777631818,quantity:2},{id:43675418656842,quantity:1}]}
 ];
 let firstSession;
 for(const scenario of scenarios){
  const entry={name:scenario.name,country:scenario.country,locale:scenario.locale};report.cases.push(entry);
  try{
   const client=await session(scenario.country,scenario.locale);
   const added=await client.request('/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:scenario.items})});
   entry.cartAddHttp=added.status;if(!added.ok)throw Error('STOREFRONT_CART_ADD_FAILED');
   const cr=await client.request('/cart.js');if(!cr.ok)throw Error('STOREFRONT_CART_READ_FAILED');const cart=await cr.json();
   const result=await endpoint({action:'create',cart,country:scenario.country,locale:scenario.locale});entry.quoteHttp=result.code;
   if(result.code!==200)throw Error(result.data?.code||'QUOTE_FAILED');
   const loaded=await endpoint(null,{session_id:result.data.sessionId});assert.equal(loaded.code,200);
   const q=loaded.data;assert.equal(q.subtotal,cart.total_price);assert.equal(q.subtotal+q.shipping-q.discount,q.total);
   assert.equal(q.items.reduce((n,i)=>n+i.quantity,0),cart.item_count);assert.equal(q.locale,scenario.locale);
   assert.equal(q.currency,cart.currency);assert.equal(q.items.reduce((n,i)=>n+i.lineTotalMinor,0),cart.total_price);
   assert.equal(q.paymentsEnabled,false);assert.ok(q.items.every(i=>i.image?.startsWith('https://')));
   const expected=new Map(scenario.items.map(i=>[i.id,i.quantity]));for(const [variant,quantity]of expected)assert.equal(q.items.filter(i=>i.variantId===variant).reduce((n,i)=>n+i.quantity,0),quantity);
   Object.assign(entry,{passed:true,currency:q.currency,cartSubtotal:cart.total_price,checkoutSubtotal:q.subtotal,shipping:q.shipping,discount:q.discount,total:q.total,chargeCurrency:q.chargeCurrency,chargeMinor:q.chargeMinor,amountDifference:0,itemCount:cart.item_count,productImages:q.items.length,sessionId:q.sessionId});
   if(!firstSession)firstSession=q;
   // Independent customerless cart. Leave real shopper carts untouched.
   await client.request('/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  }catch(e){entry.passed=false;entry.error=/^[A-Z_]+$/.test(e.message||'')?e.message:'ASSERTION_OR_NETWORK_FAILED';}
 }
 if(firstSession){
  let q=firstSession;
  try{
   const opts=await endpoint(null,{session_id:q.sessionId,view:'options'});assert.equal(opts.code,200);assert.equal(opts.data.suggestions.length,1);const offer=opts.data.suggestions[0];
   const add=await endpoint({action:'add-dental',sessionId:q.sessionId});assert.equal(add.code,200);assert.equal(add.data.total,q.total+offer.unitMinor);assert.ok(add.data.items.some(i=>i.variantId===43668777631818&&i.addon));
   report.cases.push({name:'dental-upsell-add',passed:true,before:q.total,added:offer.unitMinor,after:add.data.total});
   const stale=await endpoint({action:'add-dental',sessionId:q.sessionId});assert.notEqual(stale.code,200);
   const remove=await endpoint({action:'remove-dental',sessionId:add.data.sessionId});assert.equal(remove.code,200);assert.equal(remove.data.total,q.total);
   report.cases.push({name:'dental-remove-and-stale-session-rejected',passed:true,restoredTotal:remove.data.total});
   const promo=await endpoint({action:'promotion',sessionId:remove.data.sessionId,code:'WELCOME20'});assert.equal(promo.code,200);
   const expected=remove.data.items.reduce((n,i)=>n+Math.round(i.unitMinor*.8)*i.quantity,0)+remove.data.shipping;
   assert.equal(promo.data.total,expected);report.cases.push({name:'WELCOME20-on-real-quote',passed:true,before:remove.data.total,after:promo.data.total,discount:promo.data.discount});
   const blocked=await endpoint({action:'prepare',sessionId:promo.data.sessionId},null,paymentHandler);assert.equal(blocked.code,503);
   report.cases.push({name:'preview-payment-submission-blocked',passed:true,httpStatus:blocked.code});
  }catch{report.cases.push({name:'upsell-promotion-integration',passed:false,error:'ASSERTION_OR_NETWORK_FAILED'});}
 }
 report.finishedAt=new Date().toISOString();report.passed=report.cases.filter(c=>c.passed).length;report.failed=report.cases.filter(c=>!c.passed).length;
 console.log('GODADDY_REAL_CART_QA '+JSON.stringify(report));
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&process.argv[2]==='--run'){
 try{const report=await run();if(report.failed)process.exitCode=1;}catch{console.log('GODADDY_REAL_CART_QA {"result":"blocked","error":"PREVIEW_TEST_FAILED","paymentsSubmitted":0}');process.exitCode=1;}
}

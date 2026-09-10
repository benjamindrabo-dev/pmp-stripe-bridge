// Explicit Preview-only QA. Anonymous carts + isolated quotes, no payment/order writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compactCart} from '../public/godaddy-cart-snapshot.js';
const BRANCH='prep/godaddy-payments-20260909';
async function run(){
 const report={type:'real-anonymous-Shopify-cart-to-GoDaddy-quote',startedAt:new Date().toISOString(),cases:[],paymentsSubmitted:0,ordersCreated:0,productionRoutingChanged:false};
 if(process.env.VERCEL_ENV!=='preview'||process.env.VERCEL_GIT_COMMIT_REF!==BRANCH)throw Error('PREVIEW_BRANCH_REQUIRED');
 const values=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8')).env||{};
 for(const [k,v]of Object.entries(values))if(process.env[k]==null)process.env[k]=v;
 if(['PMP_GODADDY_ENABLED','PMP_GODADDY_REVIEW_APPROVED','PMP_GODADDY_ACCEPTANCE_VERIFIED'].some(k=>process.env[k]!=='0'))throw Error('DISABLED_PAYMENTS_REQUIRED');
 const {default:handler}=await import('../api/godaddy-cart.js');
 const {default:paymentHandler}=await import('../api/godaddy-checkout.js');
 const {catalog}=await import('../lib/godaddy-cart.js');
 const origin='https://'+process.env.VERCEL_URL;
 async function endpoint(body,query,fn=handler){let code=200,data;const res={setHeader(){},status(n){code=n;return this;},json(v){data=v;return this;},end(){return this;}};await fn({method:body?'POST':'GET',headers:{origin,'content-type':'application/json'},body,query:query||{}},res);return {code,data};}
 async function session(country,path){
  const jar=new Map(),site='https://www.puremajestypet.com';
  async function request(route,init={}){
   const response=await fetch(site+route,{...init,redirect:'manual',headers:{'User-Agent':'PMP-owned-checkout-QA/1.0',...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...init.headers},signal:AbortSignal.timeout(15000)});
   for(const cookie of response.headers.getSetCookie?.()||[]){const first=cookie.split(';')[0],eq=first.indexOf('=');if(eq>0)jar.set(first.slice(0,eq),first.slice(eq+1));}return response;
  }
  await request(path+'/');
  const local=await request('/localization',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({form_type:'localization',_method:'put',country_code:country,return_to:path+'/cart'}).toString()});
  await request(path+'/cart');return {request,localizationHttp:local.status};
 }
 const scenarios=[
  {name:'collagen-1-CA',country:'CA',path:'/en-ca',locale:'en',items:[{id:43349565112394,quantity:1}]},
  {name:'collagen-2-plus-yeast-1-CA-FR',country:'CA',path:'/en-ca',locale:'fr',items:[{id:43349565112394,quantity:2},{id:43405787168842,quantity:1}]},
  {name:'four-products-US',country:'US',path:'',locale:'en',items:[{id:43349565112394,quantity:1},{id:43405787168842,quantity:1},{id:43660092473418,quantity:1},{id:43449159516234,quantity:1}]},
  {name:'dental-2-plus-ear-1-FR',country:'FR',path:'/fr-fr',locale:'fr',items:[{id:43668777631818,quantity:2},{id:43675418656842,quantity:1}]}
 ];
 let first;
 for(const s of scenarios){
  const entry={name:s.name,country:s.country,locale:s.locale};report.cases.push(entry);
  try{
   const client=await session(s.country,s.path);entry.localizationHttp=client.localizationHttp;
   const add=await client.request(s.path+'/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:s.items})});entry.cartAddHttp=add.status;if(!add.ok)throw Error('STOREFRONT_CART_ADD_FAILED');
   const response=await client.request(s.path+'/cart.js');if(!response.ok)throw Error('STOREFRONT_CART_READ_FAILED');const raw=await response.json(),cart=compactCart(raw);entry.cartCurrency=cart.currency;entry.cartTotal=cart.total_price;entry.snapshotBytes=Buffer.byteLength(JSON.stringify(cart));
   const nodes=await catalog(s.items.map(i=>i.id),s.country);entry.catalogCurrencies=[...new Set([...nodes.values()].map(n=>n.contextualPricing?.price?.currencyCode))];
   const created=await endpoint({action:'create',cart,country:s.country,locale:s.locale});entry.quoteHttp=created.code;if(created.code!==200)throw Error(created.data?.code||'QUOTE_FAILED');
   const loaded=await endpoint(null,{session_id:created.data.sessionId});assert.equal(loaded.code,200);const q=loaded.data;
   assert.equal(q.subtotal,cart.total_price);assert.equal(q.subtotal+q.shipping-q.discount,q.total);assert.equal(q.items.reduce((n,i)=>n+i.quantity,0),cart.item_count);assert.equal(q.locale,s.locale);assert.equal(q.currency,cart.currency);assert.equal(q.items.reduce((n,i)=>n+i.lineTotalMinor,0),cart.total_price);assert.equal(q.paymentsEnabled,false);assert.ok(q.items.every(i=>i.image?.startsWith('https://')));
   for(const expected of s.items)assert.equal(q.items.filter(i=>i.variantId===expected.id).reduce((n,i)=>n+i.quantity,0),expected.quantity);
   Object.assign(entry,{passed:true,currency:q.currency,cartSubtotal:cart.total_price,checkoutSubtotal:q.subtotal,shipping:q.shipping,discount:q.discount,total:q.total,chargeCurrency:q.chargeCurrency,chargeMinor:q.chargeMinor,amountDifference:0,itemCount:cart.item_count,productImages:q.items.length,sessionId:q.sessionId});if(!first)first=q;
   await client.request(s.path+'/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  }catch(e){entry.passed=false;entry.error=/^[A-Z_]+$/.test(e.message||'')?e.message:'ASSERTION_OR_NETWORK_FAILED';}
 }
 if(first){try{
  const options=await endpoint(null,{session_id:first.sessionId,view:'options'});assert.equal(options.code,200);assert.equal(options.data.suggestions.length,1);const offer=options.data.suggestions[0];
  const added=await endpoint({action:'add-dental',sessionId:first.sessionId});assert.equal(added.code,200);assert.equal(added.data.total,first.total+offer.unitMinor);assert.ok(added.data.items.some(i=>i.variantId===43668777631818&&i.addon));report.cases.push({name:'dental-upsell-add',passed:true,before:first.total,added:offer.unitMinor,after:added.data.total});
  const stale=await endpoint({action:'add-dental',sessionId:first.sessionId});assert.notEqual(stale.code,200);
  const removed=await endpoint({action:'remove-dental',sessionId:added.data.sessionId});assert.equal(removed.code,200);assert.equal(removed.data.total,first.total);report.cases.push({name:'dental-remove-and-stale-session-rejected',passed:true,restoredTotal:removed.data.total});
  const promo=await endpoint({action:'promotion',sessionId:removed.data.sessionId,code:'WELCOME20'});assert.equal(promo.code,200);assert.equal(promo.data.total,removed.data.items.reduce((n,i)=>n+Math.round(i.unitMinor*.8)*i.quantity,0)+removed.data.shipping);report.cases.push({name:'WELCOME20-on-real-quote',passed:true,before:removed.data.total,after:promo.data.total,discount:promo.data.discount,sessionId:promo.data.sessionId});
  const blocked=await endpoint({action:'prepare',sessionId:promo.data.sessionId},null,paymentHandler);assert.equal(blocked.code,503);report.cases.push({name:'preview-payment-submission-blocked',passed:true,httpStatus:blocked.code});
 }catch{report.cases.push({name:'upsell-promotion-integration',passed:false,error:'ASSERTION_OR_NETWORK_FAILED'});}}
 report.finishedAt=new Date().toISOString();report.passed=report.cases.filter(c=>c.passed).length;report.failed=report.cases.filter(c=>!c.passed).length;console.log('GODADDY_REAL_CART_QA '+JSON.stringify(report));if(report.failed)process.exitCode=1;
}
if(process.argv[2]==='--run')run().catch(()=>{console.log('GODADDY_REAL_CART_QA {"result":"blocked","error":"PREVIEW_TEST_FAILED","paymentsSubmitted":0}');process.exitCode=1;});

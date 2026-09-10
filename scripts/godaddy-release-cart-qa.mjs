// Explicit release-Preview QA: real anonymous carts and quote storage only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compactCart} from '../public/godaddy-cart-snapshot.js';
async function run(){
 const report={type:'release-entry-real-Shopify-carts',startedAt:new Date().toISOString(),cases:[],paymentsSubmitted:0,ordersCreated:0};
 if(process.env.VERCEL_ENV!=='preview'||process.env.VERCEL_GIT_COMMIT_REF!=='release/godaddy-live-20260910')throw Error('PREVIEW_BRANCH_REQUIRED');
 const values=JSON.parse(fs.readFileSync(new URL('../vercel.json',import.meta.url),'utf8')).env||{};
 for(const [k,v]of Object.entries(values))if(process.env[k]==null)process.env[k]=v;
 if(process.env.PMP_GODADDY_ENABLED!=='0')throw Error('DISABLED_PAYMENTS_REQUIRED');
 const {default:entry}=await import('../api/godaddy-entry.js');
 const {default:cartHandler}=await import('../api/godaddy-cart.js');
 const {default:paymentHandler}=await import('../api/godaddy-checkout.js');
 const {buildGoDaddyOrder,loadCart}=await import('../lib/godaddy-embedded.js');
 const origin='https://'+process.env.VERCEL_URL;
 async function endpoint(fn,body,query){let code=200,data;const res={setHeader(){},status(n){code=n;return this;},json(v){data=v;return this;},end(){return this;}};await fn({method:body?'POST':'GET',headers:{origin,'content-type':'application/json'},body,query:query||{}},res);return {code,data};}
 async function session(country,path){
  const jar=new Map(),site='https://www.puremajestypet.com';
  async function request(route,init={}){
   const response=await fetch(site+route,{...init,redirect:'manual',headers:{'User-Agent':'PMP-checkout-QA/1.0',...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...init.headers},signal:AbortSignal.timeout(15000)});
   for(const cookie of response.headers.getSetCookie?.()||[]){const first=cookie.split(';')[0],eq=first.indexOf('=');if(eq>0)jar.set(first.slice(0,eq),first.slice(eq+1));}return response;
  }
  await request(path+'/');
  await request('/localization',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({form_type:'localization',_method:'put',country_code:country,return_to:path+'/cart'}).toString()});
  await request(path+'/cart');return request;
 }
 const scenarios=[
  {name:'collagen-CA',country:'CA',path:'/en-ca',locale:'en',items:[{id:43349565112394,quantity:1}]},
  {name:'collagen-yeast-CA-FR',country:'CA',path:'/en-ca',locale:'fr',items:[{id:43349565112394,quantity:2},{id:43405787168842,quantity:1}]},
  {name:'four-products-US',country:'US',path:'',locale:'en',items:[{id:43349565112394,quantity:1},{id:43405787168842,quantity:1},{id:43660092473418,quantity:1},{id:43449159516234,quantity:1}]},
  {name:'dental-ear-FR',country:'FR',path:'/fr-fr',locale:'fr',items:[{id:43668777631818,quantity:2},{id:43675418656842,quantity:1}]}
 ];
 let first;
 for(const scenario of scenarios){
  const item={name:scenario.name};report.cases.push(item);let request;
  try{
   request=await session(scenario.country,scenario.path);
   const added=await request(scenario.path+'/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:scenario.items})});assert.ok(added.ok);
   const response=await request(scenario.path+'/cart.js');assert.ok(response.ok);const raw=await response.json(),cart=compactCart(raw);
   const created=await endpoint(entry,{pmp_cart:cart,currency:cart.currency,checkout_country:scenario.country,locale:scenario.locale,storefront_root:scenario.path||'/',marketing_allowed:false});
   item.entryStatus=created.code;if(created.code!==200)throw Error(created.data?.code||'ENTRY_FAILED');
   assert.equal(created.data.paymentProvider,'godaddy');assert.equal(created.data.provider,'square');
   const loaded=await endpoint(cartHandler,null,{session_id:created.data.sessionId});assert.equal(loaded.code,200);const q=loaded.data;
   assert.equal(q.subtotal,cart.total_price);assert.equal(q.total,q.subtotal-q.discount+q.shipping);assert.equal(q.items.reduce((n,i)=>n+i.quantity,0),cart.item_count);assert.equal(q.items.reduce((n,i)=>n+i.lineTotalMinor,0),cart.total_price);assert.equal(q.locale,scenario.locale);assert.equal(q.currency,cart.currency);assert.equal(q.paymentsEnabled,false);
   const saved=await loadCart(q.sessionId);
   const address={first_name:'Synthetic',last_name:'Fixture',address_line_1:'Fixture only',locality:'Fixture',administrative_district_level_1:'QC',postal_code:'H0H0H0',country:scenario.country};
   // Pure order payload builder only. This payload is NEVER submitted to Shopify.
   const order=buildGoDaddyOrder(saved,{id:'11111111-1111-4111-8111-111111111111'},{email:'fixture@example.invalid',shipping:address,billing:address});
   assert.equal(order.transactions[0].gateway,'GoDaddy Payments');assert.equal(order.transactions[0].amountSet.shopMoney.currencyCode,'CAD');assert.equal(Math.round(Number(order.transactions[0].amountSet.shopMoney.amount)*100),q.chargeMinor);assert.equal(order.lineItems.reduce((n,i)=>n+i.quantity,0),cart.item_count);
   Object.assign(item,{passed:true,currency:q.currency,cartTotal:cart.total_price,checkoutTotal:q.total,difference:q.subtotal-cart.total_price,chargeMinor:q.chargeMinor,sessionId:q.sessionId,quantity:cart.item_count,orderPayloadOnly:true});if(!first)first=q;
  }catch(e){item.passed=false;item.error=/^[A-Z_]+$/.test(e.message||'')?e.message:'ASSERTION_OR_NETWORK_FAILED';}
  finally{if(request)try{await request(scenario.path+'/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}}
 }
 if(first){
  try{
   const offers=await endpoint(cartHandler,null,{session_id:first.sessionId,view:'options'});assert.equal(offers.code,200);const offer=offers.data.suggestions[0];assert.ok(offer);
   const added=await endpoint(cartHandler,{action:'add-dental',sessionId:first.sessionId});assert.equal(added.code,200);assert.equal(added.data.total,first.total+offer.unitMinor);
   const removed=await endpoint(cartHandler,{action:'remove-dental',sessionId:added.data.sessionId});assert.equal(removed.code,200);assert.equal(removed.data.total,first.total);
   const stale=await endpoint(cartHandler,{action:'add-dental',sessionId:first.sessionId});assert.notEqual(stale.code,200);
   report.cases.push({name:'dental-add-remove-stale-guard',passed:true});
   const promo=await endpoint(cartHandler,{action:'promotion',sessionId:removed.data.sessionId,code:'WELCOME20'});assert.equal(promo.code,200);assert.equal(promo.data.total,Math.round(first.subtotal*.8)+first.shipping);
   report.cases.push({name:'promotion',passed:true,before:first.total,after:promo.data.total});
   const blocked=await endpoint(paymentHandler,{action:'prepare',sessionId:promo.data.sessionId});assert.equal(blocked.code,503);
   report.cases.push({name:'preview-payment-blocked',passed:true});
  }catch(e){report.cases.push({name:'edits-and-payment-guard',passed:false,error:/^[A-Z_]+$/.test(e.code||'')?e.code:'ASSERTION_FAILED'});}
 }
 report.finishedAt=new Date().toISOString();report.passed=report.cases.filter(c=>c.passed).length;report.failed=report.cases.filter(c=>!c.passed).length;console.log('GODADDY_RELEASE_CART_QA '+JSON.stringify(report));if(report.failed)process.exitCode=1;
}
if(process.argv[2]==='--run')run().catch(()=>{console.log('GODADDY_RELEASE_CART_QA {"result":"blocked","paymentsSubmitted":0,"ordersCreated":0}');process.exitCode=1;});

// Anonymous public carts and real checkout navigation. Never enters card data,
// sends monetary requests, reads account information, or prints cookies/secrets.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const SITE='https://www.puremajestypet.com',BRIDGE='https://pmp-stripe-bridge.vercel.app';
const report={at:new Date().toISOString(),test:'discounted-cart-native-Buy-Now',cartMocked:false,sdkMocked:false,monetaryRequests:0,ordersCreated:0,cases:[]};
let published=false;
for(let n=0;n<20;n++){
 try{const r=await fetch(BRIDGE+'/api/meta-offer-summary.js',{signal:AbortSignal.timeout(10000),cache:'no-store'});if((await r.text()).includes('Preserve Shopify discount identifiers')){published=true;break;}}catch{}
 await new Promise(resolve=>setTimeout(resolve,3000));
}
assert.ok(published,'PATCH_NOT_PUBLISHED');
const browser=await chromium.launch({headless:true});
const cases=[{name:'US-collagen-WELCOME20',country:'US',root:'',quantity:1,discount:'WELCOME20',width:1440},{name:'CA-bundle-WELCOME20',country:'CA',root:'/en-ca',quantity:5,discount:'WELCOME20',width:390},{name:'US-regular-control',country:'US',root:'',quantity:1,width:1440}];
for(const s of cases){
 const out={name:s.name,country:s.country,width:s.width,passed:false,responses:[]};report.cases.push(out);
 const ctx=await browser.newContext({locale:'en-CA',viewport:{width:s.width,height:1000}});
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(req.method()==='POST'&&(u.pathname==='/api/godaddy-checkout'||/\/cards\/tokenize\/charge|\/payments$|\/payment_intents(?:\/|$)/.test(u.pathname)))return route.abort('blockedbyclient');
  return route.continue();
 });
 const page=await ctx.newPage();
 page.on('response',async r=>{try{const u=new URL(r.url());if(u.pathname==='/api/create-checkout'&&r.request().method()==='POST'){const d=await r.json();out.responses.push({status:r.status(),code:d.code||null,provider:d.paymentProvider||null,checkoutTotal:d.amountTotal,currency:d.currency});}}catch{}});
 try{
  await page.goto(SITE+s.root+'/',{waitUntil:'domcontentloaded',timeout:45000});
  await ctx.request.post(SITE+'/localization',{form:{form_type:'localization',_method:'put',country_code:s.country,return_to:s.root+'/cart'},maxRedirects:3});
  await page.goto(SITE+s.root+'/cart',{waitUntil:'domcontentloaded',timeout:45000});
  const a=await ctx.request.post(SITE+s.root+'/cart/add.js',{data:{items:[{id:43349565112394,quantity:s.quantity}]}});assert.ok(a.ok(),'CART_ADD_FAILED');
  if(s.discount){const d=await ctx.request.post(SITE+s.root+'/cart/update.js',{data:{discount:s.discount}});assert.ok(d.ok(),'DISCOUNT_APPLY_FAILED');}
  const raw=await(await ctx.request.get(SITE+s.root+'/cart.js')).json();
  out.cartTotal=raw.total_price;out.currency=raw.currency;out.quantity=raw.item_count;
  if(s.discount){out.discountMinor=(raw.cart_level_discount_applications||[]).filter(d=>d.type==='discount_code'&&d.title.toUpperCase()===s.discount).reduce((n,d)=>n+d.total_allocated_amount,0);assert.ok(out.discountMinor>0,'DISCOUNT_NOT_PRESENT');}
  await page.goto(SITE+s.root+'/cart',{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);
  for(const name of [/reject all/i,/decline/i,/necessary only/i]){try{const b=page.getByRole('button',{name}).first();if(await b.isVisible())await b.click({timeout:1000});}catch{}}
  await page.getByRole('button',{name:/^buy now$/i}).first().click({timeout:10000});
  await page.waitForURL(u=>['checkout.puremajestypet.com','pmp-stripe-bridge.vercel.app'].includes(u.hostname)&&/^gd_[a-f0-9]{32}$/.test(u.searchParams.get('session_id')||''),{timeout:60000});
  const u=new URL(page.url());out.redirected=true;out.checkoutPath=u.pathname;
  const response=await ctx.request.get(u.origin+'/api/godaddy-cart?session_id='+encodeURIComponent(u.searchParams.get('session_id')));assert.ok(response.ok(),'QUOTE_READ_FAILED');const quote=await response.json();
  assert.equal(quote.subtotal,raw.total_price,'CART_TOTAL_MISMATCH');assert.equal(quote.currency,raw.currency);assert.equal(quote.items.reduce((n,i)=>n+i.quantity,0),raw.item_count);assert.equal(quote.paymentsEnabled,true);
  out.checkoutTotal=quote.total;out.difference=quote.subtotal-raw.total_price;
  await page.waitForFunction(()=>document.querySelector('#card-element')?.dataset.sdkReady==='true',null,{timeout:30000});
  await page.waitForFunction(()=>document.querySelector('#pay')?.disabled===false,null,{timeout:30000});
  out.displayTotal=await page.locator('#summary-total').textContent();out.chargeNotice=await page.locator('#charge-note').textContent();out.payEnabled=await page.locator('#pay').isEnabled();
  assert.equal(out.responses.at(-1)?.status,200);assert.equal(out.responses.at(-1)?.provider,'godaddy');
  out.passed=true;
 }catch(error){out.error=error.name==='TimeoutError'?'BROWSER_TIMEOUT':String(error.message).replace(/https?:\/\/[^\s]+/g,'[URL]').slice(0,150);out.path=new URL(page.url()).pathname;}
 finally{try{await ctx.request.post(SITE+s.root+'/cart/clear.js',{data:{}});}catch{}await ctx.close();}
 console.log('GODADDY_CART_CLICK_CASE '+JSON.stringify(out));
}
await browser.close();report.finishedAt=new Date().toISOString();report.passed=report.cases.every(c=>c.passed);fs.mkdirSync('artifacts/godaddy-cart-click',{recursive:true});fs.writeFileSync('artifacts/godaddy-cart-click/result.json',JSON.stringify(report,null,2));
console.log('GODADDY_CART_CLICK_DIAGNOSTIC '+JSON.stringify(report));if(!report.passed)process.exitCode=1;

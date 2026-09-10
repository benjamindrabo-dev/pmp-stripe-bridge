// Real public cart, native checkout button, bridge HTTP and hosted GoDaddy SDK.
// This script NEVER enters card data or allows payment submission. No customer
// account, private key, bank detail, request header or cookie is written to logs.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const SITE='https://www.puremajestypet.com';
const CHECKOUT='https://checkout.puremajestypet.com';
const report={startedAt:new Date().toISOString(),test:'production-native-button-to-godaddy',cartMocked:false,sdkMocked:false,paymentRequestsBlocked:true,cardDataEntered:false,paymentsSubmitted:0,ordersCreated:0,cases:[]};
const scenarios=[
 {name:'canada-collagen',country:'CA',root:'/en-ca',items:[{id:43349565112394,quantity:1}],width:1440},
 {name:'us-four-products',country:'US',root:'',items:[{id:43349565112394,quantity:1},{id:43405787168842,quantity:1},{id:43660092473418,quantity:1},{id:43449159516234,quantity:1}],width:390}
];
let browser;
try{
 let active=false;
 for(let i=0;i<36;i++){
  try{const r=await fetch(CHECKOUT+'/api/godaddy-health',{signal:AbortSignal.timeout(10000)});const h=await r.json();if(h.launchEnabled===true&&h.newCheckoutRouting==='godaddy'&&h.apiAccessVerified===true&&h.webhookConfigurationVerified===true){active=true;report.health=h;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,5000));
 }
 if(!active)throw Error('LAUNCH_NOT_ACTIVE');
 browser=await chromium.launch({headless:true});
 for(const scenario of scenarios){
  const result={name:scenario.name,country:scenario.country,width:scenario.width,passed:false};report.cases.push(result);
  const context=await browser.newContext({viewport:{width:scenario.width,height:1000},locale:'en-US'});
  // Browser context never has payment credentials. Refuse every monetary endpoint
  // even if a storefront script accidentally attempts to submit a payment.
  await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(req.method()==='POST'&&((u.pathname==='/api/godaddy-checkout')||/\/cards\/tokenize\/charge|\/payments$|\/payment_intents(?:\/|$)/.test(u.pathname))){result.blockedMonetaryRequest=true;return route.abort('blockedbyclient');}return route.continue();});
  const page=await context.newPage();
  let bridgeResponse=null;
  page.on('response',async response=>{try{const u=new URL(response.url());if(u.pathname==='/api/create-checkout'&&response.request().method()==='POST'){const data=await response.json();bridgeResponse={status:response.status(),provider:data.paymentProvider||null,sessionId:data.sessionId||null,amountTotal:data.amountTotal,currency:data.currency,code:data.code||null};}}catch{}});
  try{
   result.stage='load-store';
   await page.goto(SITE+scenario.root+'/',{waitUntil:'domcontentloaded',timeout:60000});
   await context.request.post(SITE+'/localization',{form:{form_type:'localization',_method:'put',country_code:scenario.country,return_to:scenario.root+'/cart'},maxRedirects:3});
   await page.goto(SITE+scenario.root+'/cart',{waitUntil:'domcontentloaded',timeout:60000});
   const add=await context.request.post(SITE+scenario.root+'/cart/add.js',{data:{items:scenario.items}});
   result.cartAddStatus=add.status();assert.ok(add.ok(),'CART_ADD_FAILED');
   const raw=await (await context.request.get(SITE+scenario.root+'/cart.js')).json();
   result.cartCurrency=raw.currency;result.cartTotalMinor=raw.total_price;result.cartQuantity=raw.item_count;
   await page.goto(SITE+scenario.root+'/cart',{waitUntil:'domcontentloaded',timeout:60000});
   await page.waitForTimeout(2000);
   for(const label of [/reject all/i,/decline/i,/necessary only/i]){try{const button=page.getByRole('button',{name:label}).first();if(await button.isVisible())await button.click({timeout:1500});}catch{}}
   result.stage='native-checkout-button';
   const candidates=[page.locator('button[name="checkout"]'),page.locator('input[name="checkout"]'),page.locator('#checkout'),page.getByRole('button',{name:/^(check out|checkout|proceed to checkout|secure checkout|passer à la caisse|paiement)$/i}),page.locator('a[href$="/checkout"]')];
   let button;
   for(const candidate of candidates){for(let i=0;i<await candidate.count();i++){const item=candidate.nth(i);if(await item.isVisible()&&await item.isEnabled()){button=item;break;}}if(button)break;}
   if(!button){result.visibleButtons=await page.locator('button:visible').allTextContents();result.visibleButtons=result.visibleButtons.map(t=>t.trim().slice(0,70)).slice(0,12);throw Error('CHECKOUT_BUTTON_NOT_FOUND');}
   result.clickedLabel=(await button.textContent()||await button.getAttribute('value')||'').trim().slice(0,80);
   await button.click({timeout:15000});
   result.stage='checkout-navigation';
   await page.waitForURL(u=>['checkout.puremajestypet.com','pmp-stripe-bridge.vercel.app'].includes(u.hostname)&&/^gd_[a-f0-9]{32}$/.test(u.searchParams.get('session_id')||''),{timeout:90000});
   result.bridge=bridgeResponse;
   const u=new URL(page.url());result.checkoutPath=u.pathname;result.sessionId=u.searchParams.get('session_id');
   assert.equal(bridgeResponse?.status,200,'BRIDGE_FAILED');assert.equal(bridgeResponse.provider,'godaddy','WRONG_PROCESSOR');
   result.stage='render-live-quote';
   await page.waitForFunction(()=>document.querySelectorAll('#items .product').length>0,{timeout:30000});
   const qResponse=await context.request.get(u.origin+'/api/godaddy-cart?session_id='+encodeURIComponent(result.sessionId));assert.ok(qResponse.ok());const q=await qResponse.json();
   assert.equal(q.currency,raw.currency);assert.equal(q.subtotal,raw.total_price);assert.equal(q.items.reduce((n,i)=>n+i.quantity,0),raw.item_count);assert.equal(q.total,q.subtotal-q.discount+q.shipping+q.tax);assert.equal(q.paymentsEnabled,true);
   for(const expected of scenario.items)assert.equal(q.items.filter(i=>Number(i.variantId)===expected.id).reduce((n,i)=>n+i.quantity,0),expected.quantity);
   result.checkoutTotalMinor=q.total;result.cartDifferenceMinor=q.subtotal-raw.total_price;result.chargeCurrency=q.chargeCurrency;result.chargeMinor=q.chargeMinor;result.products=q.items.map(i=>({variantId:i.variantId,quantity:i.quantity,lineTotalMinor:i.lineTotalMinor}));
   const rendered=await page.locator('#items .product').count();assert.equal(rendered,q.items.length);
   await page.waitForFunction(()=>document.querySelector('#card-element')?.dataset.sdkReady==='true',{timeout:40000});
   result.sdkReady=true;result.cardFrameVisible=await page.locator('#card-element iframe').first().isVisible();assert.equal(result.cardFrameVisible,true);
   result.payEnabled=await page.locator('#pay').isEnabled();assert.equal(result.payEnabled,true);
   result.chargeNotice=await page.locator('#charge-note').textContent();assert.equal(result.chargeNotice,'Will be charged in CAD');
   result.totalVisible=await page.locator('#summary-total').textContent();result.payButton=await page.locator('#pay-label').textContent();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   // Measure dental add/remove on the real quote, not a fake JSON response.
   if(scenario.country==='CA'){
    const addButton=page.locator('[data-action="add-dental"]');await addButton.waitFor({state:'visible',timeout:20000});await addButton.click();
    await page.waitForFunction(()=>document.querySelectorAll('.remove-addon').length===1,{timeout:60000});
    result.dentalAdded=true;await page.locator('.remove-addon').click();
    await page.waitForFunction(()=>document.querySelectorAll('.remove-addon').length===0,{timeout:60000});
    assert.equal(await page.locator('#summary-total').textContent(),result.totalVisible);result.dentalRemovedTotalRestored=true;
   }
   result.passed=true;result.stage='complete';
   fs.mkdirSync('artifacts/godaddy-launch',{recursive:true});await page.screenshot({path:'artifacts/godaddy-launch/'+scenario.name+'.png',fullPage:true});
  }catch(error){result.error=/^[A-Z_]+$/.test(error.message||'')?error.message:((error.name||'')==='TimeoutError'?'BROWSER_TIMEOUT':'ASSERTION_FAILED');try{const u=new URL(page.url());result.stoppedAt=u.origin+u.pathname;result.statusText=(await page.locator('#status').textContent({timeout:1000})||'').slice(0,180);result.bridge=bridgeResponse;}catch{}}
  finally{try{await context.request.post(SITE+scenario.root+'/cart/clear.js',{data:{}});}catch{}await context.close();}
 }
}catch(error){report.error=/^[A-Z_]+$/.test(error.message||'')?error.message:'SMOKE_TEST_FAILED';}
finally{
 if(browser)await browser.close();report.finishedAt=new Date().toISOString();report.passed=report.cases.length===scenarios.length&&report.cases.every(c=>c.passed);fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/godaddy-production-browser-smoke-20260910.json',JSON.stringify(report,null,2)+'\n');console.log('GODADDY_PRODUCTION_BROWSER_SMOKE '+JSON.stringify(report));if(!report.passed)process.exitCode=1;
}

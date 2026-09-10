// Real anonymous Shopify carts and GoDaddy UI. No card entry, charge, order,
// payout, customer account, secret, cookie or authorization header is logged.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const SITE='https://www.puremajestypet.com',HOST='https://checkout.puremajestypet.com';
const TEST=43866373914698,COLLAGEN=43349565112394;
const roots={US:'',CA:'/en-ca',FR:'/fr-fr'};
const report={testedAt:new Date().toISOString(),testVariant:TEST,cartMocked:false,sdkMocked:false,paymentsSubmitted:0,ordersCreated:0,cardDataEntered:false,cases:[]};
let browser;
async function anonymousCart(context,country,items){
 const root=roots[country],product=SITE+root+'/products/test?variant='+TEST;
 await context.request.get(product);
 const localized=await context.request.post(SITE+'/localization',{form:{form_type:'localization',_method:'put',country_code:country,return_to:root+'/cart'},maxRedirects:3});
 assert.ok(localized.status()<400,'LOCALIZATION_FAILED_'+localized.status());
 await context.request.post(SITE+root+'/cart/clear.js',{data:{},headers:{Referer:product}});
 const add=await context.request.post(SITE+root+'/cart/add.js',{data:{items},headers:{Referer:product}});
 if(!add.ok()){
  let error={};try{error=await add.json();}catch{}
  throw Error('CART_ADD_'+add.status()+':'+String(error.description||error.message||'No JSON description').slice(0,200));
 }
 const response=await context.request.get(SITE+root+'/cart.js');assert.ok(response.ok(),'CART_READ_FAILED_'+response.status());
 return response.json();
}
try{
 let published=false;
 for(let i=0;i<24;i++){
  const response=await fetch(HOST+'/godaddy-checkout.js',{signal:AbortSignal.timeout(10000)});const text=await response.text();
  if(response.ok&&text.includes("action:'change-country'")){published=true;break;}
  await new Promise(r=>setTimeout(r,5000));
 }
 assert.ok(published,'COUNTRY_UI_NOT_DEPLOYED');
 browser=await chromium.launch({headless:true});
 for(const scenario of [
  {name:'exact-test-product',items:[{id:TEST,quantity:1}],countries:['CA','FR','US'],width:1440},
  {name:'test-plus-collagen-mobile',items:[{id:TEST,quantity:1},{id:COLLAGEN,quantity:1}],countries:['CA','US'],width:390}
 ]){
  const item={name:scenario.name,passed:false,countryChanges:[]};report.cases.push(item);
  const context=await browser.newContext({viewport:{width:scenario.width,height:1000},locale:'en-US'});
  await context.route('**/*',async route=>{
   const request=route.request(),u=new URL(request.url());
   if(request.method()==='POST'&&(u.pathname==='/api/godaddy-checkout'||/\/cards\/tokenize\/charge|\/payments$|\/payment_intents(?:\/|$)/.test(u.pathname))){item.paymentRequestBlocked=true;return route.abort();}
   return route.continue();
  });
  const page=await context.newPage();
  try{
   item.stage='product-and-cart';
   const product=await page.goto(SITE+'/products/test?variant='+TEST,{waitUntil:'domcontentloaded',timeout:60000});item.productHttp=product.status();
   // Stop page-side locale initialization before controlled anonymous cart setup.
   // The actual cart button and all checkout calls below remain unmodified.
   await page.goto('about:blank');
   const cart=await anonymousCart(context,'US',scenario.items);
   item.sourceCurrency=cart.currency;item.sourceTotal=cart.total_price;
   await page.goto(SITE+'/cart',{waitUntil:'domcontentloaded',timeout:60000});
   await page.waitForTimeout(1800);
   for(const label of [/reject all/i,/decline/i,/necessary only/i]){try{const b=page.getByRole('button',{name:label}).first();if(await b.isVisible())await b.click({timeout:1000});}catch{}}
   item.stage='native-cart-action';
   const buttons=page.getByRole('button',{name:/^(buy now|check out|checkout|proceed to checkout|secure checkout)$/i});
   let button;for(let i=0;i<await buttons.count();i++){const b=buttons.nth(i);if(await b.isVisible()&&await b.isEnabled()){button=b;break;}}
   assert.ok(button,'CART_BUTTON_NOT_FOUND');
   const entry=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/create-checkout'&&r.request().method()==='POST',{timeout:65000});
   await button.click();const response=await entry;const data=await response.json();
   item.entryStatus=response.status();item.entryCode=data.code||null;assert.equal(response.status(),200,data.code||'CHECKOUT_CREATE_FAILED');assert.equal(data.paymentProvider,'godaddy');
   await page.waitForURL(u=>u.hostname==='checkout.puremajestypet.com'&&/^gd_/.test(u.searchParams.get('session_id')||''),{timeout:30000});
   await page.waitForFunction(()=>document.querySelector('#card-element')?.dataset.sdkReady==='true'&&document.querySelector('#country')?.disabled===false&&document.querySelector('#pay')?.disabled===false,null,{timeout:40000});
   let id=new URL(page.url()).searchParams.get('session_id');
   const initial=await(await context.request.get(HOST+'/api/godaddy-cart?session_id='+id)).json();
   assert.equal(initial.total,cart.total_price);assert.equal(initial.currency,cart.currency);assert.ok(initial.items.some(i=>i.variantId===TEST));
   item.testVariantVisible=true;item.initialPayEnabled=await page.locator('#pay').isEnabled();item.initialCountryEnabled=await page.locator('#country').isEnabled();
   for(const country of scenario.countries){
    item.stage='change-country-'+country;
    const comparator=await browser.newContext();let expected;
    try{expected=await anonymousCart(comparator,country,scenario.items);}finally{await comparator.request.post(SITE+roots[country]+'/cart/clear.js',{data:{}}).catch(()=>{});await comparator.close();}
    const nextResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/godaddy-cart'&&r.request().method()==='POST',{timeout:65000});
    const oldId=id;await page.locator('#country').selectOption(country);
    const result=await nextResponse,q=await result.json();
    const measured={country,status:result.status(),code:q.code||null,expectedTotal:expected.total_price,currency:q.currency,total:q.total,chargeCurrency:q.chargeCurrency,chargeMinor:q.chargeMinor};item.countryChanges.push(measured);
    assert.equal(result.status(),200,q.code||'COUNTRY_CHANGE_FAILED');assert.equal(q.country,country);assert.equal(q.currency,expected.currency);assert.equal(q.total,expected.total_price);assert.equal(q.chargeCurrency,'CAD');
    for(const line of scenario.items)assert.equal(q.items.filter(i=>i.variantId===line.id).reduce((n,i)=>n+i.quantity,0),line.quantity);
    await page.waitForFunction(()=>!document.querySelector('#country')?.disabled&&!document.querySelector('#pay')?.disabled,null,{timeout:25000});
    id=new URL(page.url()).searchParams.get('session_id');assert.notEqual(id,oldId);assert.equal(id,q.sessionId);
    assert.equal(await page.locator('#country').inputValue(),country);assert.equal(await page.locator('#bcountry').inputValue(),country);
    const old=await(await context.request.get(HOST+'/api/godaddy-cart?session_id='+oldId)).json();assert.equal(old.supersededBy,id);assert.equal(old.paymentsEnabled,false);
    measured.payEnabled=await page.locator('#pay').isEnabled();measured.staleQuoteDisabled=true;measured.difference=q.total-expected.total_price;
   }
   item.stage='invalid-country';
   const invalid=await page.evaluate(async sessionId=>{const r=await fetch('/api/godaddy-cart',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'change-country',sessionId,country:'ZZ'})});return {status:r.status(),body:await r.json()};},id);
   assert.equal(invalid.status,400);assert.equal(invalid.body.code,'COUNTRY_NOT_AVAILABLE');item.invalidCountryRejected=true;
   assert.equal(await page.locator('#charge-note').textContent(),'Will be charged in CAD');
   item.finalPayEnabled=await page.locator('#pay').isEnabled();assert.ok(item.finalPayEnabled);item.stage='complete';item.passed=true;
   fs.mkdirSync('artifacts/godaddy-test-country',{recursive:true});await page.screenshot({path:'artifacts/godaddy-test-country/'+scenario.name+'.png',fullPage:true});
  }catch(error){item.error=String(error.message||error).slice(0,350);}
  finally{await context.request.post(SITE+'/cart/clear.js',{data:{}}).catch(()=>{});await context.close();}
 }
}catch(error){report.error=String(error.message||error).slice(0,350);}
finally{
 if(browser)await browser.close();report.finishedAt=new Date().toISOString();report.passed=report.cases.length===2&&report.cases.every(c=>c.passed);
 fs.mkdirSync('artifacts/godaddy-test-country',{recursive:true});fs.writeFileSync('artifacts/godaddy-test-country/results.json',JSON.stringify(report,null,2));
 console.log('GODADDY_TEST_PRODUCT_COUNTRY '+JSON.stringify(report));if(!report.passed)process.exitCode=1;
}

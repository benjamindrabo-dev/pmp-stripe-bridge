// Verify the published test-product checkout and real country changes.
// No card entry, nonce generation, charge, payout or Shopify order creation.
// The initial quote is submitted through the real bridge, which independently
// reconstructs and validates it with Shopify. Native cart-button navigation was
// separately observed in run 34511219945 before its comparator-cart rate limit.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const HOST='https://checkout.puremajestypet.com';
const TEST=43866373914698;
// Actual contextual prices read from Shopify Admin for this exact variant.
// They are an external test oracle, not replacement pricing in the application.
const prices={US:{currency:'USD',total:100},CA:{currency:'CAD',total:200},FR:{currency:'EUR',total:95}};
const report={testedAt:new Date().toISOString(),testVariant:TEST,scope:'Real bridge quote and browser country changes; initial request built from inspected catalog price',initialRequestFromCatalog:true,quoteResponseMocked:false,sdkMocked:false,cardDataEntered:false,paymentsSubmitted:0,ordersCreated:0,countryChanges:[],passed:false};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,context;
async function jsonRequest(path,body){
 const response=await fetch(HOST+path,{method:body?'POST':'GET',redirect:'error',headers:body?{'Content-Type':'application/json',Origin:'https://www.puremajestypet.com'}:{Accept:'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(65000)});
 let data;try{data=await response.json();}catch{throw Error('INVALID_JSON_HTTP_'+response.status);}
 if(!response.ok)throw Error('HTTP_'+response.status+'_'+(/^[A-Z_]+$/.test(data.code||'')?data.code:'REQUEST_FAILED'));
 return data;
}
try{
 report.stage='health';const health=await jsonRequest('/api/godaddy-health');
 assert.equal(health.launchEnabled,true);assert.equal(health.newCheckoutRouting,'godaddy');
 report.stage='create-validated-test-quote';
 const created=await jsonRequest('/api/create-checkout',{checkout_country:'US',locale:'en',currency:'USD',storefront_root:'/',marketing_allowed:false,pmp_cart:{currency:'USD',total_price:100,items_subtotal_price:100,item_count:1,cart_level_discount_applications:[],discount_codes:[],items:[{variant_id:TEST,quantity:1,original_line_price:100,final_line_price:100,product_title:'Present',properties:{}}]}});
 assert.equal(created.paymentProvider,'godaddy');assert.match(created.sessionId,/^gd_[a-f0-9]{32}$/);
 const url=new URL(created.checkoutUrl);assert.equal(url.origin,HOST);assert.equal(url.pathname,'/godaddy-checkout.html');
 report.sessionId=created.sessionId;
 browser=await chromium.launch({headless:true});
 context=await browser.newContext({viewport:{width:390,height:1000},locale:'en-US'});
 await context.route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url());
  if(request.method()==='POST'&&(u.pathname==='/api/godaddy-checkout'||/\/cards\/tokenize\/charge|\/payments$|\/payment_intents(?:\/|$)/.test(u.pathname))){report.unexpectedMonetaryRequestBlocked=true;return route.abort();}
  return route.continue();
 });
 const page=await context.newPage();report.stage='render-test-product';
 await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>document.querySelector('#card-element')?.dataset.sdkReady==='true'&&document.querySelector('#country')?.disabled===false&&document.querySelector('#pay')?.disabled===false,null,{timeout:45000});
 let id=created.sessionId;const initial=await jsonRequest('/api/godaddy-cart?session_id='+id);
 assert.equal(initial.country,'US');assert.equal(initial.currency,'USD');assert.equal(initial.total,100);
 assert.equal(initial.items.length,1);assert.equal(initial.items[0].variantId,TEST);assert.equal(initial.items[0].quantity,1);
 assert.equal(await page.locator('#items .product').count(),1);
 report.initial={country:initial.country,currency:initial.currency,total:initial.total,payEnabled:await page.locator('#pay').isEnabled(),countryEnabled:await page.locator('#country').isEnabled(),testVariantVisible:true};
 for(const country of ['CA','FR','US']){
  // Pace legitimate checks instead of making additional public comparator carts.
  await wait(10000);report.stage='change-country-'+country;
  const responsePromise=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/godaddy-cart'&&r.request().method()==='POST',{timeout:65000});
  const previous=id;await page.locator('#country').selectOption(country);
  const response=await responsePromise,q=await response.json();
  const measured={country,status:response.status(),code:q.code||null,currency:q.currency,total:q.total,expectedCurrency:prices[country].currency,expectedTotal:prices[country].total,chargeCurrency:q.chargeCurrency};report.countryChanges.push(measured);
  assert.equal(response.status(),200,q.code||'COUNTRY_CHANGE_FAILED');
  assert.equal(q.country,country);assert.equal(q.currency,prices[country].currency);assert.equal(q.total,prices[country].total);assert.equal(q.chargeCurrency,'CAD');
  assert.equal(q.items.length,1);assert.equal(q.items[0].variantId,TEST);assert.equal(q.items[0].quantity,1);
  await page.waitForFunction(()=>!document.querySelector('#country')?.disabled&&!document.querySelector('#pay')?.disabled,null,{timeout:30000});
  id=new URL(page.url()).searchParams.get('session_id');assert.equal(id,q.sessionId);assert.notEqual(id,previous);
  assert.equal(await page.locator('#country').inputValue(),country);assert.equal(await page.locator('#bcountry').inputValue(),country);
  const old=await jsonRequest('/api/godaddy-cart?session_id='+previous);assert.equal(old.supersededBy,id);assert.equal(old.paymentsEnabled,false);
  measured.amountDifference=q.total-prices[country].total;measured.payEnabled=await page.locator('#pay').isEnabled();measured.countryEnabled=await page.locator('#country').isEnabled();measured.previousQuoteDisabled=true;
 }
 assert.equal(await page.locator('#charge-note').textContent(),'Will be charged in CAD');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 assert.equal(report.unexpectedMonetaryRequestBlocked,undefined);
 report.finalSessionId=id;report.finalPayEnabled=await page.locator('#pay').isEnabled();report.finalCountryEnabled=await page.locator('#country').isEnabled();
 fs.mkdirSync('artifacts/godaddy-test-country',{recursive:true});
 await page.screenshot({path:'artifacts/godaddy-test-country/test-product-country-mobile.png',fullPage:true});
 report.stage='complete';report.passed=true;
}catch(error){report.error=String(error.message||error).slice(0,350);}
finally{
 if(context)await context.close();if(browser)await browser.close();
 report.finishedAt=new Date().toISOString();fs.mkdirSync('artifacts/godaddy-test-country',{recursive:true});
 fs.writeFileSync('artifacts/godaddy-test-country/results.json',JSON.stringify(report,null,2));
 console.log('GODADDY_TEST_PRODUCT_COUNTRY '+JSON.stringify(report));if(!report.passed)process.exitCode=1;
}

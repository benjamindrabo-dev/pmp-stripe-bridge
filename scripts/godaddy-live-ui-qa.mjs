// Tests only merchant-owned DOM, the SDK ready notification, and iframe geometry.
// Never reads hosted card-frame contents, card fields, values, cookies or headers.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const report={testedAt:new Date().toISOString(),scope:'Production page and actual GoDaddy SDK with synthetic quote responses',quoteMocked:true,sdkMocked:false,cardFrameContentsRead:false,cardDataEntered:false,paymentsSubmitted:0,cases:[],passed:false};
const id='gd_11111111111141118111111111111111';
const base={sessionId:id,currency:'USD',chargeCurrency:'CAD',chargeMinor:14894,subtotal:10797,discount:0,shipping:0,tax:0,total:10797,promotionCode:'',country:'US',businessId:'3cfdebe4-e85d-41e9-9b26-96002a0c8654',applicationId:'urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f',paymentsEnabled:false,completed:false,items:[{variantId:43349565112394,title:'Liquid Collagen',quantity:1,unitMinor:3199,lineTotalMinor:3199,originalLineTotalMinor:3199},{variantId:43405787168842,title:'Yeast Support',quantity:1,unitMinor:3199,lineTotalMinor:3199,originalLineTotalMinor:3199},{variantId:43660092473418,title:'Liquid Probiotic',quantity:1,unitMinor:4399,lineTotalMinor:4399,originalLineTotalMinor:4399}]};
let browser;
try{
 browser=await chromium.launch({headless:true});
 for(const [locale,width]of [['en',1440],['fr',390],['de',768],['es',390],['it',1440],['pt',390],['ja',390]]){
  const language=locale==='ja'?'en':locale,entry={locale,width,passed:false};report.cases.push(entry);
  const context=await browser.newContext({locale:locale==='ja'?'ja-JP':locale,viewport:{width,height:1000}}),page=await context.newPage();
  await page.addInitScript(()=>{window.__pmpCspMetadata=[];document.addEventListener('securitypolicyviolation',e=>{let blocked='';try{const u=new URL(e.blockedURI);blocked=u.origin+u.pathname;}catch{blocked='non-url';}window.__pmpCspMetadata.push({directive:e.effectiveDirective,blocked});});});
  await page.route('**/api/godaddy-cart*',async route=>{const url=new URL(route.request().url());return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(url.searchParams.get('view')==='options'?{suggestions:[]}:{...base,locale})});});
  await page.route('**/api/godaddy-checkout*',route=>route.abort());
  await page.route('**/cards/tokenize/charge*',route=>route.abort());
  await page.route('**/cards/tokenize/nonce*',route=>route.abort());
  try{
   const response=await page.goto('https://checkout.puremajestypet.com/godaddy-checkout.html?session_id='+id,{waitUntil:'domcontentloaded',timeout:45000});assert.equal(response.status(),200);
   await page.waitForFunction(()=>document.getElementById('card-element')?.dataset.sdkReady==='true',null,{timeout:25000});
   // Presence/visibility of the iframe element in our page, not its contents.
   const frame=page.locator('iframe[src*="/payment-form/"]');await frame.waitFor({state:'visible',timeout:10000});const box=await frame.boundingBox();assert.ok(box&&box.width>100&&box.height>100);
   assert.equal(await page.locator('html').getAttribute('lang'),language);assert.equal(await page.locator('#items .product').count(),3);
   const total=await page.locator('#summary-total').textContent();assert.equal(total,new Intl.NumberFormat(language,{style:'currency',currency:'USD'}).format(107.97));
   const notice=await page.locator('#charge-note').textContent();assert.ok(notice.includes('CAD'));assert.ok(!/[0-9]/.test(notice));if(language==='en')assert.equal(notice,'Will be charged in CAD');
   assert.equal(await page.locator('#pay').isDisabled(),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const csp=await page.evaluate(()=>window.__pmpCspMetadata);entry.csp=csp;assert.equal(csp.length,0,'CSP blocks a payment SDK dependency');
   Object.assign(entry,{passed:true,sdkReady:true,paymentFrameVisible:true,displayTotal:total,chargeNotice:notice});
  }catch(error){entry.error=String(error.message||'CHECK_FAILED').split('\n')[0].slice(0,180);entry.csp=await page.evaluate(()=>window.__pmpCspMetadata).catch(()=>[]);}
  await context.close();
 }
 report.passed=report.cases.every(c=>c.passed);report.successfulCases=report.cases.filter(c=>c.passed).length;
}catch(error){report.error=String(error.message||'BROWSER_FAILED').split('\n')[0].slice(0,180);}
finally{if(browser)await browser.close();report.finishedAt=new Date().toISOString();fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/godaddy-browser-readiness-20260910.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;}

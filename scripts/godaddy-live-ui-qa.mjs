import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const BASE='https://checkout.puremajestypet.com';
const sid='gd_'+('7'.repeat(32));
const result={testedAt:new Date().toISOString(),scope:'Real production HTML and GoDaddy SDK; intercepted synthetic quote only',sdkMocked:false,quoteMocked:true,cardDataEntered:false,paymentRequestsAllowed:0,cases:[],passed:false};
const q={sessionId:sid,currency:'USD',chargeCurrency:'CAD',chargeMinor:14894,subtotal:10797,discount:0,shipping:0,tax:0,total:10797,promotionCode:'',country:'US',countries:['US'],businessId:'3cfdebe4-e85d-41e9-9b26-96002a0c8654',applicationId:'urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f',paymentsEnabled:false,items:[{variantId:43349565112394,title:'Liquid Collagen',quantity:1,unitMinor:3199,lineTotalMinor:3199,originalLineTotalMinor:3199,image:'https://cdn.shopify.com/s/files/1/0696/7440/1866/files/pure-majesty-pets-liquid-collagen-gallery-01-new-look_2bf4cf9a-def9-4d19-b710-d14f1658c392.png'},{variantId:43405787168842,title:'Yeast Support',quantity:1,unitMinor:3199,lineTotalMinor:3199,originalLineTotalMinor:3199},{variantId:43660092473418,title:'Liquid Probiotic',quantity:1,unitMinor:4399,lineTotalMinor:4399,originalLineTotalMinor:4399},{variantId:43449159516234,title:'Eye Drops',quantity:1,unitMinor:0,lineTotalMinor:0,originalLineTotalMinor:0,gift:true}]};
const browser=await chromium.launch({headless:true});
try{
 for(const [locale,width] of [['en',1440],['fr',390]]){
  const context=await browser.newContext({viewport:{width,height:1000},locale:locale==='fr'?'fr-CA':'en-US'});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.name));
  // Prevent every monetary request. Do not enter even a test card in this live merchant form.
  await page.route('**/api/godaddy-checkout**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'QA_PAYMENT_BLOCKED'})}));
  await page.route('**/cards/tokenize/**',route=>route.abort());
  await page.route('**/api/godaddy-cart**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(route.request().url().includes('view=options')?{suggestions:[]}:{...q,locale})}));
  await page.goto(BASE+'/godaddy-checkout.html?session_id='+sid+'&lang='+locale,{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForFunction(()=>document.querySelectorAll('#items .product').length===4,{},{timeout:30000});
  await page.waitForFunction(()=>Boolean(document.querySelector('#card-element iframe')),{},{timeout:45000});
  // A real hosted frame must have loaded its card-number field. We inspect only
  // field existence/labels, never read values, tokenize, or submit anything.
  let frame;
  for(let i=0;i<30;i++){
   frame=page.frames().find(f=>f!==page.mainFrame()&&f.url().includes('collect.commerce.godaddy.com'));
   if(frame&&await frame.locator('input').count()>0)break;
   await page.waitForTimeout(1000);
  }
  assert.ok(frame,'Hosted GoDaddy frame not loaded');assert.ok(await frame.locator('input').count()>0,'Hosted fields not present');
  assert.equal(await page.locator('#pay').isDisabled(),true);
  const notice=await page.locator('#charge-note').innerText();assert.ok(notice.includes('CAD'));assert.doesNotMatch(notice,/148[.,]94/);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);assert.equal(overflow,false);
  assert.equal(await page.locator('#items .product').count(),4);
  result.cases.push({locale,width,hostedFieldsPresent:true,productCount:4,overflow:false,currencyNotice:notice,pageErrors:errors,paymentDisabled:true,passed:true});
  await context.close();
 }
 result.passed=true;
}catch(e){result.error=String(e.message||e.name).slice(0,220);process.exitCode=1;}
finally{await browser.close();fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/godaddy-browser-readiness-20260910.json',JSON.stringify(result,null,2)+'\n');console.log('GODADDY_BROWSER_READINESS '+JSON.stringify(result));}

import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire('/tmp/pmp-qa/package.json');
const {chromium,request}=require('playwright');
const bridge='https://checkout.puremajestypet.com';
const store='https://www.puremajestypet.com';
const api=await request.newContext({timeout:30000});
const browser=await chromium.launch({headless:true});
mkdirSync('/tmp/pmp-qa/results',{recursive:true});
const results=[];
try{
 const response=await api.get(store+'/en-ca/products.json?limit=100');
 assert.ok(response.ok(),'Catalog accessible');
 const products=(await response.json()).products;
 const product=products.find(p=>/collagen/i.test(p.title)&&p.variants.some(v=>v.available!==false))||products.find(p=>p.variants.some(v=>v.available!==false));
 assert.ok(product,'Available test product');
 for(const [country,root,expected,locale]of [['CA','/en-ca','CAD','en'],['US','','USD','en'],['GB','/en-gb','GBP','en'],['FR','/fr-fr','EUR','fr'],['AU','/en-au','AUD','en']]){
  const client=await request.newContext({timeout:30000});
  try{
   const pr=await client.get(store+root+'/products/'+product.handle+'.js');
   const cr=await client.get(store+root+'/cart.js');
   assert.ok(pr.ok()&&cr.ok(),country+' public market prices accessible');
   const p=await pr.json(),cart=await cr.json();
   const variant=p.variants.find(v=>v.available)||p.variants[0];
   assert.equal(cart.currency,expected,country+' market currency');
   const body={payment_provider:'square',items:[{variant_id:variant.id,product_id:p.id,title:p.title,quantity:1,price_cents:variant.price,image:p.featured_image}],currency:cart.currency,checkout_country:country,locale,shopify_cart_url:store+root+'/cart',note:'Automated checkout configuration verification; no payment',marketing_allowed:false};
   const r=await api.post(bridge+'/api/create-checkout',{data:body});
   const q=await r.json();assert.ok(r.ok(),country+' quote: '+JSON.stringify(q));
   assert.equal(q.provider,'square');assert.match(q.sessionId,/^sq_[a-f0-9]{32}$/);
   const details=await (await api.get(bridge+'/api/square-checkout?session_id='+q.sessionId)).json();
   assert.equal(details.quote.displayCurrency,expected);assert.equal(details.quote.chargeCurrency,'CAD');assert.ok(Number.isSafeInteger(details.quote.chargeMinor)&&details.quote.chargeMinor>0);
   const page=await browser.newPage({viewport:{width:country==='FR'?390:1280,height:900}});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(q.checkoutUrl,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>{const b=document.getElementById('pay');return b&&!b.disabled;},null,{timeout:45000});
   assert.ok((await page.locator('#total').innerText()).includes(expected),country+' displayed local total');
   assert.ok((await page.locator('#charge').innerText()).includes('CAD'),country+' CAD disclosure');
   assert.ok(await page.locator('#card iframe').count()>0,country+' secure Square frame mounted');
   assert.equal(errors.length,0,country+' browser errors: '+errors.join(' | '));
   assert.ok(await page.locator('#card iframe').first().isVisible(),'Square secure frame visible');
   await page.locator('#card').scrollIntoViewIfNeeded();
   await page.waitForTimeout(500);
   await page.screenshot({path:'/tmp/pmp-qa/results/square-'+expected+'.png',fullPage:true});
   await page.close();
   const invalid=await api.post(bridge+'/api/square-pay',{data:{sessionId:q.sessionId,confirmedChargeMinor:0}});
   assert.equal(invalid.status(),409,'Tampered CAD amount rejected without payment');
   const discounted=await api.post(bridge+'/api/square-checkout',{data:{sessionId:q.sessionId,promotionCode:'WELCOME20'}});
   const d=await discounted.json();assert.ok(discounted.ok(),'WELCOME20 accepted: '+JSON.stringify(d));
   const dd=await (await api.get(bridge+'/api/square-checkout?session_id='+d.sessionId)).json();
   assert.equal(dd.promotionCode,'WELCOME20');assert.ok(Number(dd.quote.displayAmount)<Number(details.quote.displayAmount),'Local discount visible');assert.ok(dd.quote.chargeMinor<details.quote.chargeMinor,'CAD charge also discounted');
   results.push({country,displayCurrency:expected,displayTotal:details.quote.displayAmount,chargeCurrency:details.quote.chargeCurrency,chargeMinor:details.quote.chargeMinor,formReady:true,discountVerified:true,tamperedAmountRejected:true,paid:false});
   console.log('PASS',JSON.stringify(results.at(-1)));
  }finally{await client.dispose();}
 }
 writeFileSync('/tmp/pmp-qa/results/report.json',JSON.stringify(results,null,2));
 console.log('Verified all five markets; no card data submitted, no payment confirmed.');
}finally{await api.dispose();await browser.close();}

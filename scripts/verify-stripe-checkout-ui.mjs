import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire('/tmp/pmp-ui/package.json');
const {chromium,request}=require('playwright');
const patch=readFileSync(new URL('../public/stripe-checkout.js',import.meta.url),'utf8');
const preview=process.argv.includes('--preview');
const bridge='https://checkout.puremajestypet.com';
const store='https://www.puremajestypet.com';
const out='/tmp/pmp-ui-results/'+(preview?'before-publication':'production');mkdirSync(out,{recursive:true});
const api=await request.newContext({timeout:30000});
const browser=await chromium.launch({headless:true});
const results=[];
try{
  const health=await (await api.get(bridge+'/api/stripe-health')).json();
  assert.equal(health.checkoutProvider,'stripe');assert.equal(health.serverReady,true);
  const products=await (await api.get(store+'/en-ca/products.json?limit=100')).json();
  const product=products.products.find(p=>/collagen/i.test(p.title)&&p.variants.some(v=>v.available!==false));assert.ok(product);
  for(const [country,root,currency,locale,width]of [['CA','/en-ca','CAD','en',390],['US','','USD','en',390],['FR','/fr-fr','EUR','fr',390],['GB','/en-gb','GBP','en',1280],['AU','/en-au','AUD','en',1280]]){
    const client=await request.newContext({timeout:30000});
    let page;
    try{
      const cart=await (await client.get(store+root+'/cart.js')).json();assert.equal(cart.currency,currency);
      const p=await (await client.get(store+root+'/products/'+product.handle+'.js')).json();const v=p.variants.find(v=>v.available)||p.variants[0];
      const r=await api.post(bridge+'/api/create-checkout',{data:{payment_provider:'square',items:[{variant_id:v.id,product_id:p.id,title:p.title,quantity:1,price_cents:v.price,image:p.featured_image}],currency,checkout_country:country,locale,shopify_cart_url:store+root+'/cart',note:'UI-only verification; no payment',marketing_allowed:false}});
      const q=await r.json();assert.ok(r.ok());assert.equal(q.paymentProvider,'stripe');
      const details=await (await api.get(bridge+'/api/stripe-checkout?session_id='+q.sessionId)).json();assert.equal(details.quote.displayCurrency,currency);assert.equal(details.quote.chargeCurrency,'CAD');
      page=await browser.newPage({viewport:{width,height:950}});
      let paymentAttempts=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/api/stripe-checkout',async route=>{
        const req=route.request();let data;try{data=req.postDataJSON();}catch{}
        if(req.method()==='POST'&&data?.action==='prepare'){paymentAttempts++;await route.fulfill({status:409,contentType:'application/json',body:'{"error":"Payment disabled in UI verification"}'});return;}
        await route.continue();
      });
      if(preview)await page.route('**/stripe-checkout.js',route=>route.fulfill({status:200,contentType:'application/javascript',body:patch}));
      await page.goto(q.checkoutUrl,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>document.documentElement.dataset.pmpStripeUi==='wallet-layout-r1-20260909'&&!document.getElementById('pay').disabled,null,{timeout:45000});
      await page.waitForTimeout(1500);
      assert.equal(await page.locator('#cardholder').count(),0);
      assert.equal(await page.locator('.cardholder-field').count(),0);
      assert.ok(await page.locator('#card iframe').count()>0);
      assert.ok((await page.locator('#pay-total').innerText()).includes(currency));
      if(currency==='CAD')assert.equal(await page.locator('#charge').isVisible(),false);
      else {assert.equal(await page.locator('#charge').isVisible(),true);assert.ok((await page.locator('#charge').innerText()).includes('CAD'));}
      const dimensions=[];
      for(const size of country==='CA'?[320,390,430,768,1280]:[width]){
        await page.setViewportSize({width:size,height:950});await page.waitForTimeout(350);
        const d=await page.locator('.wallet-grid').evaluate(el=>{
          const r=el.getBoundingClientRect(),child=el.firstElementChild?.getBoundingClientRect();return {layout:getComputedStyle(el).display,width:r.width,childWidth:child?.width||0,visible:!!r.height,overflow:document.documentElement.scrollWidth>innerWidth+1};
        });
        assert.equal(d.layout,'block');assert.equal(d.overflow,false);
        if(d.visible&&d.childWidth)assert.ok(d.childWidth>=d.width-2,'Stripe iframe must span the full wallet row');
        dimensions.push({viewport:size,...d});
      }
      await page.setViewportSize({width,height:950});await page.waitForTimeout(500);
      await page.screenshot({path:out+'/checkout-'+currency+'.png',fullPage:true});
      if(country==='CA')await page.screenshot({path:out+'/checkout-CAD-top.png',fullPage:false});
      assert.equal(paymentAttempts,0);assert.equal(errors.length,0,errors.join(' | '));
      results.push({country,displayCurrency:currency,chargeCurrency:details.quote.chargeCurrency,duplicateNameRemoved:true,chargeNoticeHidden:currency==='CAD',dimensions,noCardDataEntered:true,noPaymentAttempted:true});
    }finally{if(page)await page.close();await client.dispose();}
  }
  writeFileSync(out+'/report.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify({mode:preview?'before-publication':'production',passed:results.length,results}));
}finally{await browser.close();await api.dispose();}

// Isolated anonymous public carts. Never reads customer accounts, card fields,
// cookies, auth headers or payment bodies. No payment requests are permitted.
import {chromium} from 'playwright';
import fs from 'node:fs';
const SITE='https://www.puremajestypet.com';
const report={at:new Date().toISOString(),monetaryRequests:0,cases:[]};
const browser=await chromium.launch({headless:true});
const cases=[
 {name:'root-default',country:null,root:'',quantity:1},
 {name:'root-canada',country:'CA',root:'',quantity:3},
 {name:'canada-bundle',country:'CA',root:'/en-ca',quantity:5},
 {name:'us-bundle',country:'US',root:'',quantity:5}
];
for(const s of cases){
 const out={name:s.name,responses:[],errors:[]};report.cases.push(out);
 const ctx=await browser.newContext({locale:'en-CA',viewport:{width:1440,height:1000}});
 await ctx.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(req.method()==='POST'&&(u.pathname==='/api/godaddy-checkout'||/\/cards\/tokenize\/charge|\/payments$|\/payment_intents(?:\/|$)/.test(u.pathname)))return route.abort('blockedbyclient');
  return route.continue();
 });
 const page=await ctx.newPage();
 page.on('pageerror',e=>{if(out.errors.length<8)out.errors.push(String(e.message).replace(/https?:\/\/[^\s]+/g,'[URL]').slice(0,200));});
 page.on('response',async r=>{try{const u=new URL(r.url());if(u.pathname==='/api/create-checkout'&&r.request().method()==='POST'){
  const d=await r.json();let b={};try{b=r.request().postDataJSON()||{};}catch{}
  out.responses.push({status:r.status(),code:d.code||null,provider:d.paymentProvider||null,checkoutPath:d.checkoutUrl?new URL(d.checkoutUrl).pathname:null,country:b.checkout_country,locale:b.locale,root:b.storefront_root,currency:b.pmp_cart?.currency||b.currency,total:b.pmp_cart?.total_price,snapshot:!!b.pmp_cart});
 } }catch{}});
 try{
  await page.goto(SITE+s.root+'/',{waitUntil:'domcontentloaded',timeout:45000});
  if(s.country)await ctx.request.post(SITE+'/localization',{form:{form_type:'localization',_method:'put',country_code:s.country,return_to:s.root+'/cart'},maxRedirects:3});
  const a=await ctx.request.post(SITE+s.root+'/cart/add.js',{data:{items:[{id:43349565112394,quantity:s.quantity}]}});out.addStatus=a.status();
  await page.goto(SITE+s.root+'/cart',{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForTimeout(1500);
  out.context=await page.evaluate(()=>({country:window.Shopify?.country,locale:window.Shopify?.locale,currency:window.Shopify?.currency?.active,root:window.Shopify?.routes?.root,helper:!!window.__pmpCheckoutCountryBridge,buttons:[...document.querySelectorAll('button')].filter(e=>/buy now|checkout/i.test(e.textContent)).map(e=>({text:e.textContent.trim().slice(0,50),id:e.id,type:e.type,name:e.name,disabled:e.disabled})).slice(0,8)}));
  const raw=await(await ctx.request.get(SITE+s.root+'/cart.js')).json();
  out.cart={currency:raw.currency,total:raw.total_price,quantity:raw.item_count,lines:raw.items.map(i=>({variant:i.variant_id,quantity:i.quantity,line:i.final_line_price,propertyKeys:Object.keys(i.properties||{})}))};
  const button=page.getByRole('button',{name:/^buy now$/i}).first();await button.click({timeout:10000});
  try{await page.waitForURL(u=>u.hostname==='checkout.puremajestypet.com'||u.hostname==='pmp-stripe-bridge.vercel.app',{timeout:20000});out.redirected=true;}catch{out.redirected=false;}
  out.path=new URL(page.url()).pathname;
  if(!out.redirected){out.visibleErrors=await page.locator('[role="alert"],.cart-errors,#cart-errors,.pmp-error').allTextContents();}
 }catch(e){out.error=e.name==='TimeoutError'?'BROWSER_TIMEOUT':String(e.message).replace(/https?:\/\/[^\s]+/g,'[URL]').slice(0,200);}
 finally{try{await ctx.request.post(SITE+s.root+'/cart/clear.js',{data:{}});}catch{}await ctx.close();}
 console.log('GODADDY_CART_CLICK_CASE '+JSON.stringify(out));
}
await browser.close();fs.mkdirSync('artifacts/godaddy-cart-click',{recursive:true});fs.writeFileSync('artifacts/godaddy-cart-click/result.json',JSON.stringify(report,null,2));
console.log('GODADDY_CART_CLICK_DIAGNOSTIC '+JSON.stringify(report));

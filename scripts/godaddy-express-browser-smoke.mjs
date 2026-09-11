// Public checkout UI test only. All financial POSTs are blocked. No card data,
// wallet login, customer accounts, auth tokens or cookies are emitted.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const SITE='https://www.puremajestypet.com',HOST='https://checkout.puremajestypet.com';
const report={startedAt:new Date().toISOString(),sdkMocked:false,cartMocked:false,paymentsSubmitted:0,cardDataEntered:false,ordersCreated:0,cspViolations:[],cases:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let browser,context;
try{
 let deployed=false;
 for(let i=0;i<36;i++){
  const r=await fetch(HOST+'/godaddy-checkout.js',{signal:AbortSignal.timeout(15000)});
  if(r.ok&&(await r.text()).includes('function initExpress()')){deployed=true;break;}
  await sleep(5000);
 }
 assert.ok(deployed,'EXPRESS_GLUE_NOT_DEPLOYED');
 browser=await chromium.launch({headless:true});
 context=await browser.newContext({viewport:{width:1440,height:1050},locale:'en-US'});
 await context.route('**/*',route=>{
  const r=route.request(),u=new URL(r.url());
  if(r.method()==='POST'&&(u.pathname==='/api/godaddy-checkout'||/\/cards\/tokenize\/charge|\/payments$|\/payment_intents(?:\/|$)/.test(u.pathname))){report.financialRequestBlocked=true;return route.abort();}
  return route.continue();
 });
 const page=await context.newPage();
 await page.addInitScript(()=>{window.__expressCsp=[];document.addEventListener('securitypolicyviolation',e=>window.__expressCsp.push({directive:e.effectiveDirective,uri:e.blockedURI?.split('?')[0]}));});
 await page.goto(SITE+'/products/test?variant=43866373914698',{waitUntil:'domcontentloaded',timeout:60000});
 await sleep(1800);
 const source=await page.evaluate(async()=>{
  const root=window.Shopify?.routes?.root||'/';
  const r=await fetch(root+'cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:43866373914698,quantity:1}]})});
  if(!r.ok)return {error:'CART_ADD_'+r.status};
  const c=await(await fetch(root+'cart.js',{cache:'no-store'})).json();return {root,currency:c.currency,total:c.total_price};
 });
 assert.ok(!source.error,source.error);report.source=source;
 await page.goto(SITE+source.root+'cart',{waitUntil:'domcontentloaded',timeout:60000});await sleep(1800);
 const buttons=page.getByRole('button',{name:/^(buy now|check out|checkout|proceed to checkout|secure checkout)$/i});
 let button;for(let i=0;i<await buttons.count();i++){if(await buttons.nth(i).isVisible()&&await buttons.nth(i).isEnabled()){button=buttons.nth(i);break;}}
 assert.ok(button,'CHECKOUT_BUTTON_NOT_FOUND');await button.click();
 await page.waitForURL(u=>u.hostname==='checkout.puremajestypet.com'&&/^gd_/.test(u.searchParams.get('session_id')||''),{timeout:65000});
 await page.waitForFunction(()=>document.querySelector('#card-element')?.dataset.sdkReady==='true',null,{timeout:30000});
 const id=new URL(page.url()).searchParams.get('session_id');
 const q=await(await context.request.get(HOST+'/api/godaddy-cart?session_id='+id)).json();
 assert.equal(q.total,source.total);assert.equal(q.currency,source.currency);report.total=q.total;report.currency=q.currency;report.chargeMinor=q.chargeMinor;
 const config=await(await context.request.get(HOST+'/api/godaddy-wallet-config?session_id='+id)).json();report.walletConfig=config;assert.equal(config.applePay,true,'APPLE_DOMAIN_NOT_REGISTERED');assert.equal(config.googlePay,true);
 await page.waitForFunction(()=>{const box=document.querySelector('#express-checkout');return box?.dataset.ready==='true'||box?.dataset.state==='unavailable'||box?.dataset.availableMethods==='';},null,{timeout:35000});
 report.availableMethods=await page.locator('#express-checkout').getAttribute('data-available-methods');
 assert.ok(await page.locator('[data-testid="wallet-googlepay-button"]').isVisible(),'REAL_GOOGLE_PAY_BUTTON_NOT_VISIBLE');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1050});await sleep(500);
  const wallet=await page.locator('#express-checkout').boundingBox(),email=await page.locator('#email').boundingBox();
  const item={width,expressAboveEmail:wallet.y+wallet.height<=email.y,cardAvailable:await page.locator('#pay').isEnabled(),emailEmpty:await page.locator('#email').inputValue()==='',horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)};
  report.cases.push(item);assert.ok(item.expressAboveEmail);assert.ok(item.cardAvailable);assert.ok(item.emailEmpty);assert.equal(item.horizontalOverflow,false);
  fs.mkdirSync('artifacts/godaddy-express',{recursive:true});await page.screenshot({path:'artifacts/godaddy-express/checkout-'+width+'.png',fullPage:true});
 }
 report.cspViolations=await page.evaluate(()=>window.__expressCsp||[]);assert.equal(report.cspViolations.length,0,'CHECKOUT_CSP_VIOLATION');
 // Opening and dismissing Google's own sheet performs no authorization or debit.
 const popupWait=context.waitForEvent('page',{timeout:10000}).catch(()=>null);
 await page.locator('[data-testid="wallet-googlepay-button"]').click();
 const popup=await popupWait;
 report.googleSheetOpened=Boolean(popup);
 if(popup){await popup.waitForLoadState('domcontentloaded',{timeout:10000}).catch(()=>{});try{report.googleSheetHost=new URL(popup.url()).hostname;}catch{}await popup.close();}
 report.passed=true;
}catch(error){report.passed=false;report.error=String(error.message||error).slice(0,260);}
finally{
 if(context)await context.close();if(browser)await browser.close();
 report.finishedAt=new Date().toISOString();fs.mkdirSync('artifacts/godaddy-express',{recursive:true});fs.writeFileSync('artifacts/godaddy-express/report.json',JSON.stringify(report,null,2));
 console.log('GODADDY_EXPRESS_BROWSER '+JSON.stringify(report));if(!report.passed)process.exitCode=1;
}

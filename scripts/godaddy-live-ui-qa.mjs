// Network/CSP metadata only. No iframe contents, input values, card fields,
// request bodies, cookies, authorization headers, or payment submission.
import {chromium} from 'playwright';
import fs from 'node:fs';
const sid='gd_'+('7'.repeat(32));
const report={testedAt:new Date().toISOString(),scope:'Non-sensitive browser network/CSP diagnostics',cardFieldsInspected:false,cardDataEntered:false,monetaryRequestsAllowed:0,quoteMocked:true,sdkMocked:false,cardReadinessVerified:false,network:[],csp:[]};
const quote={sessionId:sid,currency:'CAD',chargeCurrency:'CAD',chargeMinor:4500,subtotal:4500,total:4500,discount:0,shipping:0,tax:0,promotionCode:'',locale:'en',country:'CA',businessId:'3cfdebe4-e85d-41e9-9b26-96002a0c8654',applicationId:'urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f',paymentsEnabled:false,items:[{variantId:43349565112394,title:'Liquid Collagen',quantity:1,unitMinor:4500,lineTotalMinor:4500,originalLineTotalMinor:4500}]};
function safeUrl(value){try{const u=new URL(value);return u.origin+u.pathname;}catch{return 'about:blank';}}
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('response',r=>{const url=safeUrl(r.url());if(url.includes('godaddy.com')||url.includes('poynt.net'))report.network.push({url,status:r.status()});});
 page.on('requestfailed',r=>report.network.push({url:safeUrl(r.url()),failed:true}));
 await page.addInitScript(()=>{window.__pmpQaCsp=[];window.addEventListener('securitypolicyviolation',e=>{let blocked;try{const u=new URL(e.blockedURI);blocked=u.origin+u.pathname;}catch{blocked='inline-or-unknown';}window.__pmpQaCsp.push({directive:e.effectiveDirective,blocked});});});
 await page.route('**/api/godaddy-checkout**',route=>route.abort());
 await page.route('**/cards/tokenize/**',route=>route.abort());
 await page.route('**/api/godaddy-cart**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(route.request().url().includes('view=options')?{suggestions:[]}:quote)}));
 await page.goto('https://checkout.puremajestypet.com/godaddy-checkout.html?session_id='+sid,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForTimeout(12000);
 report.sdkConstructorPresent=await page.evaluate(()=>typeof window.TokenizeJs==='function');
 report.csp=await page.evaluate(()=>window.__pmpQaCsp||[]);
 report.frameUrls=page.frames().map(f=>safeUrl(f.url()));
 report.result='network-inspection-complete';
}catch{report.result='network-inspection-failed';process.exitCode=1;}
finally{await browser.close();report.network=report.network.slice(0,40);fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/godaddy-browser-readiness-20260910.json',JSON.stringify(report,null,2)+'\n');console.log('GODADDY_BROWSER_NETWORK '+JSON.stringify(report));}

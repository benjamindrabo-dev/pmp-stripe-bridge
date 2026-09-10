// Authorized infrastructure setup, not payment submission. No card data or secrets
// are printed. Use only after the production receiver is deployed.
import {randomBytes,randomUUID,createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createGoDaddyAssertion} from '../lib/godaddy-payments.js';
import {hookKey,hookRedis,readHookSettings,DELIVERY_URL,UUID} from '../lib/godaddy-hook-settings.js';
const HOST='https://services.poynt.net';
const EVENTS=['TRANSACTION_CAPTURED','TRANSACTION_UPDATED','TRANSACTION_REFUNDED','TRANSACTION_VOIDED'];
const report={revision:'hook-setup-20260910',time:new Date().toISOString(),hookRegistered:false,positiveSignatureCheck:false,negativeSignatureCheck:false,providerDeliveryObserved:false,paymentsCreated:0,ordersCreated:0,paymentRoutingChanged:false};
const fail=code=>{throw Object.assign(new Error(code),{code});};
try{
 if(process.argv[2]!=='--register'||process.env.VERCEL_ENV!=='production'||process.env.VERCEL_GIT_COMMIT_REF!=='main')fail('PRODUCTION_SETUP_CONTEXT_REQUIRED');
 if(Date.now()>Date.parse('2026-09-11T00:00:00Z'))fail('SETUP_WINDOW_EXPIRED');
 const file=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 const value=k=>process.env[k]??file.env?.[k]??'';
 if(value('PMP_GODADDY_ENABLED')!=='0')fail('DISABLED_CHECKOUT_REQUIRED');
 const c={businessId:value('GODADDY_BUSINESS_ID'),storeId:value('GODADDY_STORE_ID'),applicationId:value('GODADDY_APPLICATION_ID'),privateKey:String(process.env.GODADDY_PRIVATE_KEY||'').replace(/\\n/g,'\n')};
 if(c.businessId!=='3cfdebe4-e85d-41e9-9b26-96002a0c8654'||c.storeId!=='40c35dbb-13c6-466f-b3f7-d832c4fb58c0'||c.applicationId!=='urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f')fail('MERCHANT_MISMATCH');
 const tokenResponse=await fetch(HOST+'/token',{method:'POST',redirect:'error',headers:{'api-version':'1.2','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grantType:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:createGoDaddyAssertion(c)}),signal:AbortSignal.timeout(12000)});
 if(!tokenResponse.ok)fail('AUTHENTICATION_FAILED');const token=await tokenResponse.json();if(typeof token.accessToken!=='string')fail('AUTHENTICATION_FAILED');
 async function provider(path,body,requestId){
  if(path!=='/hooks'&&!path.startsWith('/hooks?')&&!/^\/hooks\/[a-f0-9-]{36}$/.test(path))fail('OPERATION_NOT_ALLOWED');
  if(body&&path!=='/hooks')fail('OPERATION_NOT_ALLOWED');
  const r=await fetch(HOST+path,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token.accessToken,'api-version':'1.2','Content-Type':'application/json',...(requestId?{'Poynt-Request-Id':requestId}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
  if(!r.ok)fail('HOOK_HTTP_'+r.status);return r.json();
 }
 const listed=await provider('/hooks?businessId='+c.businessId+'&applicationId='+encodeURIComponent(c.applicationId)+'&limit=100');
 if(!Array.isArray(listed.hooks))fail('HOOK_LIST_INVALID');
 const matches=listed.hooks.filter(h=>h.businessId===c.businessId&&h.applicationId===c.applicationId&&h.deliveryUrl===DELIVERY_URL);
 if(matches.length>1)fail('DUPLICATE_HOOKS_REQUIRE_REVIEW');
 const key=hookKey(c,'production');let saved=await readHookSettings(c);
 if(!saved){
  if(matches.length)fail('EXISTING_HOOK_SECRET_UNKNOWN');
  const secret=process.env.GODADDY_WEBHOOK_SECRET||randomBytes(48).toString('base64url');if(secret.length<32)fail('SECRET_TOO_SHORT');
  const initial={businessId:c.businessId,storeId:c.storeId,applicationId:c.applicationId,deliveryUrl:DELIVERY_URL,secret,requestId:randomUUID(),createdAt:new Date().toISOString(),registered:false};
  if(await hookRedis(['SET',key,JSON.stringify(initial),'NX'])!=='OK')fail('CONCURRENT_SETUP');saved=initial;
 }
 let hook=matches[0];
 if(!hook){
  if(saved.requestSent)fail('REGISTRATION_UNCERTAIN');
  saved={...saved,requestSent:true};await hookRedis(['SET',key,JSON.stringify(saved)]);
  hook=await provider('/hooks',{applicationId:c.applicationId,businessId:c.businessId,deliveryUrl:DELIVERY_URL,secret:saved.secret,eventTypes:EVENTS},saved.requestId);
 }
 if(!UUID.test(hook.id)||hook.businessId!==c.businessId||hook.applicationId!==c.applicationId||hook.deliveryUrl!==DELIVERY_URL||hook.active!==true||!EVENTS.every(e=>hook.eventTypes?.includes(e)))fail('HOOK_REGISTRATION_MISMATCH');
 const confirmed=await provider('/hooks/'+hook.id);if(confirmed.id!==hook.id||confirmed.active!==true||confirmed.businessId!==c.businessId||confirmed.deliveryUrl!==DELIVERY_URL)fail('HOOK_READBACK_FAILED');
 saved={...saved,hookId:hook.id,registered:true,registeredAt:new Date().toISOString()};await hookRedis(['SET',key,JSON.stringify(saved)]);
 report.hookRegistered=true;report.hookId=hook.id;
 const payload=JSON.stringify({eventType:'PMP_CONFIGURATION_PROBE',applicationId:c.applicationId,businessId:c.businessId,storeId:c.storeId,probeId:randomBytes(16).toString('hex')});
 const good=createHmac('sha1',saved.secret).update(payload).digest('base64');
 const bad=createHmac('sha1',randomBytes(32)).update(payload).digest('base64');
 for(const [name,signature,expected] of [['positiveSignatureCheck',good,200],['negativeSignatureCheck',bad,401]]){
  const r=await fetch(DELIVERY_URL,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Poynt-Webhook-Signature':signature},body:payload,signal:AbortSignal.timeout(12000)});
  report[name+'Status']=r.status;report[name]=r.status===expected;
  if(name==='positiveSignatureCheck'&&r.status===200){const data=await r.json();report[name]=data.configurationProbe===true&&data.queued===false;}
 }
 saved={...saved,signatureChecksVerified:report.positiveSignatureCheck&&report.negativeSignatureCheck,signatureCheckedAt:new Date().toISOString()};await hookRedis(['SET',key,JSON.stringify(saved)]);
 report.cronSecretPresent=Boolean(process.env.CRON_SECRET);
 report.result=saved.signatureChecksVerified?'registered-signature-checks-passed':'registered-endpoint-check-failed';
}catch(error){report.result='blocked';report.code=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'SETUP_FAILED';}
console.log('GODADDY_HOOK_SETUP '+JSON.stringify(report));

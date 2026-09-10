// Explicit one-off merchant discovery. Only token exchange and GET /stores.
import { readFileSync } from 'node:fs';
import { createGoDaddyAssertion } from '../lib/godaddy-payments.js';
const BRANCH='prep/godaddy-payments-20260909';
const BUSINESS='3cfdebe4-e85d-41e9-9b26-96002a0c8654';
const APP='urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HOST='https://services.poynt.net';
const report={revision:'godaddy-embedded-store-discovery-20260910',testedAt:new Date().toISOString(),requests:[],paymentsCreated:0,productionChanged:false};
try {
 if(process.argv[2]!=='--run'||process.env.VERCEL_ENV!=='preview'||process.env.VERCEL_GIT_COMMIT_REF!==BRANCH||Date.now()>Date.parse('2026-09-10T18:00:00Z'))throw Error('DIAGNOSTIC_NOT_AUTHORIZED');
 const cfg=JSON.parse(readFileSync('vercel.json','utf8'));
 const val=k=>process.env[k]??cfg.env?.[k]??'';
 if(val('GODADDY_BUSINESS_ID')!==BUSINESS||val('GODADDY_APPLICATION_ID')!==APP)throw Error('ACCOUNT_MISMATCH');
 if(['PMP_GODADDY_ENABLED','PMP_GODADDY_REVIEW_APPROVED','PMP_GODADDY_ACCEPTANCE_VERIFIED'].some(k=>val(k)!=='0'))throw Error('PAYMENTS_MUST_REMAIN_DISABLED');
 const privateKey=String(process.env.GODADDY_PRIVATE_KEY||'').replace(/\\n/g,'\n').trim();
 const assertion=createGoDaddyAssertion({applicationId:APP,privateKey});
 async function request(path,init){
  if(!((path==='/token'&&init.method==='POST')||(path==='/businesses/'+BUSINESS+'/stores'&&init.method==='GET')))throw Error('REQUEST_NOT_ALLOWED');
  const r=await fetch(HOST+path,{...init,redirect:'error',signal:AbortSignal.timeout(12000)});
  report.requests.push({path,method:init.method,status:r.status});
  if(!r.ok)throw Error('HTTP_'+r.status);
  if(!r.headers.get('content-type')?.includes('application/json'))throw Error('NON_JSON_RESPONSE');
  return r.json();
 }
 const auth=await request('/token',{method:'POST',headers:{'api-version':'1.2','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grantType:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}).toString()});
 if(typeof auth.accessToken!=='string'||!auth.accessToken)throw Error('TOKEN_MISSING');
 const data=await request('/businesses/'+BUSINESS+'/stores',{method:'GET',headers:{Authorization:'Bearer '+auth.accessToken,'api-version':'1.2',Accept:'application/json'}});
 const stores=Array.isArray(data)?data:Array.isArray(data.stores)?data.stores:Array.isArray(data.items)?data.items:null;
 if(!stores)throw Error('STORE_COLLECTION_UNEXPECTED');
 // Explicit field projection: never log merchant contacts, addresses or secrets.
 report.stores=stores.filter(s=>UUID.test(s?.id)).map(s=>({id:s.id,businessId:UUID.test(s.businessId)?s.businessId:null,currency:/^[A-Z]{3}$/.test(s.currency)?s.currency:null,status:/^[A-Z_]{1,40}$/.test(s.status)?s.status:null,keys:Object.keys(s).filter(k=>/^[A-Za-z0-9_]{1,50}$/.test(k)).slice(0,40)}));
 report.result='stores-read';
 report.storageConfigured=Boolean(process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN);
 report.shopifyConfigured=Boolean(process.env.SHOPIFY_ADMIN_TOKEN||process.env.SHOPIFY_ACCESS_TOKEN);
} catch(e){report.result='blocked';report.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'DIAGNOSTIC_FAILURE';}
console.log('GODADDY_STORE_DISCOVERY '+JSON.stringify(report));

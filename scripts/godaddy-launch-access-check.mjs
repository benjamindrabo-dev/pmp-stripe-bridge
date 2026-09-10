// One-off read-only diagnostic. Run only on the authorized preparation branch.
// No transaction, webhook registration, payout, Shopify write, or secret output.
import {readFileSync} from 'node:fs';
import {createGoDaddyAssertion} from '../lib/godaddy-payments.js';
const BRANCH='prep/godaddy-payments-20260909';
const BASE='https://services.poynt.net';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const report={revision:'launch-access-20260910',time:new Date().toISOString(),environment:process.env.VERCEL_ENV,requests:[],chargesCreated:0,settingsChanged:false};
try {
 if(process.argv[2]!=='--run'||process.env.VERCEL_ENV!=='preview'||process.env.VERCEL_GIT_COMMIT_REF!==BRANCH)throw Error('NOT_AUTHORIZED_CONTEXT');
 if(Date.now()>Date.parse('2026-09-11T00:00:00Z'))throw Error('DIAGNOSTIC_EXPIRED');
 const conf=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 const value=k=>process.env[k]||conf.env?.[k]||'';
 const businessId=value('GODADDY_BUSINESS_ID'),storeId=value('GODADDY_STORE_ID'),applicationId=value('GODADDY_APPLICATION_ID');
 if(!UUID.test(businessId)||!UUID.test(storeId)||businessId!=='3cfdebe4-e85d-41e9-9b26-96002a0c8654'||storeId!=='40c35dbb-13c6-466f-b3f7-d832c4fb58c0')throw Error('IDENTIFIER_MISMATCH');
 const privateKey=String(process.env.GODADDY_PRIVATE_KEY||'').replace(/\\n/g,'\n');
 const r=await fetch(BASE+'/token',{method:'POST',redirect:'error',headers:{'api-version':'1.2','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grantType:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:createGoDaddyAssertion({applicationId,privateKey})}),signal:AbortSignal.timeout(12000)});
 report.requests.push({operation:'authenticate',status:r.status});if(!r.ok)throw Error('AUTHENTICATION_FAILED');const token=await r.json();if(!token.accessToken)throw Error('TOKEN_MISSING');
 const reads=[['store',`/businesses/${businessId}/stores/${storeId}`],['hooks',`/hooks?businessId=${businessId}&applicationId=${encodeURIComponent(applicationId)}&limit=100`]];
 for(const [operation,path] of reads){
  const response=await fetch(BASE+path,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token.accessToken,'api-version':'1.2',Accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const entry={operation,status:response.status};report.requests.push(entry);
  if(!response.ok)continue;const data=await response.json();
  if(operation==='store'){entry.identifiersMatch=data.id===storeId&&data.businessId===businessId;entry.currency=/^[A-Z]{3}$/.test(data.currency)?data.currency:null;entry.storeActive=data.status==='ACTIVE';entry.mockProcessor=data.mockProcessor===true;}
  else {const hooks=Array.isArray(data)?data:data.hooks;if(!Array.isArray(hooks)){entry.validList=false;continue;}entry.validList=true;const matching=hooks.filter(h=>h.businessId===businessId&&h.applicationId===applicationId&&h.deliveryUrl==='https://pmp-stripe-bridge.vercel.app/api/godaddy-webhook');entry.matchingHooks=matching.map(h=>({id:UUID.test(h.id)?h.id:null,active:h.active===true,eventTypes:Array.isArray(h.eventTypes)?h.eventTypes.filter(t=>/^[A-Z_]+$/.test(t)):[]}));}
 }
 report.result='read-only-complete';
} catch(error){report.result='not-verified';report.error=/^[A-Z_]+$/.test(error.message)?error.message:'DIAGNOSTIC_FAILED';}
console.log('GODADDY_LAUNCH_ACCESS '+JSON.stringify(report));

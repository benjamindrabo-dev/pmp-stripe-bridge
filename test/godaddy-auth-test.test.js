import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { runGoDaddyReadOnlyTest } from '../scripts/godaddy-auth-test.mjs';

const BUSINESS='3cfdebe4-e85d-41e9-9b26-96002a0c8654';
const APP='urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f';
const STORE='11111111-1111-4111-8111-111111111111';
const key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const deploymentConfig={env:{GODADDY_BUSINESS_ID:BUSINESS,GODADDY_APPLICATION_ID:APP,PMP_GODADDY_ENABLED:'0',PMP_GODADDY_REVIEW_APPROVED:'0',PMP_GODADDY_ACCEPTANCE_VERIFIED:'0'}};
const env={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'prep/godaddy-payments-20260909',GODADDY_PRIVATE_KEY:key};
const now=()=>Date.parse('2026-09-10T12:00:00Z');
const ok=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
const successFetch=async(url,options)=>{
  assert.equal(options.redirect,'error');
  if(url.endsWith('/token')) {assert.equal(options.method,'POST');return ok({accessToken:'SECRET_TEST_TOKEN',expiresIn:86400});}
  assert.equal(options.method,'GET');
  if(url.endsWith('/businesses/'+BUSINESS))return ok({id:BUSINESS,status:'ACTIVATED',address:'PRIVATE_TEST_ADDRESS',stores:[{id:STORE,currency:'CAD',status:'ACTIVE'}]});
  if(url.endsWith('/stores/'+STORE))return ok({id:STORE,businessId:BUSINESS,currency:'CAD',status:'ACTIVE'});
  if(url.endsWith('/payLinks'))return ok({checkoutUrls:[]});
  throw Error('unexpected request');
};
const run=overrides=>runGoDaddyReadOnlyTest({env,deploymentConfig,now,fetchImpl:successFetch,...overrides});

test('success tests auth and GET access only without declaring migration ready',async()=>{
  const r=await run();assert.equal(r.authenticationSucceeded,true);assert.equal(r.merchantReadSucceeded,true);assert.equal(r.storeReadSucceeded,true);assert.equal(r.paylinksReadSucceeded,true);assert.equal(r.currency,'CAD');assert.equal(r.readyToMigrate,false);assert.equal(r.livePaymentsTested,false);assert.equal(r.payoutsTested,false);assert.deepEqual(r.providerRequests.map(x=>x.method),['POST','GET','GET','GET']);
  const text=JSON.stringify(r);assert.ok(!text.includes('SECRET_TEST_TOKEN'));assert.ok(!text.includes('PRIVATE_TEST_ADDRESS'));assert.ok(!text.includes('PRIVATE KEY'));
});
for(const change of [{VERCEL_ENV:'production'},{VERCEL_GIT_COMMIT_REF:'main'}]) test('does not contact provider outside exact preview scope '+JSON.stringify(change),async()=>{
 const r=await run({env:{...env,...change},fetchImpl:async()=>{throw Error('network forbidden');}});assert.equal(r.error,'PREVIEW_BRANCH_REQUIRED');assert.equal(r.providerRequests.length,0);
});
test('refuses missing key before network',async()=>{const r=await run({env:{...env,GODADDY_PRIVATE_KEY:''}});assert.equal(r.error,'PRIVATE_KEY_MISSING');assert.equal(r.providerRequests.length,0);});
test('refuses malformed key without leaking it',async()=>{const r=await run({env:{...env,GODADDY_PRIVATE_KEY:'secret-bad-value'}});assert.equal(r.error,'PRIVATE_KEY_INVALID_FORMAT');assert.ok(!JSON.stringify(r).includes('secret-bad-value'));});
test('refuses changed merchant id before network',async()=>{const r=await run({env:{...env,GODADDY_BUSINESS_ID:STORE}});assert.equal(r.error,'MERCHANT_IDENTIFIERS_MISMATCH');assert.equal(r.providerRequests.length,0);});
test('refuses enabled migration flags before network',async()=>{const r=await run({env:{...env,PMP_GODADDY_ENABLED:'1'}});assert.equal(r.error,'DISABLED_ACTIVATION_FLAGS_REQUIRED');assert.equal(r.providerRequests.length,0);});
test('network errors redact original message',async()=>{const r=await run({fetchImpl:async()=>{throw Error('SECRET_TEST_TOKEN');}});assert.equal(r.error,'PROVIDER_NETWORK_OR_REDIRECT_FAILURE');assert.ok(!JSON.stringify(r).includes('SECRET_TEST_TOKEN'));});
test('provider rejection distinguished from configuration',async()=>{const r=await run({fetchImpl:async()=>new Response('secret-detail',{status:401})});assert.equal(r.error,'PROVIDER_HTTP_401');assert.equal(r.failedStage,'authentication');assert.equal(r.authenticationSucceeded,false);assert.ok(!JSON.stringify(r).includes('secret-detail'));});
test('merchant response must match selected business',async()=>{const r=await run({fetchImpl:async(u,o)=>u.endsWith('/businesses/'+BUSINESS)?ok({id:STORE}):successFetch(u,o)});assert.equal(r.error,'BUSINESS_RESPONSE_MISMATCH');assert.equal(r.authenticationSucceeded,true);assert.equal(r.merchantReadSucceeded,false);});
test('ambiguous store requires selection without guessing',async()=>{const r=await run({fetchImpl:async(u,o)=>u.endsWith('/businesses/'+BUSINESS)?ok({id:BUSINESS,stores:[{id:STORE},{id:'22222222-2222-4222-8222-222222222222'}]}):successFetch(u,o)});assert.equal(r.error,'STORE_SELECTION_REQUIRED');assert.equal(r.providerRequests.length,2);});
test('does not treat HTML login response as Pay Links access',async()=>{const r=await run({fetchImpl:async(u,o)=>u.endsWith('/payLinks')?new Response('<html>login</html>',{status:200,headers:{'Content-Type':'text/html'}}):successFetch(u,o)});assert.equal(r.error,'PROVIDER_NON_JSON_RESPONSE');assert.equal(r.paylinksReadSucceeded,false);});
test('one-off window prevents later network runs',async()=>{const r=await run({now:()=>Date.parse('2026-09-11T00:00:00Z')});assert.equal(r.error,'ONE_OFF_TEST_WINDOW_EXPIRED');assert.equal(r.providerRequests.length,0);});

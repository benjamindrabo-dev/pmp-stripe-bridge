import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureStripeWalletDomain,STRIPE_WALLET_DOMAIN} from '../lib/stripe-wallet-domain.js';
const domain={domain_name:STRIPE_WALLET_DOMAIN,livemode:true,enabled:true,apple_pay:{status:'active'},google_pay:{status:'active'}};
test('existing live checkout domain is reused without writing',async()=>{
  const calls=[];const r=await ensureStripeWalletDomain(async(path,body)=>{calls.push({path,body});return {data:[domain]};});
  assert.equal(calls.length,1);assert.equal(calls[0].body,undefined);assert.equal(r.applePay,'active');
});
test('missing domain is registered with a fixed name and stable idempotency key',async()=>{
  const calls=[];const r=await ensureStripeWalletDomain(async(path,body,key)=>{calls.push({path,body,key});return body?domain:{data:[]};});
  assert.equal(calls.length,2);assert.equal(calls[1].path,'/payment_method_domains');
  assert.deepEqual(calls[1].body,{domain_name:STRIPE_WALLET_DOMAIN,enabled:'true'});
  assert.equal(calls[1].key,'pmp-checkout-wallet-domain-v1');assert.equal(r.enabled,true);
});
test('other domains and test-mode objects cannot stand in for the live checkout domain',async()=>{
  let writes=0;await ensureStripeWalletDomain(async(path,body)=>{if(body){writes++;return domain;}return {data:[{...domain,domain_name:'other.invalid'},{...domain,livemode:false}]};});assert.equal(writes,1);
});
test('an unexpected registration result is rejected',async()=>{
  await assert.rejects(()=>ensureStripeWalletDomain(async(path,body)=>body?{...domain,domain_name:'other.invalid'}:{data:[]}),/mismatch/);
});
test('disabled existing domains are reported without silently overriding their status',async()=>{
  const r=await ensureStripeWalletDomain(async()=>({data:[{...domain,enabled:false}]}));assert.equal(r.enabled,false);
});

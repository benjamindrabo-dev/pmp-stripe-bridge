import test from 'node:test';
import assert from 'node:assert/strict';
import {captureCheckoutStage} from '../lib/square-progress.js';

test('checkout stages retain first timestamps, deduplicate Meta, and honor consent',async()=>{
 const original=global.fetch;
 const env={...process.env};
 process.env.UPSTASH_REDIS_REST_URL='https://redis.invalid';
 process.env.META_PIXEL_ID='test';process.env.META_CAPI_TOKEN='test';
 const id='sq_'+'b'.repeat(32), sent=[],queued=[];
 const cart={subtotal:8198,scale:100,displayCurrency:'USD',email:'buyer@example.invalid',attribution:{marketing_allowed:false,journey_id:'test-journey'},items:[{variant_id:1,quantity:1,price_cents:8198}],ip:'192.0.2.1',ua:'test'};
 const records=new Map([['sess:'+id,JSON.stringify(cart)]]);
 global.fetch=async(url,opts)=>{
  const body=JSON.parse(opts.body);let result=null;
  if(url==='https://redis.invalid'){
   const [op,k,v,...rest]=body;
   if(op==='GET')result=records.get(k)||null;
   else if(op==='SET'){if(!rest.includes('NX')||!records.has(k)){records.set(k,v);result='OK';}}
   else if(op==='RPUSH'){queued.push(v);result=queued.length;}
   else throw Error(op);
   return new Response(JSON.stringify({result}),{status:200});
  }
  assert.ok(String(url).startsWith('https://graph.facebook.com/'));
  sent.push(body);return new Response(JSON.stringify({events_received:1}),{status:200});
 };
 try{
  assert.equal((await captureCheckoutStage(id,'details_started')).meta,'consent_not_granted');
  assert.equal(sent.length,0);
  const first=records.get('square:progress:'+id+':details_started');
  cart.attribution.marketing_allowed=true;records.set('sess:'+id,JSON.stringify(cart));
  await captureCheckoutStage(id,'details_started');await captureCheckoutStage(id,'details_started');
  assert.equal(records.get('square:progress:'+id+':details_started'),first);
  assert.equal(sent.length,1);
  await captureCheckoutStage(id,'payment_started');await captureCheckoutStage(id,'payment_info_added');
  assert.deepEqual(sent.map(x=>x.data[0].event_name),['CheckoutDetailsStarted','PaymentInfoStarted','AddPaymentInfo']);
  assert.equal(new Set(sent.map(x=>x.data[0].event_id)).size,3);
  for(const x of sent){assert.equal(x.data[0].custom_data.value,81.98);assert.equal(x.data[0].custom_data.currency,'USD');assert.ok(!JSON.stringify(x).includes('buyer@example.invalid'));}
  assert.equal(records.has('meta:'+id),false,'Never overwrite Purchase outbox');
  await assert.rejects(()=>captureCheckoutStage(id,'Purchase'));
  records.set('done:'+id,'{}');assert.equal((await captureCheckoutStage(id,'details_started')).ignored,true);
 }finally{global.fetch=original;process.env=env;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {squareAccountScope,activeSquare} from '../lib/square-bridge.js';
import {verify} from '../api/square-webhook.js';
import crypto from 'node:crypto';
const source=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('webhook and Apple Pay caches are scoped to application and location',()=>{
  const a={SQUARE_ENV:'production',SQUARE_APPLICATION_ID:'appA',SQUARE_LOCATION_ID:'locA'};
  assert.equal(squareAccountScope(a),squareAccountScope({...a}));
  for(const [key,value]of [['SQUARE_ENV','sandbox'],['SQUARE_APPLICATION_ID','appB'],['SQUARE_LOCATION_ID','locB']])assert.notEqual(squareAccountScope(a),squareAccountScope({...a,[key]:value}));
});
test('Square is active even if an obsolete Stripe flag remains',()=>{const old=process.env.CHECKOUT_PROVIDER;try{process.env.CHECKOUT_PROVIDER='stripe';assert.equal(activeSquare(),true);}finally{if(old===undefined)delete process.env.CHECKOUT_PROVIDER;else process.env.CHECKOUT_PROVIDER=old;}});
test('new webhook uses its account-scoped key, not the old environment override',()=>{const s=source('api/square-webhook.js');assert.ok(s.includes('get(squareWebhookKey())'));assert.ok(!s.includes('process.env.SQUARE_WEBHOOK_SIGNATURE_KEY'));assert.ok(s.includes('!validId(payment.reference_id)'));});
test('only a matching signing key validates a Square event',()=>{const raw='{"type":"pmp.configuration_probe"}';const key='test-key-not-a-credential';const url='https://pmp-stripe-bridge.vercel.app/api/square-webhook';const signature=crypto.createHmac('sha256',key).update(url+raw).digest('base64');assert.equal(verify(raw,signature,key),true);assert.equal(verify(raw,signature,'old-account-test-key'),false);assert.equal(verify(raw,'invalid',key),false);});
test('old account payment requests cannot be submitted to the new location',()=>{assert.ok(source('lib/square-bridge.js').includes('attempt.request.location_id!==process.env.SQUARE_LOCATION_ID'));});

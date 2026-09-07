import test from 'node:test';
import assert from 'node:assert/strict';
import { createFxQuote, assertPayableQuote, loadDailyRates } from '../lib/square-fx.js';
const now = Date.parse('2026-09-07T12:00:00Z');
const data = { result:'success', base_code:'CAD', time_last_update_unix: now / 1000 - 3600,
  rates: { CAD:1, USD:0.75, AUD:1.1, EUR:0.65, GBP:0.55, MXN:13, BRL:4, CLP:650, JPY:110, KWD:0.22 } };
test('local purchase amounts stay exact while CAD debit uses daily FX', () => {
  const expected = { USD:13333, AUD:9091, EUR:15385, GBP:18182, MXN:769, BRL:2500, CLP:15, JPY:91, KWD:45455 };
  for (const [displayCurrency, chargeMinor] of Object.entries(expected)) {
    const q = createFxQuote({ displayCurrency, displayAmount:'100.00', rates:data, now });
    assert.equal(q.chargeMinor, chargeMinor, displayCurrency);
    assert.equal(q.displayAmount, '100.00');
    assert.equal(q.displayCurrency, displayCurrency);
    assert.equal(q.ratePublishedAt, '2026-09-07T11:00:00.000Z');
  }
});
test('preserves small amounts and currency precision without float rounding', () => {
  assert.equal(createFxQuote({displayCurrency:'USD',displayAmount:'1.50',rates:data,now}).chargeMinor,200);
  assert.equal(createFxQuote({displayCurrency:'JPY',displayAmount:'1100',rates:data,now}).chargeMinor,1000);
  assert.equal(createFxQuote({displayCurrency:'KWD',displayAmount:'0.220',rates:data,now}).chargeMinor,100);
  assert.equal(createFxQuote({displayCurrency:'CAD',displayAmount:'1.005',now}).chargeMinor,101);
});
test('saved quote does not change when a later rate arrives; expires before charging', () => {
  const q = createFxQuote({displayCurrency:'USD',displayAmount:'1.50',rates:data,now});
  const changed = {...data,rates:{...data.rates,USD:0.5}};
  assert.equal(createFxQuote({displayCurrency:'USD',displayAmount:'1.50',rates:changed,now}).chargeMinor,300);
  assert.equal(q.chargeMinor,200);
  assert.equal(assertPayableQuote(q,now+1000),q);
  assert.throws(()=>assertPayableQuote(q,now+1800000));
});
test('fails closed for unsupported currencies, stale rates and invalid amounts', () => {
  for (const displayAmount of ['-1','NaN','Infinity','0','1;alert(1)','999999999999999999999']) {
    assert.throws(()=>createFxQuote({displayCurrency:'USD',displayAmount,rates:data,now}));
  }
  assert.throws(()=>createFxQuote({displayCurrency:'XXX',displayAmount:'100',rates:data,now}));
  assert.throws(()=>createFxQuote({displayCurrency:'USD',displayAmount:'100',rates:data,now:now+37*3600000}));
});
test('uses a fresh cached daily rate without another network call', async () => {
  let called=false;
  const rates=await loadDailyRates({now,readCache:async()=>({fetchedAt:now-1000,data}),fetcher:async()=>{called=true;throw Error('Unexpected fetch');}});
  assert.equal(rates,data); assert.equal(called,false);
});
test('refreshes old cache and rejects provider failures', async () => {
  let saved;
  assert.equal(await loadDailyRates({now,readCache:async()=>({fetchedAt:now-7200000,data}),writeCache:async x=>{saved=x;},fetcher:async()=>({ok:true,json:async()=>data})}),data);
  assert.equal(saved.fetchedAt,now);
  await assert.rejects(()=>loadDailyRates({now,fetcher:async()=>({ok:false})}));
});

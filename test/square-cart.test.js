import test from 'node:test';
import assert from 'node:assert/strict';
import {reviseCart,suggestions} from '../lib/square-cart.js';
import {paySquare} from '../lib/square-bridge.js';
const id='sq_'+'c'.repeat(32);
function harness(){
 const original=global.fetch;const db=new Map();
 const cart={id,country:'US',displayCurrency:'USD',scale:100,locale:'en',attribution:{},catalogPrices:{'gid://shopify/ProductVariant/1':10},items:[{variant_id:1,title:'Main',quantity:3,price_cents:1000,original_price_cents:1000},{variant_id:1,title:'Gift',quantity:2,price_cents:0,original_price_cents:0}],suggestions:[{variant_id:2,title:'Add-on'}]};
 db.set('sess:'+id,JSON.stringify(cart));db.set('square:webhook:production',JSON.stringify({signature_key:'test'}));db.set('square:apple-pay:production',JSON.stringify({status:'VERIFIED'}));
 Object.assign(process.env,{SQUARE_ENV:'production',SQUARE_ACCESS_TOKEN:'fake',SQUARE_LOCATION_ID:'LOC',UPSTASH_REDIS_REST_URL:'https://redis.invalid',SHOPIFY_STORE_DOMAIN:'test.invalid'});
 const response=x=>new Response(JSON.stringify(x));
 global.fetch=async(url,opts={})=>{
  const b=opts.body?JSON.parse(opts.body):null;
  if(url==='https://redis.invalid'){const [op,k,v,...rest]=b;if(op==='GET')return response({result:db.get(k)||null});if(op==='SET'){if(rest.includes('NX')&&db.has(k))return response({result:null});db.set(k,v);return response({result:'OK'});}if(op==='EVAL'){db.delete(b[3]);return response({result:1});}throw Error(op);}
  if(url.includes('/locations/'))return response({location:{currency:'CAD',status:'ACTIVE',capabilities:['CREDIT_CARD_PROCESSING']}});
  if(url.includes('open.er-api.com'))return response({result:'success',base_code:'CAD',time_last_update_unix:Math.floor(Date.now()/1000),rates:{CAD:1,USD:0.75,EUR:0.65}});
  if(url.includes('graphql.json'))return response({data:{nodes:b.variables.ids.map(gid=>({id:gid,inventoryPolicy:'DENY',inventoryQuantity:100,contextualPricing:{price:{amount:gid.endsWith('/2')?'7':b.variables.country==='FR'?'9':'10',currencyCode:b.variables.country==='FR'?'EUR':'USD'}},product:{id:'p'+gid,title:'Product',status:'ACTIVE'}}))}});
  throw Error('Unexpected external request');
 };
 return {db,cart,restore:()=>{global.fetch=original;}};
}
test('country change reprices paid units, keeps gifts, and invalidates old payment quote',async()=>{
 const h=harness();try{const next=await reviseCart(id,{country:'FR'});const cart=JSON.parse(h.db.get('sess:'+next.sessionId));assert.equal(cart.displayCurrency,'EUR');assert.equal(cart.items[0].price_cents,900);assert.equal(cart.items[1].price_cents,0);assert.equal(cart.items[1].quantity,2);assert.equal(cart.quote.displayAmount,'27.00');await assert.rejects(()=>paySquare(id,{}),/updated/);}finally{h.restore();}
});
test('add-on amount comes from Shopify and survives in exact order total',async()=>{
 const h=harness();try{const next=await reviseCart(id,{addVariant:2,price_cents:1});const cart=JSON.parse(h.db.get('sess:'+next.sessionId));assert.equal(cart.items.at(-1).price_cents,700);assert.equal(cart.items.at(-1).addon,true);assert.equal(cart.quote.displayAmount,'37.00');assert.deepEqual(await suggestions(cart),[]);}finally{h.restore();}
});
test('country/add-on edits are refused once payment has started',async()=>{
 const h=harness();try{h.db.set('square:attempt:'+id,JSON.stringify({paymentId:'pending'}));await assert.rejects(()=>reviseCart(id,{country:'FR'}),/already/);assert.equal(JSON.parse(h.db.get('sess:'+id)).country,'US');}finally{h.restore();}
});

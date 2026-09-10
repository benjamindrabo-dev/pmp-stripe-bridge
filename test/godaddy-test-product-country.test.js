import test from 'node:test';
import assert from 'node:assert/strict';
import {purchasableStatus,checkoutCountry,snapshotForCountry,CHECKOUT_COUNTRIES} from '../public/godaddy-country-contract.js';
import {recalculateShopifyCart,repriceShopifyCart} from '../lib/godaddy-storefront-cart.js';
const ID=43866373914698;
function snapshot(currency='USD',amount=100,quantity=1){return {currency,total_price:amount,items_subtotal_price:amount,item_count:quantity,cart_level_discount_applications:[],items:[{variant_id:ID,quantity,final_line_price:amount,original_line_price:amount,product_title:'Test fixture'}]};}
for(const status of ['ACTIVE','UNLISTED'])test('purchasable status '+status,()=>assert.equal(purchasableStatus(status),true));
for(const status of ['DRAFT','ARCHIVED',undefined,'UNKNOWN'])test('reject status '+status,()=>assert.equal(purchasableStatus(status),false));
test('country normalization and configured countries',()=>{assert.equal(checkoutCountry(' ca '),'CA');assert.ok(CHECKOUT_COUNTRIES.includes('US'));assert.ok(CHECKOUT_COUNTRIES.includes('FR'));assert.equal(CHECKOUT_COUNTRIES.length,new Set(CHECKOUT_COUNTRIES).size);});
for(const code of ['ZZ','USA','https://example.test',null])test('reject malformed or unconfigured country '+code,()=>assert.throws(()=>checkoutCountry(code),e=>e.code==='COUNTRY_NOT_AVAILABLE'));
test('country merchandise preserves quantities and properties but drops stale advertised market total',()=>{
 const s=snapshot();s.items[0].properties={'Bundle offer':'1 Bottle',_pmp_bundle:'1',_pmp_offer_total_cents:'100'};
 const c={sourceSnapshot:s,items:[{variant_id:ID,quantity:1,sourceLine:0,original_price_cents:100,title:'Test fixture'}]};
 const original=JSON.stringify(c),next=snapshotForCountry(c);
 assert.equal(next.items[0].quantity,1);assert.equal(next.items[0].properties._pmp_bundle,'1');assert.equal(next.items[0].properties._pmp_offer_total_cents,undefined);assert.equal(JSON.stringify(c),original);
});
test('country merchandise includes added dental quantity once',()=>{
 const c={sourceSnapshot:snapshot(),items:[{variant_id:ID,quantity:1,sourceLine:0,original_price_cents:100},{variant_id:43668777631818,quantity:1,addon:true,original_price_cents:6800}]};
 const s=snapshotForCountry(c);assert.equal(s.item_count,2);assert.equal(s.items[1].variant_id,43668777631818);assert.deepEqual(s.items[1].properties,{});
});
test('old quotes without source metadata require reopening the cart',()=>assert.throws(()=>snapshotForCountry({items:[]}),e=>e.code==='COUNTRY_CHANGE_RELOAD_REQUIRED'));
async function mockShopify(actual,run){
 const native=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(url);assert.equal(u.origin,'https://www.puremajestypet.com');calls.push({path:u.pathname,method:init.method||'GET'});
  assert.ok(!/payment|transaction|tokenize/.test(u.pathname));
  if(u.pathname==='/localization')return new Response(null,{status:302,headers:{location:'/en-ca/cart'}});
  return new Response(JSON.stringify(u.pathname.endsWith('/cart.js')?actual:{}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{return await run(calls);}finally{globalThis.fetch=native;}
}
test('incoming cart equality checks are not relaxed by country repricing support',async()=>{
 await mockShopify(snapshot('CAD',200),async()=>assert.rejects(recalculateShopifyCart(snapshot(),{country:'CA'}),e=>e.code==='SHOPIFY_CART_TOTAL_CHANGED'));
});
test('country edit uses new Shopify currency and total and preserves original source object',async()=>{
 const old=snapshot(),before=JSON.stringify(old);
 await mockShopify(snapshot('CAD',200),async calls=>{
  const next=await repriceShopifyCart(old,{country:'CA'});assert.equal(next.currency,'CAD');assert.equal(next.total_price,200);assert.equal(next.items[0].quantity,1);assert.equal(JSON.stringify(old),before);assert.ok(calls.some(c=>c.path==='/en-ca/cart.js'));
 });
});
test('country edit never silently adds or removes merchandise',async()=>{
 await mockShopify(snapshot('CAD',400,2),async()=>assert.rejects(repriceShopifyCart(snapshot(),{country:'CA'}),e=>e.code==='SHOPIFY_CART_LINES_CHANGED'));
});

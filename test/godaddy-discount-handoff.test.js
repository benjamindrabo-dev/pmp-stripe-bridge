import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {compactCart,appliedDiscountCodes} from '../public/godaddy-cart-snapshot.js';
import {snapshotToInput} from '../public/godaddy-cart-contract.js';
import {recalculateShopifyCart} from '../lib/godaddy-storefront-cart.js';
import storefrontHelper from '../api/meta-offer-summary.js';

const fixture=()=>({currency:'USD',total_price:2560,items_subtotal_price:3199,item_count:1,cart_level_discount_applications:[{type:'discount_code',title:'WELCOME20',total_allocated_amount:639}],items:[{variant_id:43349565112394,quantity:1,final_line_price:3199,original_line_price:3199,product_title:'Synthetic product',properties:{'_pmp_bundle':'1','email':'do-not-forward@example.invalid'}}]});
const codeIs=code=>error=>error.code===code;
function mockShopify(actual,{discountFails=false}={}){
 const calls=[];let applied=false;
 return {calls,fetch:async(url,options={})=>{
  const path=new URL(url).pathname;const body=options.body?String(options.body):null;calls.push({path,body});
  if(path.endsWith('/cart/update.js')){assert.deepEqual(JSON.parse(body),{discount:'WELCOME20'});if(discountFails)return new Response('{}',{status:422});applied=true;}
  if(path.endsWith('/cart.js')){assert.equal(applied,true,'Discount must be revalidated before reading amount');return new Response(JSON.stringify(actual),{status:200,headers:{'Content-Type':'application/javascript'}});}
  return new Response('{}',{status:200});
 }};
}
test('compact cart retains the code and only approved bundle metadata',()=>{
 const cart=compactCart(fixture());assert.deepEqual(appliedDiscountCodes(cart),['WELCOME20']);assert.equal(cart.cart_level_discount_applications[0].type,'discount_code');assert.deepEqual(cart.items[0].properties,{'_pmp_bundle':'1'});
 assert.ok(!JSON.stringify(cart).includes('do-not-forward'));
});
test('repeated compaction retains discounts',()=>assert.deepEqual(compactCart(compactCart(fixture())),compactCart(fixture())));
test('line and cart codes are collected once; inapplicable and unsafe codes excluded',()=>{
 const cart=fixture();cart.discount_codes=[{code:'welcome20',applicable:true},{code:'NOPE',applicable:false},{code:'unsafe\ncode'}];cart.items[0].line_level_discount_allocations=[{discount_application:{type:'discount_code',title:'WELCOME20'}}];
 assert.deepEqual(appliedDiscountCodes(cart),['welcome20']);
});
test('preserve Shopify rounded discount exactly: 31.99 minus 6.39 is 25.60',()=>{
 const input=snapshotToInput(compactCart(fixture()),{country:'US',locale:'en'});assert.equal(input.cartSubtotalMinor,2560);assert.equal(input.items.reduce((n,i)=>n+i.quantity*i.price_cents,0),2560);
});
test('server replays discount in Shopify then checks exact totals',async()=>{
 const native=globalThis.fetch,mock=mockShopify(fixture());globalThis.fetch=mock.fetch;
 try{const result=await recalculateShopifyCart(compactCart(fixture()),{country:'US',root:'/'});assert.equal(result.total_price,2560);assert.ok(mock.calls.some(c=>c.path==='/cart/update.js'));assert.equal(mock.calls.at(-1).path,'/cart/clear.js');}
 finally{globalThis.fetch=native;}
});
test('forged lower total remains rejected even with a real discount code',async()=>{
 const native=globalThis.fetch,mock=mockShopify(fixture());globalThis.fetch=mock.fetch;
 try{await assert.rejects(recalculateShopifyCart({...compactCart(fixture()),total_price:100},{country:'US',root:'/'}),codeIs('SHOPIFY_CART_TOTAL_CHANGED'));}
 finally{globalThis.fetch=native;}
});
test('invalid discount fails closed and still clears only the isolated cart',async()=>{
 const native=globalThis.fetch,mock=mockShopify(fixture(),{discountFails:true});globalThis.fetch=mock.fetch;
 try{await assert.rejects(recalculateShopifyCart(compactCart(fixture()),{country:'US',root:'/'}),codeIs('SHOPIFY_CART_DISCOUNT_REJECTED'));assert.equal(mock.calls.at(-1).path,'/cart/clear.js');}
 finally{globalThis.fetch=native;}
});
test('frontend helper compiles and keeps discount identifiers',()=>{
 let js;const res={setHeader(){},status(){return this;},send(value){js=value;}};storefrontHelper({method:'GET'},res);assert.doesNotThrow(()=>new Script(js));
 assert.match(js,/Preserve Shopify discount identifiers/);assert.match(js,/discount_codes:/);assert.match(js,/line_level_discount_allocations:/);assert.match(js,/try \{ beginCheckout\(data\); \} catch/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {allocate,buildOrder,paySquare,settleSquarePayment,WEBHOOK_URL,safeReturnPath} from '../lib/square-bridge.js';
import {verify} from '../api/square-webhook.js';
const id='sq_'+'a'.repeat(32);
const cart={id,displayCurrency:'USD',scale:100,subtotal:150,total:150,shippingDisplay:0,items:[{variant_id:1,title:'Test',quantity:3,price_cents:50}],quote:{version:1,displayCurrency:'USD',displayAmount:'1.50',chargeCurrency:'CAD',chargeMinor:200,displayUnitsPerCad:'0.75',createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+600000).toISOString()},attribution:{},country:'US'};
const address={first_name:'Test',last_name:'Buyer',address_line_1:'Test Street',locality:'Test City',country:'US',administrative_district_level_1:'NY',postal_code:'10001'};
const attempt={email:'test@example.invalid',shipping:address,billing:address};
const payment={id:'payment-1',reference_id:id,location_id:'LOC',status:'COMPLETED',amount_money:{amount:200,currency:'CAD'},created_at:new Date().toISOString()};
test('CAD allocation keeps exact total with bundles and gifts',()=>{
 assert.deepEqual(allocate(200,[50,50,50]),[67,67,66]);
 assert.deepEqual(allocate(200,[0,150,0]),[0,200,0]);
 const order=buildOrder(cart,payment,attempt);
 assert.equal(order.presentmentCurrency,'USD');
 assert.equal(order.transactions[0].amountSet.presentmentMoney.amount,'1.50');
 assert.equal(order.transactions[0].amountSet.shopMoney.amount,'2.00');
 assert.equal(order.lineItems.reduce((s,l)=>s+Math.round(Number(l.priceSet.shopMoney.amount)*100)*l.quantity,0),200);
 assert.equal(order.lineItems.reduce((s,l)=>s+Math.round(Number(l.priceSet.presentmentMoney.amount)*100)*l.quantity,0),150);
});
test('webhook signature binds both full URL and raw payload',()=>{
 const raw='{"test":true}',key='secret';const h=crypto.createHmac('sha256',key).update(WEBHOOK_URL+raw).digest('base64');
 assert.equal(verify(raw,h,key),true);assert.equal(verify(raw+' ',h,key),false);assert.equal(verify(raw,'x',key),false);assert.equal(verify(raw,h,''),false);
});
test('market return path survives Spanish checkout and rejects external URLs',()=>{
 assert.equal(safeReturnPath({landing_page:'https://www.puremajestypet.com/es-es/products/x'},'ES'),'https://www.puremajestypet.com/es-es/pages/thank-you');
 assert.equal(safeReturnPath({landing_page:'https://evil.invalid/fr-fr/x'},'US'),'https://www.puremajestypet.com/pages/thank-you');
});
function harness({ambiguous=false}={}){
 const original=global.fetch;const store=new Map([['sess:'+id,JSON.stringify(cart)]]);let posts=0,orders=0,created=false;
 process.env.SQUARE_ENV='production';process.env.SQUARE_ACCESS_TOKEN='fake';process.env.SQUARE_LOCATION_ID='LOC';process.env.SHOPIFY_STORE_DOMAIN='test.invalid';process.env.UPSTASH_REDIS_REST_URL='https://redis.invalid';
 const result=x=>new Response(JSON.stringify(x),{status:200,headers:{'Content-Type':'application/json'}});
 global.fetch=async(url,opts={})=>{
  const body=opts.body?JSON.parse(opts.body):null;
  if(url==='https://redis.invalid'){
    const [op,k,v,...rest]=body;
    if(op==='GET')return result({result:store.get(k)||null});
    if(op==='SET'){if(rest.includes('NX')&&store.has(k))return result({result:null});store.set(k,v);return result({result:'OK'});}
    if(op==='EVAL'){const key=body[3],token=body[4];if(store.get(key)===token)store.delete(key);return result({result:1});}
    if(op==='RPUSH')return result({result:1});
    throw Error('Unexpected Redis '+op);
  }
  if(String(url).endsWith('/v2/payments')){posts++;return result({payment});}
  if(String(url).includes('/v2/payments/'))return result({payment});
  if(String(url).includes('graphql.json')){
   if(body.query.startsWith('query SquareExisting'))return result({data:{orders:{nodes:created?[{id:'gid://shopify/Order/1',legacyResourceId:'1',name:'#TEST'}]:[]}}});
   if(body.query.startsWith('mutation SquareOrder')){orders++;created=true;if(ambiguous)throw Error('Network dropped');return result({data:{orderCreate:{order:{id:'gid://shopify/Order/1',legacyResourceId:'1',name:'#TEST'},userErrors:[]}}});}
  }
  throw Error('Unexpected URL '+url);
 };
 return {store,counts:()=>({posts,orders}),restore:()=>{global.fetch=original;}};
}
test('repeated payment submits create one payment and one order, erase card token',async()=>{
 const h=harness();try{
 const body={sourceId:'card-token',email:attempt.email,shipping:address,confirmedChargeMinor:200};
 assert.equal((await paySquare(id,body)).paid,true);
 assert.equal((await paySquare(id,{...body,sourceId:'another-token'})).paid,true);
 assert.deepEqual(h.counts(),{posts:1,orders:1});
 assert.equal(JSON.parse(h.store.get('square:attempt:'+id)).request,undefined);
 }finally{h.restore();}
});
test('ambiguous Shopify response retains lease and reconciles without a second order',async()=>{
 const h=harness({ambiguous:true});try{
 await assert.rejects(()=>paySquare(id,{sourceId:'token',email:attempt.email,shipping:address,confirmedChargeMinor:200}));
 assert.ok(h.store.has('square:order-lock:'+id));
 h.store.delete('square:order-lock:'+id); // Simulate lease expiry, then Square redelivery.
 assert.equal((await settleSquarePayment(payment.id)).paid,true);
 assert.deepEqual(h.counts(),{posts:1,orders:1});
 }finally{h.restore();}
});
test('tampered CAD total cannot cause a charge',async()=>{
 const h=harness();try{await assert.rejects(()=>paySquare(id,{sourceId:'token',email:attempt.email,shipping:address,confirmedChargeMinor:1}));assert.deepEqual(h.counts(),{posts:0,orders:0});}finally{h.restore();}
});

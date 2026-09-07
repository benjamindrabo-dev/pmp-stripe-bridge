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
 assert.equal(order.presentmentCurrency,'USD');assert.ok(order.lineItems.every(line=>line.requiresShipping===true),'Physical products and gifts must require shipping for fulfillment and notification addresses');assert.equal(order.sourceName,undefined,'Let Shopify attribute the order to the authenticated app, not protected web source');
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
   if(body.query.startsWith('mutation SquareOrder')){assert.equal(body.variables.order.transactions[0].receiptJson,undefined,'Do not send a serialized receipt string to Shopify');assert.equal(body.variables.options.sendReceipt,true);orders++;created=true;if(ambiguous)throw Error('Network dropped');return result({data:{orderCreate:{order:{id:'gid://shopify/Order/1',legacyResourceId:'1',name:'#TEST'},userErrors:[]}}});}
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

test('captured payment with delayed Shopify creation returns pending, never a retry-payment error',async()=>{
 const {default:handler}=await import('../api/square-pay.js');
 const h=harness({ambiguous:true});try{
 const req={method:'POST',body:{sessionId:id,sourceId:'wallet-token',email:attempt.email,shipping:address,confirmedChargeMinor:200}};
 const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
 await handler(req,res);
 assert.equal(res.code,200);assert.deepEqual(res.body,{paid:false,pending:true});
 assert.deepEqual(h.counts(),{posts:1,orders:1});
 }finally{h.restore();}
});

test('merchant discount breakdown preserves captured total in both currencies and free gifts',()=>{
 for(const [currency,scale,original,net,charge,rate,code] of [
  ['USD',100,3199,2559,7079,0.723026,'WELCOME20'],
  ['CAD',100,4500,3600,7200,1,'WELCOME20'],
  ['EUR',100,2999,2699,8305,0.65,'THANK10'],
  ['JPY',100,450000,360000,7200,100,'WELCOME20'],
  ['KWD',1000,9990,7992,7104,0.225,'WELCOME20']
 ]) {
  const c={...cart,displayCurrency:currency,scale,promotionCode:code,items:[{variant_id:1,quantity:2,original_price_cents:original,price_cents:net},{variant_id:1,quantity:1,original_price_cents:0,price_cents:0}],subtotal:net*2,total:net*2,quote:{...cart.quote,chargeMinor:charge,displayUnitsPerCad:String(rate)}};
  const o=buildOrder(c,payment,attempt),d=o.discountCode.itemFixedDiscountCode;
  assert.match(d.code,code==='WELCOME20'?/20% off/:/10% off/);
  for(const [key,unit,total] of [['shopMoney',100,charge],['presentmentMoney',scale,c.total]]){
   const gross=o.lineItems.reduce((sum,l)=>sum+Math.round(Number(l.priceSet[key].amount)*unit)*l.quantity,0);
   assert.equal(gross-Math.round(Number(d.amountSet[key].amount)*unit),total,currency+' exact '+key);
  }
  assert.equal(o.lineItems.filter(l=>Number(l.priceSet.presentmentMoney.amount)===0).reduce((n,l)=>n+l.quantity,0),1);
  assert.equal(o.transactions[0].amountSet.shopMoney.amount,(charge/100).toFixed(2));
 }
});
test('undiscounted and legacy carts do not acquire a discount',()=>{
 assert.equal(buildOrder(cart,payment,attempt).discountCode,undefined);
 assert.equal(buildOrder({...cart,promotionCode:'WELCOME20'},payment,attempt).discountCode,undefined);
});
test('promotion does not discount shipping',()=>{
 const c={...cart,promotionCode:'WELCOME20',items:[{variant_id:1,quantity:2,original_price_cents:100,price_cents:80}],subtotal:160,shippingDisplay:40,total:200,quote:{...cart.quote,chargeMinor:267}};
 const o=buildOrder(c,payment,attempt),d=o.discountCode.itemFixedDiscountCode.amountSet;
 for(const [key,unit,total] of [['shopMoney',100,267],['presentmentMoney',100,200]]) {
  const gross=o.lineItems.reduce((n,l)=>n+Math.round(Number(l.priceSet[key].amount)*unit)*l.quantity,0);
  assert.equal(gross-Math.round(Number(d[key].amount)*unit)+Math.round(Number(o.shippingLines[0].priceSet[key].amount)*unit),total);
 }
 assert.equal(o.shippingLines[0].priceSet.presentmentMoney.amount,'0.40');
});

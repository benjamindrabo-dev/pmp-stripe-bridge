import crypto from 'node:crypto';
import {ensureWebhook,square,ORDER_MUTATION} from '../lib/square-bridge.js';
const hash='4e62e58c00efec13c4b872c462ca03a0abad6f335714fdc4f0f86abe2a9542d9';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST'||crypto.createHash('sha256').update(String(req.headers.authorization||'')).digest('hex')!==hash)return res.status(404).end();
 try{
   await ensureWebhook();
   const {location}=await square('/locations/'+encodeURIComponent(process.env.SQUARE_LOCATION_ID));
   const call=async(query,variables)=>{
    const r=await fetch('https://'+process.env.SHOPIFY_STORE_DOMAIN+'/admin/api/2026-01/graphql.json',{method:'POST',headers:{'X-Shopify-Access-Token':process.env.SHOPIFY_ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query,variables})});return r.json();
   };
   const existing=await call('query {orders(first:1,query:"source_identifier:pmp_square_verify_20260907"){nodes{id name totalPriceSet{shopMoney{amount currencyCode} presentmentMoney{amount currencyCode}}}}}',{});
   if(existing.data?.orders?.nodes?.length)return res.status(200).json({webhook:true,currency:location.currency,testOrder:existing.data.orders.nodes[0]});
   const bag={shopMoney:{amount:'1.00',currencyCode:'CAD'},presentmentMoney:{amount:'0.75',currencyCode:'USD'}};
   const result=await call(ORDER_MUTATION,{order:{currency:'CAD',presentmentCurrency:'USD',test:true,sourceIdentifier:'pmp_square_verify_20260907',tags:['PMP_SQUARE_INTEGRATION_TEST'],note:'Integration test only. No real payment, customer email or inventory movement.',lineItems:[{title:'PMP Square integration verification — TEST ONLY',quantity:1,requiresShipping:false,taxable:false,priceSet:bag}],transactions:[{kind:'SALE',status:'SUCCESS',test:true,gateway:'Square',amountSet:bag}]},options:{sendReceipt:false,sendFulfillmentReceipt:false,inventoryBehaviour:'BYPASS'}});
   return res.status(200).json({webhook:true,currency:location.currency,result});
 }catch(e){return res.status(503).json({error:e.message});}
}

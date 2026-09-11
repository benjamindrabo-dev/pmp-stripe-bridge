// Explicit operator audit: read-only Shopify orders and exact associated Redis carts.
// Never charges, creates/updates orders, sends analytics, changes consent, or logs
// customer information, cart/session identifiers, URLs, tokens or secret values.
import {shopify,get} from '../lib/square-bridge.js';
import {orderAttributionAttributes} from '../api/stripe-webhook.js';

if(process.argv[2]!=='--read-only'||process.env.VERCEL_ENV!=='production'||process.env.VERCEL_GIT_COMMIT_REF!=='main'){
 console.log('GODADDY_ATTRIBUTION_READ_AUDIT skipped');
}else{
 const report={at:new Date().toISOString(),limit:20,ordersRead:0,storedCartsRead:0,missingCarts:0,withOriginalTouches:0,withAcquisitionSignal:0,withoutAcquisitionSignal:0,additionalRecoverableOrderSources:0,moreOrdersExist:false,orderWrites:0,storageWrites:0,financialRequests:0,advertisingRequests:0};
 try{
  const business=String(process.env.GODADDY_BUSINESS_ID||'');
  if(!/^[a-f0-9-]{36}$/i.test(business))throw Error('CONFIGURATION_MISSING');
  const query='query GoDaddyStoredAttributionAudit($q:String!){orders(first:20,sortKey:CREATED_AT,reverse:true,query:$q){nodes{sourceIdentifier customAttributes{key value}} pageInfo{hasNextPage endCursor}}}';
  const data=await shopify(query,{q:"tag:godaddy created_at:>='2026-09-10T16:45:00Z'"});
  if(!Array.isArray(data.orders?.nodes))throw Error('ORDER_READ_FAILED');
  report.moreOrdersExist=data.orders.pageInfo?.hasNextPage===true;
  for(const order of data.orders.nodes){
   const id=order.sourceIdentifier;if(!/^gd_[a-f0-9]{32}$/.test(id||''))continue;
   report.ordersRead++;
   const cart=await get('godaddy:production:'+business+':cart:'+id);
   if(!cart){report.missingCarts++;continue;}
   report.storedCartsRead++;
   const a=cart.attribution||{};
   const hasTouches=Object.entries(a).some(([k,v])=>/^(first_entry|first_touch|last_touch)_/.test(k)&&typeof v==='string'&&v.length>0);
   if(hasTouches)report.withOriginalTouches++;
   const classification=orderAttributionAttributes(a);
   const signal=classification.channel.label!=='Direct / unknown';
   if(signal)report.withAcquisitionSignal++;else report.withoutAcquisitionSignal++;
   const stored=(order.customAttributes||[]).find(x=>x.key==='attribution_channel')?.value;
   if(signal&&(!stored||stored==='Direct / unknown'))report.additionalRecoverableOrderSources++;
  }
  report.result='read-complete';
 }catch{report.result='read-incomplete';}
 console.log('GODADDY_ATTRIBUTION_READ_AUDIT '+JSON.stringify(report));
}

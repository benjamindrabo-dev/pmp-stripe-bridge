import {get,redis,validId,error,BRIDGE_ORIGIN} from './square-bridge.js';
import {metaCheckoutStageIntent,metaTrySend} from '../api/stripe-webhook.js';

export const stageNames={details_started:'CheckoutDetailsStarted',payment_started:'PaymentInfoStarted',payment_info_added:'AddPaymentInfo'};
export async function captureCheckoutStage(id,stage){
 if(!validId(id)||!Object.hasOwn(stageNames,stage))throw error('Invalid checkout stage',400);
 const cart=await get('sess:'+id);
 if(!cart)throw error('Checkout expired',410);
 if(cart.supersededBy||await get('done:'+id))return {ok:true,ignored:true};
 const key='square:progress:'+id+':'+stage;
 const now=Date.now();
 await redis(['SET',key,JSON.stringify({at:now}),'NX','EX','604800']);
 const saved=await get(key);
 if(cart.attribution?.marketing_allowed!==true)return {ok:true,meta:'consent_not_granted'};
 const attrs=cart.attribution||{};
 const entry=await metaCheckoutStageIntent({sessionId:id+':'+stage,email:cart.email,value:cart.subtotal/cart.scale,currency:cart.displayCurrency,cart:{...attrs,external_id:attrs.browser_id||attrs.journey_id,ip:cart.ip,ua:cart.ua,landing_url:BRIDGE_ORIGIN+'/square-checkout.html',items:cart.items.map(it=>({...it,price_cents:it.price_cents/cart.scale*100}))}},stageNames[stage],saved.at);
 if(entry&&entry.status==='pending')await metaTrySend(entry);
 return {ok:true,meta:entry?.status||'not_configured'};
}

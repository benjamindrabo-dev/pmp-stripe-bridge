import {createFromSnapshot} from '../lib/godaddy-cart.js';
import {promotion,loadCart,canPrepare} from '../lib/godaddy-embedded.js';
import {compactCart} from '../public/godaddy-cart-snapshot.js';
import {resolveLocale} from '../public/godaddy-cart-contract.js';
import {deterministicEventId} from '../lib/omnisend.js';

const ORIGINS=['https://www.puremajestypet.com','https://puremajestypet.com','https://checkout.puremajestypet.com','https://pmp-stripe-bridge.vercel.app'];
function rejection(res,status,code,body,error){
 // Codes and structural context only. Never log the cart, customer data, tokens,
 // headers, amounts or URLs. This distinguishes a cart rejection from a dead CTA.
 const country=String(body?.checkout_country||'').toUpperCase();
 const currency=String(body?.pmp_cart?.currency||body?.currency||'').toUpperCase();
 console.warn('GODADDY_CART_REJECT',JSON.stringify({code,status,country:/^[A-Z]{2}$/.test(country)?country:null,currency:/^[A-Z]{3}$/.test(currency)?currency:null,hasSnapshot:!!body?.pmp_cart,lines:Array.isArray(body?.pmp_cart?.items)?body.pmp_cart.items.length:Array.isArray(body?.items)?body.items.length:null}));
 return res.status(status).json({code,...(error?{error}:{})});
}
export function checkoutSnapshot(body){
 if(body.pmp_cart)return compactCart(body.pmp_cart);
 // Old storefront tabs may not yet carry the Ajax snapshot. The server will
 // independently reconstruct this merchandise in Shopify before trusting it.
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>50)throw Object.assign(new Error('INVALID_CART'),{code:'INVALID_CART',status:400});
 const items=body.items.map(i=>{
  if(!Number.isSafeInteger(Number(i.price_cents))||Number(i.price_cents)<0||!Number.isSafeInteger(Number(i.quantity))||Number(i.quantity)<1||Number(i.quantity)>50)throw Object.assign(new Error('INVALID_CART'),{code:'INVALID_CART',status:400});
  const line=Number(i.price_cents)*Number(i.quantity);
  return {variant_id:Number(i.variant_id),quantity:Number(i.quantity),final_line_price:line,original_line_price:line,product_title:String(i.title||''),image:typeof i.image==='string'?i.image:null};
 });
 const total=items.reduce((s,i)=>s+i.final_line_price,0);
 return {currency:String(body.currency||'').toUpperCase(),total_price:total,items_subtotal_price:total,item_count:items.reduce((s,i)=>s+i.quantity,0),items,cart_level_discount_applications:[],token:body.shopify_cart_token||null};
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const origins=[...ORIGINS];if(process.env.VERCEL_ENV==='preview')for(const name of ['VERCEL_URL','VERCEL_BRANCH_URL'])if(process.env[name])origins.push('https://'+process.env[name]);
 const origin=String(req.headers.origin||'');
 if(origin&&!origins.includes(origin))return rejection(res,403,'ORIGIN_NOT_ALLOWED',null,'Checkout origin not allowed');
 if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');
 if(req.method==='OPTIONS')return res.status(204).end();
 if(req.method!=='POST')return res.status(405).end();
 if(!origin||!String(req.headers['content-type']||'').startsWith('application/json')||!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Buffer.byteLength(JSON.stringify(req.body))>64000)return rejection(res,400,'INVALID_REQUEST',req.body);
 if(!canPrepare())return rejection(res,503,'GODADDY_CHECKOUT_DISABLED',req.body,'Secure checkout is not available yet.');
 try{
  const body=req.body,country=String(body.checkout_country||'').toUpperCase();
  const locale=resolveLocale(body.locale);
  let result=await createFromSnapshot({cart:checkoutSnapshot(body),country,locale,storefrontRoot:body.storefront_root,attribution:{...body,shopify_cart_url:body.shopify_cart_url}});
  const meta=String(body.utm_source||'').toLowerCase()==='meta'&&String(body.utm_medium||'').toLowerCase()==='paid_social'&&String(body.utm_campaign||'').toLowerCase()==='liquid_retargeting_product_view';
  const code=String(body.promotion_code||(meta?'WELCOME20':'')).trim().toUpperCase();
  if(code){
   const q=await promotion(result.sessionId,{code,email:body.email});
   const cart=await loadCart(q.sessionId);const url=new URL(result.checkoutUrl);url.searchParams.set('session_id',q.sessionId);
   result={...result,sessionId:q.sessionId,checkoutUrl:url.href,amountTotal:q.total,analytics:{beginCheckout:{eventId:deterministicEventId('begin checkout',q.sessionId),currency:cart.displayCurrency,value:cart.subtotal/100,items:cart.items.map(i=>({item_id:String(i.variant_id),item_name:i.title,quantity:i.quantity,price:i.price_cents/100}))}}};
  }
  if(!body.pmp_cart){
   // Older loaded helpers validate BOTH this original origin and path. Keep
   // them unchanged; the gd_-specific rewrite still serves GoDaddy securely.
   const original=new URL(result.checkoutUrl);
   const compatible=new URL('/square-checkout.html','https://pmp-stripe-bridge.vercel.app');
   compatible.search=original.search;result={...result,checkoutUrl:compatible.href};
  }
  // "square" is the original storefront redirect discriminator, not the
  // processor. paymentProvider unambiguously identifies the actual processor.
  return res.status(200).json({...result,provider:'square',paymentProvider:'godaddy'});
 }catch(e){const code=/^[A-Z_]+$/.test(e.code||'')?e.code:'CHECKOUT_UNAVAILABLE';return rejection(res,e.status||503,code,req.body,'Please refresh your cart and try again. No payment has been submitted.');}
}

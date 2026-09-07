import crypto from 'node:crypto';
import countries from './square-countries.js';
import {get,set,redis,release,error,validId,shopify,createSquareQuote,moneyScale} from './square-bridge.js';

const QUERY = "query SquareVariants($ids:[ID!]!,$country:CountryCode!){nodes(ids:$ids){... on ProductVariant{id title inventoryQuantity inventoryPolicy contextualPricing(context:{country:$country}){price{amount currencyCode}} product{id title status featuredImage{url}}}}}";
export async function variants(ids,country){
 const data=await shopify(QUERY,{ids:[...new Set(ids.map(id=>'gid://shopify/ProductVariant/'+Number(id)))],country});
 return (data.nodes||[]).filter(Boolean);
}
const vid=n=>Number(n.id.split('/').pop());
export async function suggestions(cart){
 const requested=(cart.suggestions||[]).filter(s=>/^\d+$/.test(String(s.variant_id))).slice(0,6);
 if(!requested.length)return [];
 const nodes=await variants(requested.map(s=>s.variant_id),cart.country);
 const inCart=new Set(cart.items.map(i=>String(i.variant_id)));
 return nodes.filter(n=>n.product.status==='ACTIVE'&&!inCart.has(String(vid(n)))&&(n.inventoryPolicy==='CONTINUE'||n.inventoryQuantity>0)&&n.contextualPricing?.price?.currencyCode===cart.displayCurrency).slice(0,2).map(n=>({variantId:vid(n),title:requested.find(s=>Number(s.variant_id)===vid(n))?.title||n.product.title,image:n.product.featuredImage?.url||null,price:n.contextualPricing.price.amount}));
}

// An edit and a payment share one lease; a superseded quote can never be charged.
export async function reviseCart(id,body){
 if(!validId(id))throw error('Invalid checkout',400);
 const key='square:pay-lock:'+id,token=crypto.randomUUID();
 if(await redis(['SET',key,token,'NX','EX','90'])!=='OK')throw error('Checkout is updating. Please wait.',409);
 try{
  const cart=await get('sess:'+id);if(!cart)throw error('Checkout expired',410);
  if(cart.supersededBy)return {checkoutUrl:'https://pmp-stripe-bridge.vercel.app/square-checkout.html?session_id='+cart.supersededBy};
  const attempt=await get('square:attempt:'+id);if((attempt&&!attempt.failed)||await get('done:'+id))throw error('Payment is already being confirmed.',409);
  let country=cart.country,displayCurrency=cart.displayCurrency,scale=cart.scale;
  let items=cart.items.map(it=>({...it,price_cents:it.original_price_cents}));
  let catalogPrices=cart.catalogPrices;
  if(body.country&&body.country!==country){
   if(!countries.some(c=>c.code===body.country))throw error('Delivery country unavailable',400);
   const oldNodes=catalogPrices?[]:await variants(items.map(it=>it.variant_id),country);
   const oldPrices=catalogPrices||Object.fromEntries(oldNodes.map(n=>[n.id,Number(n.contextualPricing.price.amount)]));
   const nodes=await variants(items.map(it=>it.variant_id),body.country);
   if(nodes.length!==new Set(items.map(i=>i.variant_id)).size)throw error('Product unavailable in this country',400);
   displayCurrency=nodes[0]?.contextualPricing?.price?.currencyCode;
   if(!displayCurrency||nodes.some(n=>n.contextualPricing?.price?.currencyCode!==displayCurrency))throw error('Market pricing unavailable');
   scale=moneyScale(displayCurrency);const digits=new Intl.NumberFormat('en',{style:'currency',currency:displayCurrency}).resolvedOptions().maximumFractionDigits;const quantum=scale/10**digits;
   catalogPrices=Object.fromEntries(nodes.map(n=>[n.id,Number(n.contextualPricing.price.amount)]));
   items=items.map(it=>{const gid='gid://shopify/ProductVariant/'+it.variant_id;const previous=oldPrices[gid];if(!(previous>0))throw error('Market pricing unavailable');return {...it,price_cents:it.price_cents===0?0:Math.round((it.price_cents/cart.scale/previous)*catalogPrices[gid]*scale/quantum)*quantum};});
   country=body.country;
  }
  if(body.addVariant){
   const choice=(await suggestions({...cart,country,displayCurrency})).find(s=>s.variantId===Number(body.addVariant));
   if(!choice)throw error('This add-on is unavailable.',400);
   items.push({variant_id:choice.variantId,title:choice.title,quantity:1,price_cents:Math.round(Number(choice.price)*scale),image:choice.image,addon:true});
   catalogPrices={...catalogPrices,['gid://shopify/ProductVariant/'+choice.variantId]:Number(choice.price)};
  }
  if(body.removeAddon)items=items.filter(it=>!(it.addon&&Number(it.variant_id)===Number(body.removeAddon)));
  if(!items.length)throw error('Empty cart',400);
  const next=await createSquareQuote({...cart,items,country,displayCurrency,scale,catalogPrices,email:body.email||cart.email,promotionCode:body.promotionCode??cart.promotionCode});
  await set('sess:'+id,{...cart,supersededBy:next.sessionId});
  return next;
 }finally{await release(key,token);}
}

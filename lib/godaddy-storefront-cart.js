// Recalculate merchandise in Shopify itself; no customer or payment writes.
import {compactCart,appliedDiscountCodes} from '../public/godaddy-cart-snapshot.js';
import {cartError} from '../public/godaddy-cart-contract.js';
import {checkoutCountry} from '../public/godaddy-country-contract.js';
export function storefrontRoot(country,locale='en'){return ({US:'',CA:'/en-ca',GB:'/en-gb',AU:'/en-au',FR:'/fr-fr',DE:'/de-de',ES:'/es-es',IT:'/it-it',PT:'/pt-pt',NZ:'/en-nz'})[country]??('/'+locale.toLowerCase().split('-')[0]+'-'+country.toLowerCase());}
// The public entrypoint always requires exact equality with the source cart.
export async function recalculateShopifyCart(snapshot,context={}){return rebuild(snapshot,context,true);}
// Called only for a country edit of an already stored, validated checkout.
// Destination prices come from Shopify, not the browser or an old FX total.
export async function repriceShopifyCart(snapshot,context={}){
 checkoutCountry(context.country);
 return rebuild(snapshot,{...context,root:'/'},false);
}
async function rebuild(snapshot,{country,locale='en',root}={},compareOriginal){
 if(!/^[A-Z]{2}$/.test(country||''))throw cartError('COUNTRY_REQUIRED');
 const path=root??storefrontRoot(country,locale);if(!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/.test(path||'/'))throw cartError('INVALID_STOREFRONT_ROOT');
 let base=path.replace(/\/$/,'');const jar=new Map(),site='https://www.puremajestypet.com';
 const clean=compactCart(snapshot),codes=appliedDiscountCodes(clean);
 if(!Array.isArray(clean.items)||!clean.items.length||clean.items.length>50)throw cartError('EMPTY_OR_OVERSIZED_CART');
 async function request(route,init={}){
  const response=await fetch(site+route,{...init,redirect:'manual',headers:{'User-Agent':'PMP-cart-verification/1.0',...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...init.headers},signal:AbortSignal.timeout(12000)});
  for(const value of response.headers.getSetCookie?.()||[]){const pair=value.split(';')[0],eq=pair.indexOf('=');if(eq>0)jar.set(pair.slice(0,eq),pair.slice(eq+1));}return response;
 }
 await request(base+'/');
 const localized=await request('/localization',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({form_type:'localization',_method:'put',country_code:country,return_to:base+'/cart'}).toString()});
 if(localized.status>=400)throw cartError('COUNTRY_NOT_AVAILABLE');
 if(!compareOriginal&&localized.headers.get('location')){
  const destination=new URL(localized.headers.get('location'),site);
  if(destination.protocol!=='https:'||!['www.puremajestypet.com','puremajestypet.com'].includes(destination.hostname)||destination.username||destination.password)throw cartError('INVALID_LOCALIZATION_REDIRECT');
  if(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\/?$/.test(destination.pathname))base=destination.pathname.replace(/\/cart\/?$/,'');
 }
 await request(base+'/cart');
 const quantities=new Map();
 for(const i of clean.items){
  const id=Number(i.variant_id),quantity=Number(i.quantity),properties=i.properties||{};
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(quantity)||quantity<1||quantity>50)throw cartError('INVALID_CART_LINE');
  const key=JSON.stringify([id,properties]),existing=quantities.get(key)||{id,quantity:0,properties};existing.quantity+=quantity;
  if(existing.quantity>50)throw cartError('INVALID_CART_LINE');quantities.set(key,existing);
 }
 try{
  const added=await request(base+'/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[...quantities.values()]})});
  if(!added.ok)throw cartError('SHOPIFY_CART_RECALCULATION_REJECTED');
  if(codes.length){
   const discounted=await request(base+'/cart/update.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discount:codes.join(',')})});
   if(!discounted.ok)throw cartError('SHOPIFY_CART_DISCOUNT_REJECTED');
  }
  const read=await request(base+'/cart.js');if(!read.ok)throw cartError('SHOPIFY_CART_RECALCULATION_FAILED');
  let raw;try{raw=await read.json();}catch{throw cartError('SHOPIFY_CART_INVALID_JSON');}
  if(!Array.isArray(raw?.items)||!Number.isSafeInteger(raw.total_price)||typeof raw.currency!=='string')throw cartError('SHOPIFY_CART_INVALID_SCHEMA');
  const actual=compactCart(raw);
  const groups=(items,withPrices)=>{
   const values=new Map();for(const i of items){const id=Number(i.variant_id||i.id),g=values.get(id)||{quantity:0,total:0};g.quantity+=Number(i.quantity);if(withPrices)g.total+=i.final_line_price??i.line_price;values.set(id,g);}return [...values].sort((a,b)=>a[0]-b[0]);
  };
  if(compareOriginal&&(actual.currency!==snapshot.currency||actual.total_price!==snapshot.total_price))throw cartError('SHOPIFY_CART_TOTAL_CHANGED');
  if(JSON.stringify(groups(actual.items,compareOriginal))!==JSON.stringify(groups(snapshot.items,compareOriginal)))throw cartError('SHOPIFY_CART_LINES_CHANGED');
  return actual;
 }finally{try{await request(base+'/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}}
}

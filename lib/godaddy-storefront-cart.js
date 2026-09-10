// Recalculate merchandise in Shopify itself; no customer data, payment or order creation.
import {compactCart} from '../public/godaddy-cart-snapshot.js';
import {cartError} from '../public/godaddy-cart-contract.js';
export function storefrontRoot(country,locale='en'){return ({US:'',CA:'/en-ca',GB:'/en-gb',AU:'/en-au',FR:'/fr-fr',DE:'/de-de',ES:'/es-es',IT:'/it-it',PT:'/pt-pt',NZ:'/en-nz'})[country]??('/'+locale.toLowerCase().split('-')[0]+'-'+country.toLowerCase());}
export async function recalculateShopifyCart(snapshot,{country,locale='en',root}={}){
 const path=root??storefrontRoot(country,locale);if(!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/.test(path||'/'))throw cartError('INVALID_STOREFRONT_ROOT');
 const base=path.replace(/\/$/,''),jar=new Map(),site='https://www.puremajestypet.com';
 async function request(route,init={}){
  const response=await fetch(site+route,{...init,redirect:'manual',headers:{'User-Agent':'PMP-cart-verification/1.0',...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...init.headers},signal:AbortSignal.timeout(12000)});
  for(const value of response.headers.getSetCookie?.()||[]){const pair=value.split(';')[0],eq=pair.indexOf('=');if(eq>0)jar.set(pair.slice(0,eq),pair.slice(eq+1));}return response;
 }
 await request(base+'/');
 await request('/localization',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({form_type:'localization',_method:'put',country_code:country,return_to:base+'/cart'}).toString()});
 await request(base+'/cart');
 const quantities=new Map();for(const i of snapshot.items){const id=Number(i.variant_id||i.id);quantities.set(id,(quantities.get(id)||0)+Number(i.quantity));}
 try{
  const added=await request(base+'/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[...quantities].map(([id,quantity])=>({id,quantity}))})});
  if(!added.ok)throw cartError('SHOPIFY_CART_RECALCULATION_REJECTED');
  const read=await request(base+'/cart.js');if(!read.ok)throw cartError('SHOPIFY_CART_RECALCULATION_FAILED');
  // Shopify's .js endpoints may label JSON as JavaScript. JSON parsing and schema validation remain mandatory.
  let raw;try{raw=await read.json();}catch{throw cartError('SHOPIFY_CART_INVALID_JSON');}
  if(!Array.isArray(raw?.items)||!Number.isSafeInteger(raw.total_price)||typeof raw.currency!=='string')throw cartError('SHOPIFY_CART_INVALID_SCHEMA');
  const actual=compactCart(raw);if(actual.currency!==snapshot.currency||actual.total_price!==snapshot.total_price)throw cartError('SHOPIFY_CART_TOTAL_CHANGED');
  const groups=items=>{const values=new Map();for(const i of items){const id=Number(i.variant_id||i.id),g=values.get(id)||{quantity:0,total:0};g.quantity+=i.quantity;g.total+=i.final_line_price??i.line_price;values.set(id,g);}return [...values].sort((a,b)=>a[0]-b[0]);};
  if(JSON.stringify(groups(actual.items))!==JSON.stringify(groups(snapshot.items)))throw cartError('SHOPIFY_CART_LINES_CHANGED');return actual;
 }finally{try{await request(base+'/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}}
}

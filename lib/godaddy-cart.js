// Cart/read-only quote integration. This module never submits a payment.
import {randomUUID} from 'node:crypto';
import {snapshotToInput,resolveLocale,cartError} from '../public/godaddy-cart-contract.js';
import {shopify,redis,release} from './square-bridge.js';
import {createGoDaddyQuote,loadCart,publicQuote,storage,canPrepare,prefix} from './godaddy-embedded.js';
export const DENTAL_VARIANT=43668777631818;
const QUERY=`query GoDaddyCartProducts($ids:[ID!]!,$country:CountryCode!){nodes(ids:$ids){... on ProductVariant{id title inventoryQuantity inventoryPolicy contextualPricing(context:{country:$country}){price{amount currencyCode}} product{id title status featuredImage{url}}}}}`;
export async function catalog(ids,country){
 const result=await shopify(QUERY,{ids:[...new Set(ids)].map(id=>'gid://shopify/ProductVariant/'+id),country});
 if(!Array.isArray(result.nodes))throw cartError('CATALOG_UNAVAILABLE');
 return new Map(result.nodes.filter(Boolean).map(n=>[Number(n.id.split('/').pop()),n]));
}
export function validateCatalog(input,nodes){
 const paidUnits=input.items.reduce((n,i)=>n+(i.price_cents>0?i.quantity:0),0);
 const ratio=paidUnits>=2?.75:.90; // Same paid-unit floor as the existing bridge; gifts checked separately.
 const groups=new Map();
 for(const i of input.items){
  const n=nodes.get(i.variant_id);if(!n||n.product?.status!=='ACTIVE')throw cartError('PRODUCT_UNAVAILABLE');
  const p=n.contextualPricing?.price;
  if(p?.currencyCode!==input.displayCurrency)throw cartError('MARKET_CURRENCY_MISMATCH');
  const price=Math.round(Number(p.amount)*100);if(!Number.isSafeInteger(price)||price<1)throw cartError('INVALID_CATALOG_PRICE');
  const g=groups.get(i.variant_id)||{paid:0,free:0,total:0,units:0,catalog:price,node:n};
  g.units+=i.quantity;g.total+=i.price_cents*i.quantity;i.price_cents===0?g.free+=i.quantity:g.paid+=i.quantity;groups.set(i.variant_id,g);
 }
 for(const g of groups.values()){
  if(g.free>g.paid)throw cartError('INVALID_GIFT_QUANTITY');
  if(g.node.inventoryPolicy!=='CONTINUE'&&g.node.inventoryQuantity<g.units)throw cartError('INSUFFICIENT_INVENTORY');
  if(g.total<Math.floor(g.catalog*g.paid*ratio)-1||g.total>Math.ceil(g.catalog*g.paid*1.02)+1)throw cartError('PRICE_VALIDATION_FAILED');
 }
 return input.items.map(i=>{const n=nodes.get(i.variant_id);return {...i,title:String(i.title||n.product.title).replace(/[\x00-\x1f\x7f]/g,'').slice(0,250),image:n.product.featuredImage?.url||null};});
}
function attribution(input){
 const out={marketing_allowed:input?.marketing_allowed===true};
 for(const key of ['journey_id','gclid','gbraid','wbraid','fbclid','ttclid','msclkid','sccid','ga_client_id','ga_session_id','ga_session_number','fbp','fbc']){
  const value=input?.[key];if(typeof value==='string'&&/^[A-Za-z0-9._~-]{1,255}$/.test(value))out[key]=value;
 }
 return out;
}
export async function createFromSnapshot(body){
 if(!canPrepare())throw cartError('CHECKOUT_DISABLED');
 const input=snapshotToInput(body.cart,{country:body.country,locale:body.locale,browserLanguages:body.browserLanguages});
 const nodes=await catalog(input.items.map(i=>i.variant_id),input.country);
 input.items=validateCatalog(input,nodes);
 input.catalogPrices=Object.fromEntries([...nodes].map(([id,n])=>['gid://shopify/ProductVariant/'+id,Number(n.contextualPricing.price.amount)]));
 input.attribution={...attribution(body.attribution),shopify_cart_token:input.shopifyCartToken};
 // Do not apply an extra marketing offer to a cart that already carries its final discounts.
 input.promotionCode=null;
 const result=await createGoDaddyQuote(input);const cart=await loadCart(result.sessionId);
 if(cart.subtotal!==input.cartSubtotalMinor)throw cartError('PERSISTED_CART_TOTAL_MISMATCH');
 cart.sourceCartSubtotal=input.cartSubtotalMinor;cart.sourceItemCount=input.sourceItemCount;cart.source='shopify_ajax_cart';
 await storage.set('cart:'+cart.id,cart);
 return {...result,cartVerified:true,cartSubtotalMinor:cart.subtotal,preview:process.env.VERCEL_ENV==='preview'};
}
export async function dentalSuggestion(cart){
 if(cart.items.some(i=>i.variant_id===DENTAL_VARIANT))return [];
 const n=(await catalog([DENTAL_VARIANT],cart.country)).get(DENTAL_VARIANT);
 if(!n||n.product.status!=='ACTIVE'||(n.inventoryPolicy!=='CONTINUE'&&n.inventoryQuantity<1)||n.contextualPricing?.price?.currencyCode!==cart.displayCurrency)return [];
 const base=Math.round(Number(n.contextualPricing.price.amount)*100);
 const factor=cart.promotionCode==='WELCOME20'?.8:cart.promotionCode==='THANK10'?.9:1;
 return [{variantId:DENTAL_VARIANT,title:n.product.title,image:n.product.featuredImage?.url||null,unitMinor:Math.round(base*factor),originalUnitMinor:base,currency:cart.displayCurrency}];
}
export function expandedQuote(cart){
 const q=publicQuote(cart);
 return {...q,locale:resolveLocale(cart.locale),source:cart.source||null,sourceCartSubtotal:cart.sourceCartSubtotal??null,items:cart.items.map((i,index)=>({variantId:i.variant_id,lineKey:String(i.sourceLine??index)+':'+i.price_cents,title:i.title,quantity:i.quantity,unitMinor:i.original_price_cents,lineTotalMinor:i.price_cents*i.quantity,originalLineTotalMinor:i.original_price_cents*i.quantity,gift:i.price_cents===0,addon:i.addon===true,image:i.image||null})),supersededBy:cart.supersededBy||null,wallets:{applePay:false,googlePay:false,reason:'merchant-domain-and-payment-flow-not-verified'}};
}
export async function revise(id,body){
 if(!canPrepare())throw cartError('CHECKOUT_DISABLED');
 const lock=prefix()+'cart-edit:'+id,token=randomUUID();
 if(await redis(['SET',lock,token,'NX','EX','60'])!=='OK')throw cartError('CART_BUSY');
 try{
  const cart=await loadCart(id);
  if(cart.supersededBy||await storage.get('prepared:'+id)||await storage.get('attempt:'+id)||await storage.get('done:'+id))throw cartError('CART_NOT_EDITABLE');
  let items=cart.items.map(i=>({...i,price_cents:i.original_price_cents}));
  if(body.action==='add-dental'){
   const choice=(await dentalSuggestion(cart))[0];if(!choice)throw cartError('ADDON_UNAVAILABLE');
   items.push({variant_id:DENTAL_VARIANT,title:choice.title,image:choice.image,quantity:1,price_cents:choice.originalUnitMinor,addon:true});
  }else if(body.action==='remove-dental'){
   if(!items.some(i=>i.addon&&i.variant_id===DENTAL_VARIANT))throw cartError('ADDON_UNAVAILABLE');
   items=items.filter(i=>!(i.addon&&i.variant_id===DENTAL_VARIANT));
  }else throw cartError('INVALID_ACTION');
  const result=await createGoDaddyQuote({...cart,items});const next=await loadCart(result.sessionId);
  cart.supersededBy=result.sessionId;await storage.set('cart:'+id,cart);
  return expandedQuote(next);
 }finally{await release(lock,token);}
}

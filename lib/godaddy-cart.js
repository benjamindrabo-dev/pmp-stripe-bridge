// Cart/read-only quote integration. This module never submits a payment.
import {randomUUID} from 'node:crypto';
import {snapshotToInput,resolveLocale,cartError} from '../public/godaddy-cart-contract.js';
import {shopify,redis,release} from './square-bridge.js';
import {createGoDaddyQuote,loadCart,publicQuote,storage,canPrepare,prefix} from './godaddy-embedded.js';
import {recalculateShopifyCart} from './godaddy-storefront-cart.js';
export const DENTAL_VARIANT=43668777631818;
const QUERY=`query GoDaddyCartProducts($ids:[ID!]!,$country:CountryCode!){nodes(ids:$ids){... on ProductVariant{id title inventoryQuantity inventoryPolicy inventoryItem{tracked} contextualPricing(context:{country:$country}){price{amount currencyCode}} product{id title status featuredImage{url}}}}}`;
export async function catalog(ids,country){const result=await shopify(QUERY,{ids:[...new Set(ids)].map(id=>'gid://shopify/ProductVariant/'+id),country});if(!Array.isArray(result.nodes))throw cartError('CATALOG_UNAVAILABLE');return new Map(result.nodes.filter(Boolean).map(n=>[Number(n.id.split('/').pop()),n]));}
function attribution(input){const out={marketing_allowed:input?.marketing_allowed===true};for(const key of ['journey_id','gclid','gbraid','wbraid','fbclid','ttclid','msclkid','sccid','ga_client_id','ga_session_id','ga_session_number','fbp','fbc']){const value=input?.[key];if(typeof value==='string'&&/^[A-Za-z0-9._~-]{1,255}$/.test(value))out[key]=value;}return out;}
export async function createFromSnapshot(body){
 if(!canPrepare())throw cartError('CHECKOUT_DISABLED');
 const context={country:body.country,locale:body.locale,browserLanguages:body.browserLanguages};
 const supplied=snapshotToInput(body.cart,context);
 // Shopify, not a caller-supplied gift flag, authorizes automatic/mixed-product gifts.
 const actual=await recalculateShopifyCart(body.cart,{country:supplied.country,locale:supplied.locale,root:body.storefrontRoot});
 const input=snapshotToInput(actual,context);const nodes=await catalog(input.items.map(i=>i.variant_id),input.country);
 input.items=input.items.map(i=>{const n=nodes.get(i.variant_id);if(!n||n.product?.status!=='ACTIVE')throw cartError('PRODUCT_UNAVAILABLE');if(n.contextualPricing?.price?.currencyCode!==input.displayCurrency)throw cartError('MARKET_CURRENCY_MISMATCH');return {...i,title:String(i.title||n.product.title).replace(/[\x00-\x1f\x7f]/g,'').slice(0,250),image:n.product.featuredImage?.url||i.image||null};});
 input.catalogPrices=Object.fromEntries([...nodes].map(([id,n])=>['gid://shopify/ProductVariant/'+id,Number(n.contextualPricing.price.amount)]));
 input.attribution={...attribution(body.attribution),shopify_cart_token:supplied.shopifyCartToken};input.promotionCode=null;
 const result=await createGoDaddyQuote(input);const cart=await loadCart(result.sessionId);
 if(cart.subtotal!==supplied.cartSubtotalMinor)throw cartError('PERSISTED_CART_TOTAL_MISMATCH');
 cart.sourceCartSubtotal=supplied.cartSubtotalMinor;cart.sourceItemCount=supplied.sourceItemCount;cart.source='shopify_ajax_cart';cart.shopifyRecalculated=true;
 await storage.set('cart:'+cart.id,cart);return {...result,cartVerified:true,shopifyRecalculated:true,cartSubtotalMinor:cart.subtotal,preview:process.env.VERCEL_ENV==='preview'};
}
export async function dentalSuggestion(cart){
 if(cart.items.some(i=>i.variant_id===DENTAL_VARIANT))return [];
 const n=(await catalog([DENTAL_VARIANT],cart.country)).get(DENTAL_VARIANT);
 if(!n||n.product.status!=='ACTIVE'||(n.inventoryItem?.tracked===true&&n.inventoryPolicy!=='CONTINUE'&&n.inventoryQuantity<1)||n.contextualPricing?.price?.currencyCode!==cart.displayCurrency)return [];
 const base=Math.round(Number(n.contextualPricing.price.amount)*100),factor=cart.promotionCode==='WELCOME20'?.8:cart.promotionCode==='THANK10'?.9:1;
 return [{variantId:DENTAL_VARIANT,title:n.product.title,image:n.product.featuredImage?.url||null,unitMinor:Math.round(base*factor),originalUnitMinor:base,currency:cart.displayCurrency}];
}
export function expandedQuote(cart){
 const q=publicQuote(cart);
 return {...q,locale:resolveLocale(cart.locale),source:cart.source||null,shopifyRecalculated:cart.shopifyRecalculated===true,sourceCartSubtotal:cart.sourceCartSubtotal??null,items:cart.items.map((i,index)=>({variantId:i.variant_id,lineKey:String(i.sourceLine??index)+':'+i.price_cents,title:i.title,quantity:i.quantity,unitMinor:i.original_price_cents,lineTotalMinor:i.price_cents*i.quantity,originalLineTotalMinor:i.original_price_cents*i.quantity,gift:i.price_cents===0,addon:i.addon===true,image:i.image||null})),supersededBy:cart.supersededBy||null,wallets:{applePay:false,googlePay:false,reason:'merchant-domain-and-payment-flow-not-verified'}};
}
export async function revise(id,body){
 if(!canPrepare())throw cartError('CHECKOUT_DISABLED');const lock=prefix()+'cart-edit:'+id,token=randomUUID();if(await redis(['SET',lock,token,'NX','EX','60'])!=='OK')throw cartError('CART_BUSY');
 try{const cart=await loadCart(id);if(cart.supersededBy||await storage.get('prepared:'+id)||await storage.get('attempt:'+id)||await storage.get('done:'+id))throw cartError('CART_NOT_EDITABLE');
 let items=cart.items.map(i=>({...i,price_cents:i.original_price_cents}));
 if(body.action==='add-dental'){const choice=(await dentalSuggestion(cart))[0];if(!choice)throw cartError('ADDON_UNAVAILABLE');items.push({variant_id:DENTAL_VARIANT,title:choice.title,image:choice.image,quantity:1,price_cents:choice.originalUnitMinor,addon:true});}
 else if(body.action==='remove-dental'){if(!items.some(i=>i.addon&&i.variant_id===DENTAL_VARIANT))throw cartError('ADDON_UNAVAILABLE');items=items.filter(i=>!(i.addon&&i.variant_id===DENTAL_VARIANT));}else throw cartError('INVALID_ACTION');
 const result=await createGoDaddyQuote({...cart,items}),next=await loadCart(result.sessionId);cart.supersededBy=result.sessionId;await storage.set('cart:'+id,cart);return expandedQuote(next);
 }finally{await release(lock,token);}
}

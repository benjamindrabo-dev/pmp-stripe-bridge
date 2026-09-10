// Shared by the browser handoff and server validation. No payment operations.
export const SUPPORTED_LOCALES = ['en','fr','de','es','it','pt'];
export function resolveLocale(...candidates) {
  for (const candidate of candidates.flat()) {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate === 'auto') continue;
    const lang = candidate.toLowerCase().replaceAll('_','-').split('-')[0];
    // An explicitly selected but unsupported language falls back to English.
    return SUPPORTED_LOCALES.includes(lang) ? lang : 'en';
  }
  return 'en';
}
export function cartError(code) { return Object.assign(new Error(code), {code,status:400}); }
function integer(value, code='INVALID_AMOUNT') { if (!Number.isSafeInteger(value) || value < 0) throw cartError(code); return value; }
export function allocateMinor(total, weights) {
  integer(total); weights.forEach(v=>integer(v));
  const sum=weights.reduce((a,b)=>a+b,0); integer(sum);
  if (!sum) { if(total)throw cartError('INVALID_ALLOCATION');return weights.map(()=>0); }
  const rows=weights.map((w,i)=>({i,n:Number(BigInt(total)*BigInt(w)/BigInt(sum)),r:BigInt(total)*BigInt(w)%BigInt(sum)}));
  let remainder=total-rows.reduce((n,r)=>n+r.n,0);
  for(const row of [...rows].sort((a,b)=>a.r===b.r?a.i-b.i:a.r>b.r?-1:1)){if(!remainder)break;row.n++;remainder--;}
  return rows.map(r=>r.n);
}
export function snapshotToInput(cart, context={}) {
  if (!cart || !Array.isArray(cart.items) || !cart.items.length || cart.items.length>50) throw cartError('EMPTY_OR_OVERSIZED_CART');
  const currency=String(cart.currency||'').toUpperCase();
  if(!['CAD','USD','GBP','EUR','AUD','NZD'].includes(currency))throw cartError('UNSUPPORTED_CURRENCY');
  const country=String(context.country||'').toUpperCase();if(!/^[A-Z]{2}$/.test(country))throw cartError('COUNTRY_REQUIRED');
  const total=integer(cart.total_price);if(!total)throw cartError('EMPTY_OR_OVERSIZED_CART');
  const lines=cart.items.map((i,index)=>{
    if(i.selling_plan_allocation)throw cartError('SELLING_PLAN_NOT_SUPPORTED');
    const variantId=Number(i.variant_id||i.id),quantity=Number(i.quantity);
    if(!Number.isSafeInteger(variantId)||variantId<=0||!Number.isSafeInteger(quantity)||quantity<1||quantity>50)throw cartError('INVALID_CART_LINE');
    const final=integer(i.final_line_price ?? i.line_price);
    const original=integer(i.original_line_price ?? final);
    if(final>original)throw cartError('INVALID_LINE_DISCOUNT');
    return {index,variantId,quantity,final,original,title:typeof i.product_title==='string'?i.product_title:typeof i.title==='string'?i.title:'',image:typeof i.image==='string'?i.image:null};
  });
  const lineTotal=lines.reduce((s,l)=>s+l.final,0);integer(lineTotal);
  if(cart.items_subtotal_price!=null && integer(cart.items_subtotal_price)!==lineTotal)throw cartError('LINE_SUBTOTAL_MISMATCH');
  const cartDiscount=lineTotal-total;
  if(cartDiscount<0)throw cartError('CART_TOTAL_MISMATCH');
  const declared=(cart.cart_level_discount_applications||[]).reduce((n,d)=>n+integer(d.total_allocated_amount),0);
  if(cartDiscount!==declared)throw cartError('CART_DISCOUNT_MISMATCH');
  const allocated=allocateMinor(cartDiscount,lines.map(l=>l.final));
  const items=[];
  for(const line of lines){
    const value=line.final-allocated[line.index],unit=Math.floor(value/line.quantity),extra=value%line.quantity;
    // A 10.00 line split across three units remains exactly 10.00, not 9.99.
    for(const [quantity,price]of [[line.quantity-extra,unit],[extra,unit+1]])if(quantity)items.push({variant_id:line.variantId,quantity,price_cents:price,title:line.title,image:line.image,sourceLine:line.index});
  }
  if(items.reduce((n,i)=>n+i.quantity*i.price_cents,0)!==total)throw cartError('CART_TOTAL_MISMATCH');
  return {items,displayCurrency:currency,scale:100,country,locale:resolveLocale(context.locale,context.browserLanguages),cartSubtotalMinor:total,sourceItemCount:lines.reduce((n,l)=>n+l.quantity,0),shopifyCartToken:typeof cart.token==='string'?cart.token.split('?')[0].slice(0,200):null};
}

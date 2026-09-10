// Merchandise reconciliation only. No customer/address/cookie/HTML data.
// Discount codes are sent back to Shopify for validation, never used as prices.
function discountCode(value){
 if(typeof value!=='string')return null;
 const code=value.trim();
 return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/.test(code)?code:null;
}
export function appliedDiscountCodes(cart){
 const codes=[];
 const add=value=>{const code=discountCode(value);if(code&&!codes.some(c=>c.toUpperCase()===code.toUpperCase()))codes.push(code);};
 for(const d of cart?.discount_codes||[])if(d?.applicable!==false)add(d?.code);
 for(const d of cart?.cart_level_discount_applications||[])if(d?.type==='discount_code')add(d.title);
 for(const item of cart?.items||[])for(const allocation of item.line_level_discount_allocations||[]){const d=allocation?.discount_application;if(d?.type==='discount_code')add(d.title);}
 return codes.slice(0,5);
}
function bundleProperties(value){
 const out={};
 for(const key of ['Bundle offer','_pmp_bundle','_pmp_offer_total_cents']){
  const text=value?.[key];if(typeof text==='string'&&text.length<=250&&!/[\u0000-\u001f\u007f]/.test(text))out[key]=text;
 }
 return out;
}
export function compactCart(cart){
 return {token:typeof cart?.token==='string'?cart.token.split('?')[0]:null,currency:cart?.currency,total_price:cart?.total_price,items_subtotal_price:cart?.items_subtotal_price,item_count:cart?.item_count,
  discount_codes:appliedDiscountCodes(cart).map(code=>({code,applicable:true})),
  cart_level_discount_applications:(cart?.cart_level_discount_applications||[]).map(d=>({total_allocated_amount:d.total_allocated_amount,...(d.type==='discount_code'&&discountCode(d.title)?{type:'discount_code',title:discountCode(d.title)}:{})})),
  items:(cart?.items||[]).map(i=>({variant_id:i.variant_id||i.id,quantity:i.quantity,final_line_price:i.final_line_price??i.line_price,original_line_price:i.original_line_price??i.final_line_price??i.line_price,product_title:i.product_title||i.title,image:typeof i.image==='string'?i.image:null,properties:bundleProperties(i.properties),...(i.selling_plan_allocation?{selling_plan_allocation:true}:{})}))};
}

// Only cart reconciliation fields cross to the checkout; no customer/address/cookies/HTML.
export function compactCart(cart){
 return {token:typeof cart?.token==='string'?cart.token.split('?')[0]:null,currency:cart?.currency,total_price:cart?.total_price,items_subtotal_price:cart?.items_subtotal_price,item_count:cart?.item_count,
  cart_level_discount_applications:(cart?.cart_level_discount_applications||[]).map(d=>({total_allocated_amount:d.total_allocated_amount})),
  items:(cart?.items||[]).map(i=>({variant_id:i.variant_id||i.id,quantity:i.quantity,final_line_price:i.final_line_price??i.line_price,original_line_price:i.original_line_price??i.final_line_price??i.line_price,product_title:i.product_title||i.title,image:typeof i.image==='string'?i.image:null,...(i.selling_plan_allocation?{selling_plan_allocation:true}:{})}))};
}

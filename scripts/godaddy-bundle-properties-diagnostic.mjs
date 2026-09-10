// Anonymous merchandise quotes only. No cards, charges, customer data or orders.
const SITE='https://www.puremajestypet.com';
const ENDPOINT='https://pmp-stripe-bridge.vercel.app/api/create-checkout';
const report={at:new Date().toISOString(),payments:0,cases:[]};
for(const spec of [{country:'US',root:'',qty:5},{country:'CA',root:'/en-ca',qty:5},{country:'US',root:'',qty:1,discount:'WELCOME20'}]){
 const out={country:spec.country,quantity:spec.qty,discount:spec.discount||null};report.cases.push(out);const jar=new Map();
 async function get(path,init={}){const r=await fetch(SITE+path,{...init,redirect:'manual',headers:{'User-Agent':'PMP-cart-verification/1.0',...(jar.size?{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')}:{}),...init.headers},signal:AbortSignal.timeout(12000)});for(const value of r.headers.getSetCookie?.()||[]){const pair=value.split(';')[0],i=pair.indexOf('=');if(i>0)jar.set(pair.slice(0,i),pair.slice(i+1));}return r;}
 try{
  await get(spec.root+'/');await get('/localization',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({form_type:'localization',_method:'put',country_code:spec.country,return_to:spec.root+'/cart'})});await get(spec.root+'/cart');
  const product=await(await get(spec.root+'/products/liquid-collagen-for-dogs.js')).json();
  const price=product.variants.find(v=>v.id===43349565112394).price;
  const properties={'Bundle offer':spec.qty===5?'Buy 3 Get 2 Free':'1 Bottle','_pmp_bundle':String(spec.qty),'_pmp_offer_total_cents':String(price*(spec.qty===5?3:1))};
  const added=await get(spec.root+'/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{id:43349565112394,quantity:spec.qty,properties}]})});out.addStatus=added.status;if(!added.ok)throw Error('CART_ADD_FAILED');
  if(spec.discount)await get(spec.root+'/cart/update.js',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({discount:spec.discount})});
  const raw=await(await get(spec.root+'/cart.js')).json();
  const cart={currency:raw.currency,total_price:raw.total_price,items_subtotal_price:raw.items_subtotal_price,item_count:raw.item_count,cart_level_discount_applications:raw.cart_level_discount_applications,items:raw.items.map(i=>({variant_id:i.variant_id,quantity:i.quantity,final_line_price:i.final_line_price,original_line_price:i.original_line_price,product_title:i.product_title,image:i.image,properties:i.properties}))};
  out.cartTotal=raw.total_price;out.currency=raw.currency;out.lines=cart.items.map(i=>({id:i.variant_id,quantity:i.quantity,total:i.final_line_price,properties:i.properties}));out.cartDiscounts=(raw.cart_level_discount_applications||[]).map(d=>({type:d.type,title:d.title,amount:d.total_allocated_amount}));
  const r=await fetch(ENDPOINT,{method:'POST',headers:{Origin:SITE,'Content-Type':'application/json'},body:JSON.stringify({pmp_cart:cart,currency:raw.currency,checkout_country:spec.country,locale:'en',storefront_root:spec.root||'/',marketing_allowed:false}),signal:AbortSignal.timeout(60000)});const data=await r.json();out.checkoutStatus=r.status;out.code=data.code||null;out.provider=data.paymentProvider||null;out.checkoutTotal=data.amountTotal;
 }catch(e){out.error=/^[A-Z_]+$/.test(e.message)?e.message:'REQUEST_FAILED';}
 finally{try{await get(spec.root+'/cart/clear.js',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}}
 console.log('GODADDY_PROPERTY_CASE '+JSON.stringify(out));
}
console.log('GODADDY_PROPERTY_DIAGNOSTIC '+JSON.stringify(report));

// Load only for an explicit preview test. Does not attach to or replace existing payment buttons.
(()=>{
 const target='https://pmp-stripe-bridge-git-prep-godaddy-payments-20260909-pet-vault.vercel.app';
 if(!['www.puremajestypet.com','puremajestypet.com'].includes(location.hostname))return;
 let running=false;
 window.PMPGoDaddyCheckout={async start(){
  if(running)throw Error('CHECKOUT_ALREADY_OPEN');running=true;
  const root=window.Shopify?.routes?.root||'/';if(!/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?$/.test(root)){running=false;throw Error('INVALID_STOREFRONT_ROOT');}
  const nonce=crypto.randomUUID().replaceAll('-',''),locale=window.Shopify?.locale||document.documentElement.lang||navigator.language||'en';
  const country=window.Shopify?.country||document.querySelector('[name="country_code"]')?.value;
  if(!/^[A-Z]{2}$/.test(country||'')){running=false;throw Error('COUNTRY_NOT_AVAILABLE');}
  const url=new URL('/godaddy-checkout.html',target);url.searchParams.set('receive_cart','1');url.searchParams.set('handoff',nonce);url.searchParams.set('lang',locale);
  // Open synchronously from the user's click so browsers do not block the window.
  const popup=window.open(url.href,'pmp-godaddy-'+nonce);if(!popup){running=false;throw Error('ALLOW_CHECKOUT_WINDOW');}
  let ready=false,payload=null,sent=false;
  function send(){if(ready&&payload&&!sent){sent=true;popup.postMessage({type:'pmp-godaddy-cart',nonce,payload},target);cleanup();}}
  function listener(event){if(event.origin!==target||event.source!==popup||event.data?.type!=='pmp-godaddy-ready'||event.data.nonce!==nonce)return;ready=true;send();}
  const timer=setTimeout(cleanup,120000);function cleanup(){clearTimeout(timer);window.removeEventListener('message',listener);running=false;}
  window.addEventListener('message',listener);
  try{
   const response=await fetch(root+'cart.js',{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('CART_READ_FAILED');const cart=await response.json();
   // Compact allowlist excludes descriptions, customer data, cookie values and cart access-key suffixes.
   payload={country,locale,storefrontRoot:root,browserLanguages:navigator.languages,cart:{token:typeof cart.token==='string'?cart.token.split('?')[0]:null,currency:cart.currency,total_price:cart.total_price,items_subtotal_price:cart.items_subtotal_price,item_count:cart.item_count,cart_level_discount_applications:(cart.cart_level_discount_applications||[]).map(d=>({total_allocated_amount:d.total_allocated_amount})),items:cart.items.map(i=>({variant_id:i.variant_id||i.id,quantity:i.quantity,product_title:i.product_title||i.title,image:i.image,original_line_price:i.original_line_price,final_line_price:i.final_line_price??i.line_price,...(i.selling_plan_allocation?{selling_plan_allocation:true}:{})}))}};
   send();return {opened:true};
  }catch(error){cleanup();popup.close();throw error;}
 }};
})();

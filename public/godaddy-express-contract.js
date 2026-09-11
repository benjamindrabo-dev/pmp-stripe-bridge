// Wallet amounts always use the already validated server CAD quote.
export const WALLET_METHODS=Object.freeze(['apple_pay','google_pay']);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=(v,n=200)=>typeof v==='string'?v.trim().replace(/[\u0000-\u001f\u007f]/g,'').slice(0,n):'';
const minor=v=>Number.isSafeInteger(v)&&v>=0;
export function decimal(n){if(!minor(n))fail('INVALID_WALLET_AMOUNT');const s=String(n).padStart(3,'0');return s.slice(0,-2)+'.'+s.slice(-2);}
export function walletSheet(q,labels={}){
 if(!q||q.chargeCurrency!=='CAD'||!minor(q.chargeMinor)||q.chargeMinor<1||!minor(q.total)||q.total<1||!Array.isArray(q.items))fail('INVALID_WALLET_QUOTE');
 const rows=q.items.map(i=>({label:text(i.title,100)+(i.quantity>1?' × '+i.quantity:''),value:i.lineTotalMinor}));
 rows.push({label:labels.shipping||'Delivery',value:q.shipping},{label:labels.tax||'Taxes',value:q.tax});
 if(rows.some(i=>!minor(i.value))||rows.reduce((n,i)=>n+i.value,0)!==q.total)fail('WALLET_TOTAL_MISMATCH');
 // Cumulative integer rounding preserves the exact CAD total and zero-price gifts.
 let cumulative=0n,allocated=0n;const total=BigInt(q.total),charge=BigInt(q.chargeMinor);
 const lineItems=rows.map(i=>{cumulative+=BigInt(i.value);const next=(cumulative*charge+total/2n)/total;const amount=decimal(Number(next-allocated));allocated=next;return {label:i.label,amount};});
 const shippingAmount=lineItems[lineItems.length-2].amount;
 return {total:{label:'Pure Majesty Pets',amount:decimal(q.chargeMinor),isPending:false},lineItems:lineItems.filter((i,n)=>n<q.items.length||i.amount!=='0.00'),shippingMethods:[{id:'pmp_delivery',label:labels.shipping||'Delivery',detail:'',amount:shippingAmount}]};
}
export function walletRequest(q,config,labels){
 if(config?.merchantCountry!=='CA'||config?.currency!=='CAD')fail('INVALID_WALLET_MERCHANT');
 return {...walletSheet(q,labels),country:'CA',currency:'CAD',merchantName:'Pure Majesty Pets',requireEmail:true,requireShippingAddress:true,requirePhone:false,supportCouponCode:false,disableWallets:{applePay:config.applePay!==true,googlePay:config.googlePay!==true,paze:true}};
}
export function walletContact(event,q){
 if(!WALLET_METHODS.includes(event?.source)||typeof event?.nonce!=='string'||event.nonce.length<8||event.nonce.length>4096||/\s/.test(event.nonce))fail('INVALID_WALLET_PAYMENT');
 function address(a){
  const parts=text(a?.name,200).split(/\s+/).filter(Boolean);
  const out={first_name:parts.shift()||'',last_name:parts.join(' '),address_line_1:text(a?.addressLines?.[0]),address_line_2:text(a?.addressLines?.slice(1).join(', ')),locality:text(a?.locality,100),administrative_district_level_1:text(a?.administrativeArea,100),postal_code:text(a?.postalCode,20),country:text(a?.countryCode,2).toUpperCase()};
  if(!out.first_name||!out.last_name||!out.address_line_1||!out.locality||!/^[A-Z]{2}$/.test(out.country))fail('WALLET_ADDRESS_INCOMPLETE');
  if(['CA','US','GB'].includes(out.country)&&!out.postal_code)fail('WALLET_ADDRESS_INCOMPLETE');
  if(['CA','US'].includes(out.country)&&!out.administrative_district_level_1)fail('WALLET_ADDRESS_INCOMPLETE');return out;
 }
 const shipping=address(event.shippingAddress),billing=address(event.billingAddress);
 if(shipping.country!==q.country)fail('WALLET_COUNTRY_CHANGED');
 const email=text(event.shippingAddress?.emailAddress||event.billingAddress?.emailAddress,254).toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail('WALLET_EMAIL_REQUIRED');
 return {email,shipping,billing,confirmedChargeMinor:q.chargeMinor};
}

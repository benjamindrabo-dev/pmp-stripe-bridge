// Active country markets read from Shopify on 2026-09-10. Shopify's rebuilt
// cart remains authoritative for availability, currency and prices.
export const CHECKOUT_COUNTRIES=Object.freeze(('AF AX AL DZ AD AO AI AG AR AM AW AC AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BA BW BR IO VG BN BG BF BI KH CM CA CV BQ KY CF TD CL CN CX CC CO KM CG CD CK CR HR CW CY CZ CI DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF TF GA GM GE DE GH GI GR GL GD GP GT GG GN GW GY HT HN HK HU IS IN ID IQ IE IM IL IT JM JP JE JO KZ KE KI XK KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MQ MR MU YT MX MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF MK NO OM PK PS PA PG PY PE PH PN PL PT QA RE RO RU RW SH KN LC MF VC BL PM WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA GS KR SS ES LK SD SR SJ SE CH TW TJ TZ TH TL TG TK TO TT TA TN TR TM TC TV UM UG UA AE GB US UY UZ VU VA VE VN WF EH YE ZM ZW').split(' '));
const countrySet=new Set(CHECKOUT_COUNTRIES);
function fail(code){throw Object.assign(new Error(code),{code,status:400});}
// UNLISTED is purchasable by direct link. It must not be made public or added
// to recommendations just to accept a cart Shopify has already validated.
export const purchasableStatus=status=>status==='ACTIVE'||status==='UNLISTED';
export function checkoutCountry(value){
 const code=typeof value==='string'?value.trim().toUpperCase():'';
 if(!countrySet.has(code))fail('COUNTRY_NOT_AVAILABLE');
 return code;
}
/** Merchandise from a stored quote only; never use a browser-provided price. */
export function snapshotForCountry(cart){
 if(!cart?.sourceSnapshot||!Array.isArray(cart.sourceSnapshot.items)||!Array.isArray(cart.items)||!cart.items.length)fail('COUNTRY_CHANGE_RELOAD_REQUIRED');
 const source=cart.sourceSnapshot;
 const items=cart.items.map(item=>{
  if(!Number.isSafeInteger(item.variant_id)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>50)fail('INVALID_CART_LINE');
  const original=Number.isSafeInteger(item.sourceLine)?source.items[item.sourceLine]:null;
  const properties={};
  // The old market's advertised numeric total must not cross into the new one.
  // Shopify computes all actual prices and discounts in the destination market.
  if(original&&Number(original.variant_id||original.id)===item.variant_id){
   for(const key of ['Bundle offer','_pmp_bundle']){
    const value=original.properties?.[key];if(typeof value==='string'&&value.length<=250)properties[key]=value;
   }
  }
  const price=item.original_price_cents;
  if(!Number.isSafeInteger(price)||price<0)fail('INVALID_AMOUNT');
  return {variant_id:item.variant_id,quantity:item.quantity,properties,product_title:item.title||'',image:item.image||null,final_line_price:price*item.quantity,original_line_price:price*item.quantity};
 });
 return {...source,items,item_count:items.reduce((n,i)=>n+i.quantity,0)};
}

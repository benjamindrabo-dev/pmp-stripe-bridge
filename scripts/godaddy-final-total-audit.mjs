// Explicit non-persistent calculation. Never creates a Shopify draft/order or a payment.
import {readFileSync} from 'node:fs';
const QUERY=`mutation GoDaddyFinalTotals($input: DraftOrderInput!) { draftOrderCalculate(input:$input) { userErrors { field message } calculatedDraftOrder { currencyCode presentmentCurrencyCode taxesIncluded totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } } subtotalPriceSet { presentmentMoney { amount currencyCode } } totalTaxSet { presentmentMoney { amount currencyCode } } totalShippingPriceSet { presentmentMoney { amount currencyCode } } taxLines { title rate priceSet { presentmentMoney { amount currencyCode } } } } } }`;
if(process.argv[2]==='--run'){
 const report={testedAt:new Date().toISOString(),operation:'draftOrderCalculate-only',draftsCreated:0,ordersCreated:0,paymentsSubmitted:0,cases:[]};
 try{
  if(process.env.VERCEL_ENV!=='production'||process.env.VERCEL_GIT_COMMIT_REF!=='main')throw Error('PRODUCTION_CONFIGURATION_REQUIRED');
  const deployed=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  if((process.env.PMP_GODADDY_ENABLED??deployed.env?.PMP_GODADDY_ENABLED)!=='0')throw Error('DISABLED_LAUNCH_REQUIRED');
  const domain=process.env.SHOPIFY_STORE_DOMAIN;
  if(!/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(domain||'')||!process.env.SHOPIFY_ADMIN_TOKEN)throw Error('SHOPIFY_CONFIGURATION_MISSING');
  for(const scenario of [{country:'CA',province:'QC',zip:'J8T0A3',city:'Gatineau',currency:'CAD',amount:'45.00'},{country:'US',province:'NJ',zip:'07305',city:'Jersey City',currency:'USD',amount:'31.99'},{country:'FR',zip:'75001',city:'Paris',currency:'EUR',amount:'28.95'}]){
   const input={presentmentCurrencyCode:scenario.currency,acceptAutomaticDiscounts:false,lineItems:[{variantId:'gid://shopify/ProductVariant/43349565112394',quantity:1,priceOverride:{amount:scenario.amount,currencyCode:scenario.currency}}],shippingAddress:{countryCode:scenario.country,provinceCode:scenario.province,zip:scenario.zip,city:scenario.city},shippingLine:{title:'Shipping',priceWithCurrency:{amount:'0.00',currencyCode:scenario.currency}}};
   const response=await fetch('https://'+domain+'/admin/api/2026-07/graphql.json',{method:'POST',redirect:'error',headers:{'X-Shopify-Access-Token':process.env.SHOPIFY_ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({query:QUERY,variables:{input}}),signal:AbortSignal.timeout(15000)});
   const data=await response.json();const result=data.data?.draftOrderCalculate;
   if(!response.ok||data.errors||result?.userErrors?.length||!result?.calculatedDraftOrder){report.cases.push({country:scenario.country,status:response.status,passed:false,errors:(data.errors||result?.userErrors||[]).map(e=>({code:e.extensions?.code||null,field:e.field||null})),calculationAvailable:false});continue;}
   const c=result.calculatedDraftOrder;report.cases.push({country:scenario.country,passed:true,shopCurrency:c.currencyCode,currency:c.presentmentCurrencyCode,taxesIncluded:c.taxesIncluded,merchandise:scenario.amount,tax:c.totalTaxSet?.presentmentMoney?.amount,shipping:c.totalShippingPriceSet?.presentmentMoney?.amount,total:c.totalPriceSet?.presentmentMoney?.amount,shopTotal:c.totalPriceSet?.shopMoney?.amount});
  }
 }catch(e){report.error=/^[A-Z_]+$/.test(e.message||'')?e.message:'CALCULATION_UNAVAILABLE';}
 console.log('GODADDY_FINAL_TOTAL_AUDIT '+JSON.stringify(report));
}

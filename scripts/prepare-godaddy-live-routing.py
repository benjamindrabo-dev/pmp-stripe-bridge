"""Apply the reviewed checkout wiring on the isolated release branch, not live settings."""
from pathlib import Path
import json

ROOT=Path(__file__).resolve().parents[1]
def replace(path,old,new):
    file=ROOT/path
    text=file.read_text()
    if new in text:
        return
    if text.count(old)!=1:
        raise RuntimeError('Unexpected source shape: '+path)
    file.write_text(text.replace(old,new,1))

# Launch intent is not represented as a completed provider risk review. Runtime
# readiness below separately re-reads the actual registered, verified webhook.
replace('lib/godaddy-embedded-core.js',
"export function liveEnabled(env=process.env){return env.VERCEL_ENV==='production'&&env.PMP_GODADDY_ENABLED==='1'&&env.PMP_GODADDY_REVIEW_APPROVED==='1'&&env.PMP_GODADDY_ACCEPTANCE_VERIFIED==='1'&&env.GODADDY_WEBHOOK_VERIFIED==='1'&&Boolean(env.GODADDY_PRIVATE_KEY&&env.GODADDY_WEBHOOK_SECRET)&&UUID.test(env.GODADDY_BUSINESS_ID||'')&&UUID.test(env.GODADDY_STORE_ID||'')&&env.GODADDY_CHARGE_CURRENCY==='CAD';}",
"// Operator launch authorization, not an assertion of provider review/payout status.\nexport function liveEnabled(env=process.env){return env.VERCEL_ENV==='production'&&env.PMP_GODADDY_ENABLED==='1'&&env.PMP_GODADDY_LAUNCH_AUTHORIZED==='1'&&env.PMP_GODADDY_ACCEPTANCE_VERIFIED==='1'&&Boolean(env.GODADDY_PRIVATE_KEY)&&UUID.test(env.GODADDY_BUSINESS_ID||'')&&UUID.test(env.GODADDY_STORE_ID||'')&&/^urn:aid:[a-f0-9-]{36}$/i.test(env.GODADDY_APPLICATION_ID||'')&&env.GODADDY_CHARGE_CURRENCY==='CAD';}")

replace('lib/godaddy-embedded.js',"import {randomUUID} from 'node:crypto';", "import {randomUUID} from 'node:crypto';\nimport {readHookSettings,DELIVERY_URL} from './godaddy-hook-settings.js';")
replace('lib/godaddy-embedded.js',"const BRANCH='prep/godaddy-payments-20260909';", "const BRANCHES=['prep/godaddy-payments-20260909','release/godaddy-live-20260910'];")
replace('lib/godaddy-embedded.js',"process.env.VERCEL_GIT_COMMIT_REF===BRANCH", "BRANCHES.includes(process.env.VERCEL_GIT_COMMIT_REF)")
replace('lib/godaddy-embedded.js',
"async function ensureStore(){if(Date.now()-storeCheckedAt<30000)return;const c=config();const s=await request(`/businesses/${c.businessId}/stores/${c.storeId}`);if(s.id!==c.storeId||s.businessId!==c.businessId||s.currency!=='CAD'||s.status!=='ACTIVE'||s.mockProcessor===true)throw fail('GODADDY_STORE_UNAVAILABLE',503);storeCheckedAt=Date.now();}",
"""export async function ensureStore(){
 if(Date.now()-storeCheckedAt<30000)return;
 const c=config();
 if(process.env.VERCEL_ENV==='production'){
  const hook=await readHookSettings(c);
  if(!hook||hook.registered!==true||hook.signatureChecksVerified!==true||!UUID.test(hook.hookId)||hook.deliveryUrl!==DELIVERY_URL)throw fail('GODADDY_WEBHOOK_NOT_READY',503);
 }
 const s=await request(`/businesses/${c.businessId}/stores/${c.storeId}`);
 if(s.id!==c.storeId||s.businessId!==c.businessId||s.currency!=='CAD'||s.status!=='ACTIVE'||s.mockProcessor===true)throw fail('GODADDY_STORE_UNAVAILABLE',503);
 storeCheckedAt=Date.now();
}
async function withCartLock(id,run){
 if(!validSession(id))throw fail('INVALID_SESSION');
 const key=prefix()+'cart-edit:'+id,token=randomUUID();
 if(await redis(['SET',key,token,'NX','EX','120'])!=='OK')throw fail('CHECKOUT_BUSY',409);
 try{return await run();}finally{await redis(['EVAL',"if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",'1',key,token]);}
}
export async function prepare(id,body){return withCartLock(id,()=>prepareUnlocked(id,body));}
export async function pay(id,body){return withCartLock(id,()=>payUnlocked(id,body));}
export async function promotion(id,body){return withCartLock(id,()=>promotionUnlocked(id,body));}""")
replace('lib/godaddy-embedded.js',"export async function prepare(id,body){\n if(!liveEnabled())", "async function prepareUnlocked(id,body){\n await ensureStore();\n if(!liveEnabled())")
replace('lib/godaddy-embedded.js',"export async function pay(id,body){\n", "async function payUnlocked(id,body){\n")
replace('lib/godaddy-embedded.js',"export async function promotion(id,body){if(!canPrepare())", "async function promotionUnlocked(id,body){if(!canPrepare())")
replace('lib/godaddy-embedded.js',"if(cart.supersededBy||await storage.get('attempt:'+id))throw fail('PAYMENT_ALREADY_STARTED',409);", "if(cart.supersededBy||await storage.get('prepared:'+id)||await storage.get('attempt:'+id)||await storage.get('done:'+id))throw fail('PAYMENT_ALREADY_STARTED',409);")
replace('lib/godaddy-embedded.js',"const result={paymentId:transactionId,orderId:order.legacyResourceId||order.id,orderName:order.name,amount:cart.total,currency:cart.displayCurrency};", "const result={paymentId:transactionId,orderId:order.legacyResourceId||order.id,orderName:order.name,amount:cart.total,currency:cart.displayCurrency};")
# Keep the on-page receipt; the existing Shopify thank-you endpoint only supports
# Stripe/Square sessions and must not be falsely reused for gd_ sessions.

replace('lib/godaddy-cart.js',"'cart-edit:'+id,token=randomUUID();if(await redis(['SET',lock,token,'NX','EX','60'])", "'cart-edit:'+id,token=randomUUID();if(await redis(['SET',lock,token,'NX','EX','120'])")
# Preserve attribution already sanitized by the existing storefront helper.
replace('lib/godaddy-cart.js',"input.attribution={...attribution(body.attribution),shopify_cart_token:supplied.shopifyCartToken};input.promotionCode=null;", """input.attribution={...attribution(body.attribution),shopify_cart_token:supplied.shopifyCartToken};
 for(const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','external_id','browser_id','attribution_model']){
  const v=body.attribution?.[key];if(typeof v==='string'&&v.length<=255&&!/[\\x00-\\x1f\\x7f@]/.test(v))input.attribution[key]=v;
 }
 if(typeof body.attribution?.shopify_cart_url==='string'){
  try{const u=new URL(body.attribution.shopify_cart_url);if(u.protocol==='https:'&&['www.puremajestypet.com','puremajestypet.com'].includes(u.hostname)){u.search='';u.hash='';u.username='';u.password='';input.attribution.shopify_cart_url=u.href;}}catch{}
 }
 input.promotionCode=null;""")
# The first saved quote must match the Ajax cart. Promotions are applied in the
# visible checkout and cannot invisibly change the incoming cart subtotal.
replace('lib/godaddy-cart.js',"input.promotionCode=null;\n const result=await createGoDaddyQuote(input);", "input.promotionCode=null;input.skipAutomaticPromotion=true;\n const result=await createGoDaddyQuote(input);")
replace('lib/godaddy-embedded.js',"const automatic=input.attribution?.utm_source", "const automatic=!input.skipAutomaticPromotion&&input.attribution?.utm_source")

# A real Ajax cart snapshot, localized route and consent go through the existing
# Vercel-served helper; no theme replacement or interception of card requests.
replace('api/meta-offer-summary.js',
"return prepareSuggestions.then(function(){return nativeFetch(input,nextInit);}).then(function(response){",
"""return prepareSuggestions.then(async function(){
        var payload=JSON.parse(nextInit.body);
        try {
          var root=(window.Shopify&&window.Shopify.routes&&window.Shopify.routes.root)||'/';
          var response=await nativeFetch(root+'cart.js',{cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});
          if(!response.ok)throw new Error('cart');
          var cart=await response.json();
          payload.pmp_cart={token:typeof cart.token==='string'?cart.token.split('?')[0]:null,currency:cart.currency,total_price:cart.total_price,items_subtotal_price:cart.items_subtotal_price,item_count:cart.item_count,cart_level_discount_applications:(cart.cart_level_discount_applications||[]).map(function(d){return {total_allocated_amount:d.total_allocated_amount};}),items:(cart.items||[]).map(function(i){return {variant_id:i.variant_id||i.id,quantity:i.quantity,final_line_price:i.final_line_price,original_line_price:i.original_line_price,product_title:i.product_title||i.title,image:typeof i.image==='string'?i.image:null,selling_plan_allocation:!!i.selling_plan_allocation};})};
          payload.storefront_root=root;payload.locale=(window.Shopify&&window.Shopify.locale)||document.documentElement.lang||'en';
        }catch(_){delete payload.pmp_cart;}
        nextInit.body=JSON.stringify(payload);
        return nativeFetch(input,nextInit);
      }).then(function(response){""")
replace('api/meta-offer-summary.js',"squareUrl.pathname !== '/square-checkout.html'", "!['/square-checkout.html','/godaddy-checkout.html'].includes(squareUrl.pathname)")

replace('api/create-checkout.js',"export default async function handler(req, res) {\n", """export default async function handler(req, res) {
  // Only new checkout creation is switched. Existing processor settlement routes
  // and sessions remain unchanged. Never retry an uncertain charge elsewhere.
  if(process.env.CHECKOUT_PROVIDER==='godaddy'){
    const {default:godaddyEntry}=await import('./godaddy-entry.js');
    return godaddyEntry(req,res);
  }
""")

# Production HTTP endpoints need enough time for independent Shopify cart
# recalculation and the provider + Shopify order operations.
file=ROOT/'vercel.json';config=json.loads(file.read_text())
for path in ['api/godaddy-cart.js','api/godaddy-checkout.js','api/godaddy-entry.js','api/godaddy-webhook.js','api/godaddy-reconcile.js']:
    config.setdefault('functions',{})[path]={'maxDuration':60}
config.pop('buildCommand',None)
file.write_text(json.dumps(config,indent=2)+'\n')
print('GoDaddy launch code prepared. Production routing/activation flags not changed.')

// Server-only webhook settings. Secrets are stored in authenticated Redis, never
// in browser assets, source code, URLs, diagnostic output or deployment logs.
export const DELIVERY_URL='https://pmp-stripe-bridge.vercel.app/api/godaddy-webhook';
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function hookKey(config,environment){
 if(!['production','preview'].includes(environment)||!UUID.test(config.businessId)||!UUID.test(config.storeId))fail('HOOK_CONFIG_INVALID');
 return `godaddy:${environment}:${config.businessId}:hook-settings:${config.storeId}`;
}
export function assertHookSettings(value,config){
 if(!value||value.businessId!==config.businessId||value.storeId!==config.storeId||value.applicationId!==config.applicationId||value.deliveryUrl!==DELIVERY_URL||typeof value.secret!=='string'||value.secret.length<32)fail('HOOK_CONFIG_MISMATCH');
 return value;
}
export async function hookRedis(command,{env=process.env,fetchImpl=globalThis.fetch}={}){
 let url;try{url=new URL(env.UPSTASH_REDIS_REST_URL);}catch{fail('HOOK_STORAGE_MISSING');}
 if(url.protocol!=='https:'||url.username||url.password||!env.UPSTASH_REDIS_REST_TOKEN)fail('HOOK_STORAGE_MISSING');
 let response;try{response=await fetchImpl(url.href,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(1200)});}catch{fail('HOOK_STORAGE_UNAVAILABLE');}
 let data;try{data=await response.json();}catch{fail('HOOK_STORAGE_UNAVAILABLE');}
 if(!response.ok||data.error)fail('HOOK_STORAGE_UNAVAILABLE');return data.result;
}
export async function readHookSettings(config,options={}){
 const env=options.env||process.env;
 const raw=await hookRedis(['GET',hookKey(config,env.VERCEL_ENV)],options);
 if(!raw)return null;let data;try{data=JSON.parse(raw);}catch{fail('HOOK_CONFIG_INVALID');}
 return assertHookSettings(data,config);
}
export async function receiverSecret(config,options={}){
 const env=options.env||process.env;
 if(typeof env.GODADDY_WEBHOOK_SECRET==='string'&&env.GODADDY_WEBHOOK_SECRET.length>=32)return env.GODADDY_WEBHOOK_SECRET;
 const saved=await readHookSettings(config,options);if(!saved)fail('HOOK_SECRET_MISSING');return saved.secret;
}

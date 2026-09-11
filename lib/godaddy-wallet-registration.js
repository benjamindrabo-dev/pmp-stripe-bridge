// Server-only infrastructure operations. This client cannot charge a card.
import {createGoDaddyAssertion} from './godaddy-payments.js';
import {hookRedis,UUID} from './godaddy-hook-settings.js';
export const WALLET_DOMAINS=Object.freeze(['checkout.puremajestypet.com','pmp-stripe-bridge.vercel.app']);
export const ASSOCIATION_PATH='/.well-known/apple-developer-merchantid-domain-association';
const HOST='https://services.poynt.net';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function walletMerchant(env=process.env){
 const c={businessId:env.GODADDY_BUSINESS_ID,storeId:env.GODADDY_STORE_ID,applicationId:env.GODADDY_APPLICATION_ID,privateKey:String(env.GODADDY_PRIVATE_KEY||'').replace(/\\n/g,'\n')};
 if(!UUID.test(c.businessId||'')||!UUID.test(c.storeId||'')||!/^urn:aid:[a-f0-9-]{36}$/i.test(c.applicationId||'')||!c.privateKey)fail('WALLET_MERCHANT_NOT_CONFIGURED');
 return c;
}
export const walletSettingsKey=c=>`godaddy:production:${c.businessId}:wallet-settings:${c.storeId}`;
export async function walletProviderClient(c,{fetchImpl=globalThis.fetch}={}){
 const auth=await fetchImpl(HOST+'/token',{method:'POST',redirect:'error',headers:{'api-version':'1.2','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grantType:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:createGoDaddyAssertion(c)}),signal:AbortSignal.timeout(10000)});
 if(!auth.ok)fail('WALLET_AUTHENTICATION_FAILED');const token=await auth.json();if(typeof token.accessToken!=='string')fail('WALLET_AUTHENTICATION_FAILED');
 return async function(operation,body){
  if(!['domain-association-file','registration'].includes(operation)||body&&operation!=='registration')fail('WALLET_OPERATION_NOT_ALLOWED');
  if(body&&(!Array.isArray(body.registerDomains)||body.registerDomains.some(d=>!WALLET_DOMAINS.includes(d))||body.unregisterDomains))fail('WALLET_DOMAIN_NOT_ALLOWED');
  const r=await fetchImpl(HOST+'/businesses/'+c.businessId+'/apple-pay/'+operation,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token.accessToken,'api-version':'1.2',Accept:operation==='domain-association-file'?'text/plain':'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(!r.ok)fail('WALLET_PROVIDER_HTTP_'+r.status);
  if(operation==='registration')return r.json();
  const text=await r.text();if(text.length<100||text.length>100000||/<html|<!doctype|PRIVATE KEY|accessToken/i.test(text))fail('INVALID_ASSOCIATION_FILE');return text;
 };
}
export async function walletRegistration(c){
 const raw=await hookRedis(['GET',walletSettingsKey(c)]);if(!raw)return null;
 let value;try{value=JSON.parse(raw);}catch{return null;}
 if(value.businessId!==c.businessId||value.storeId!==c.storeId||value.applicationId!==c.applicationId||!Array.isArray(value.registeredDomains))return null;
 return value;
}

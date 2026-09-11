// Merchant-authorized Apple Pay domain enrollment only. Never charges or creates orders.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {walletMerchant,walletProviderClient,walletSettingsKey,WALLET_DOMAINS,ASSOCIATION_PATH} from '../lib/godaddy-wallet-registration.js';
import {hookRedis} from '../lib/godaddy-hook-settings.js';
const report={at:new Date().toISOString(),operation:'apple-pay-domain-registration',paymentsSubmitted:0,ordersCreated:0,domains:[]};
try{
 if(process.argv[2]!=='--register'||process.env.VERCEL_ENV!=='production'||process.env.VERCEL_GIT_COMMIT_REF!=='main')throw Object.assign(Error(),{code:'REGISTRATION_NOT_REQUESTED'});
 const file=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
 const c=walletMerchant({...file.env,...process.env});
 if(c.businessId!=='3cfdebe4-e85d-41e9-9b26-96002a0c8654'||c.storeId!=='40c35dbb-13c6-466f-b3f7-d832c4fb58c0'||c.applicationId!=='urn:aid:8982d4de-1db8-40dc-b7a2-211222a2325f')throw Object.assign(Error(),{code:'MERCHANT_MISMATCH'});
 const provider=await walletProviderClient(c),association=await provider('domain-association-file');
 const hash=x=>createHash('sha256').update(x).digest('hex');
 for(const domain of WALLET_DOMAINS){
  const r=await fetch('https://'+domain+ASSOCIATION_PATH,{redirect:'error',signal:AbortSignal.timeout(30000)});
  const same=r.ok&&hash(await r.text())===hash(association);report.domains.push({domain,fileMatches:same,http:r.status});
  if(!same)throw Object.assign(Error(),{code:'DOMAIN_ASSOCIATION_NOT_READY'});
 }
 let before=null;try{before=await provider('registration');}catch(e){if(e.code!=='WALLET_PROVIDER_HTTP_404')throw e;}
 const domainsOf=value=>Array.isArray(value?.domain)?value.domain:Array.isArray(value?.domains)?value.domains:[];
 const missing=WALLET_DOMAINS.filter(d=>!domainsOf(before).includes(d));
 if(missing.length)await provider('registration',{registerDomains:missing,merchantName:'Pure Majesty Pets',merchantUrl:'https://www.puremajestypet.com'});
 const after=await provider('registration');
 const registeredDomains=WALLET_DOMAINS.filter(d=>domainsOf(after).includes(d));
 if(registeredDomains.length!==WALLET_DOMAINS.length)throw Object.assign(Error(),{code:'REGISTRATION_READBACK_MISMATCH'});
 await hookRedis(['SET',walletSettingsKey(c),JSON.stringify({businessId:c.businessId,storeId:c.storeId,applicationId:c.applicationId,registeredDomains,registeredAt:new Date().toISOString()})]);
 report.result='registered-and-verified';report.registeredDomains=registeredDomains;report.registrationWritten=missing.length>0;
}catch(error){report.result='not-registered';report.code=/^[A-Z0-9_]+$/.test(error.code||'')?error.code:'WALLET_SETUP_FAILED';}
console.log('GODADDY_WALLET_REGISTRATION '+JSON.stringify(report));

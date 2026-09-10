import {createPublicKey, verify} from 'node:crypto';

export const ISSUER='https://token.actions.githubusercontent.com';
export const AUDIENCE='https://checkout.puremajestypet.com/api/godaddy-reconcile';
export const REPOSITORY='benjamindrabo-dev/pmp-stripe-bridge';
export const WORKFLOW=REPOSITORY+'/.github/workflows/godaddy-reconcile.yml@refs/heads/main';
let cachedKeys=null, cachedAt=0;
const denied=()=>{throw Object.assign(new Error('SCHEDULER_UNAUTHORIZED'),{status:401});};
function decode(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))denied();
 try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{denied();}
}
export function verifySchedulerToken(token,keys,now=Date.now()){
 if(typeof token!=='string'||token.length>16000)denied();
 const parts=token.split('.');if(parts.length!==3)denied();
 const h=decode(parts[0]),p=decode(parts[1]);
 if(h.alg!=='RS256'||h.typ!=='JWT'||typeof h.kid!=='string'||h.jku||h.x5u||h.crit)denied();
 const jwk=keys?.find(k=>k.kid===h.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));
 if(!jwk||!/^[A-Za-z0-9_-]+$/.test(parts[2]))denied();
 try{if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))denied();}catch{denied();}
 const seconds=Math.floor(now/1000);
 if(p.iss!==ISSUER||p.aud!==AUDIENCE||p.repository!==REPOSITORY||String(p.repository_id)!=='1290964525'||String(p.repository_owner_id)!=='248519076'||p.ref!=='refs/heads/main'||p.workflow_ref!==WORKFLOW||!['schedule','workflow_dispatch','push'].includes(p.event_name))denied();
 if(!Number.isFinite(p.exp)||!Number.isFinite(p.iat)||!Number.isFinite(p.nbf)||p.exp<=seconds||p.nbf>seconds+30||p.iat>seconds+30||seconds-p.iat>600||p.exp-p.iat>600||typeof p.jti!=='string'||!p.jti)denied();
 return {verified:true,runId:String(p.run_id||''),tokenId:p.jti};
}
export async function authorizeScheduler(header,{fetchImpl=globalThis.fetch,now=Date.now}={}){
 if(typeof header!=='string'||!header.startsWith('Bearer '))denied();
 const token=header.slice(7);if(token.length>16000||token.split('.').length!==3)denied();
 // Never fetch a URL supplied by the JWT. Fixed GitHub JWKS endpoint only.
 if(!cachedKeys||now()-cachedAt>300000){
  const r=await fetchImpl(ISSUER+'/.well-known/jwks',{redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!r.ok)denied();const data=await r.json();if(!Array.isArray(data.keys)||data.keys.length>20)denied();cachedKeys=data.keys;cachedAt=now();
 }
 return verifySchedulerToken(token,cachedKeys,now());
}

import {createHmac,timingSafeEqual} from 'node:crypto';
import {verifyGoDaddyWebhook,readGoDaddyConfig} from '../lib/godaddy-payments.js';
import {receiverSecret} from '../lib/godaddy-hook-settings.js';
import {prefix,settle} from '../lib/godaddy-embedded.js';
import {redis} from '../lib/square-bridge.js';
export const config={api:{bodyParser:false}};
let cachedSecret=null,cacheUntil=0;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).end();
 if(process.env.VERCEL_ENV!=='production')return res.status(404).end();
 const signature=req.headers['poynt-webhook-signature'];
 if(typeof signature!=='string'||!/^[A-Za-z0-9+/]{27}=$/.test(signature))return res.status(401).end();
 try{
  const chunks=[];let size=0;for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>65536)return res.status(413).end();chunks.push(b);}
  const raw=Buffer.concat(chunks),settings=readGoDaddyConfig();
  if(!cachedSecret||Date.now()>cacheUntil){cachedSecret=await receiverSecret(settings);cacheUntil=Date.now()+30000;}
  const expected=createHmac('sha1',cachedSecret).update(raw).digest(),actual=Buffer.from(signature,'base64');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return res.status(401).end();
  let parsed;try{parsed=JSON.parse(raw.toString('utf8'));}catch{return res.status(400).end();}
  // This signed configuration probe cannot enter order processing.
  if(parsed?.eventType==='PMP_CONFIGURATION_PROBE'){
   if(process.env.PMP_GODADDY_ENABLED==='1'||parsed.businessId!==settings.businessId||parsed.storeId!==settings.storeId||parsed.applicationId!==settings.applicationId||typeof parsed.probeId!=='string'||!/^[a-f0-9]{32}$/.test(parsed.probeId))return res.status(400).end();
   return res.status(200).json({configurationProbe:true,queued:false});
  }
  const event=verifyGoDaddyWebhook(raw,signature,{...settings,webhookSecret:cachedSecret});
  const base=String(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,'');if(!base.startsWith('https://')||!process.env.UPSTASH_REDIS_REST_TOKEN)return res.status(503).end();
  const r=await fetch(base+'/pipeline',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify([['SET',prefix()+'event:'+event.eventId,JSON.stringify(event),'NX','EX','7776000'],['SADD',prefix()+'pending',event.transactionId]]),signal:AbortSignal.timeout(1600)});
  const data=await r.json();if(!r.ok||!Array.isArray(data)||data.length!==2||data.some(x=>x.error))return res.status(503).end();
  // This notification is already authenticated above. Re-read the transaction
  // from GoDaddy and let the existing exactly-once order writer handle it.
  // No debit is created here. The separate cron endpoint/auth remains unchanged.
  // Poynt retries when an acknowledgement is not received within two seconds;
  // duplicate requests are therefore expected and safe. Never acknowledge a
  // failed order write as complete merely because an event was queued.
  const result=await settle(event.transactionId);
  if(!result.paid&&!result.ignored&&!result.declined)return res.status(503).end();
  await redis(['SREM',prefix()+'pending',event.transactionId]);
  return res.status(200).json({received:true,processed:true});
 }catch(e){return res.status(e.status===401?401:e.status===400?400:503).end();}
}

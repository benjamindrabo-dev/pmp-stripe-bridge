import {verifyGoDaddyWebhook,readGoDaddyConfig} from '../lib/godaddy-payments.js';
import {prefix} from '../lib/godaddy-embedded.js';
export const config={api:{bodyParser:false}};
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).end();
 if(process.env.VERCEL_ENV!=='production')return res.status(404).end();
 try{
  const chunks=[];let size=0;for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>65536)return res.status(413).end();chunks.push(b);}
  const event=verifyGoDaddyWebhook(Buffer.concat(chunks),req.headers['poynt-webhook-signature'],readGoDaddyConfig());
  const base=String(process.env.UPSTASH_REDIS_REST_URL||'').replace(/\/$/,'');if(!base.startsWith('https://')||!process.env.UPSTASH_REDIS_REST_TOKEN)return res.status(503).end();
  const r=await fetch(base+'/pipeline',{method:'POST',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify([['SET',prefix()+'event:'+event.eventId,JSON.stringify(event),'NX','EX','7776000'],['SADD',prefix()+'pending',event.transactionId]]),signal:AbortSignal.timeout(1600)});
  const data=await r.json();if(!r.ok||!Array.isArray(data)||data.length!==2||data.some(x=>x.error))return res.status(503).end();
  return res.status(200).json({received:true});
 }catch(e){return res.status(e.status===401?401:e.status===400?400:503).end();}
}

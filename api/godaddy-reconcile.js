import {timingSafeEqual} from 'node:crypto';
import {settle,prefix} from '../lib/godaddy-embedded.js';
import {redis} from '../lib/square-bridge.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 const secret=process.env.CRON_SECRET,raw=String(req.headers.authorization||'');const expected='Bearer '+secret;
 if(req.method!=='GET'||process.env.VERCEL_ENV!=='production'||!secret||Buffer.byteLength(raw)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(raw),Buffer.from(expected)))return res.status(401).end();
 try{const ids=await redis(['SRANDMEMBER',prefix()+'pending','3']);let resolved=0,pending=0;for(const id of ids||[]){try{const result=await settle(id);if(result.paid||result.ignored||result.declined){await redis(['SREM',prefix()+'pending',id]);resolved++;}else pending++;}catch{pending++;}}return res.status(200).json({resolved,pending});}catch{return res.status(503).json({code:'RECONCILIATION_UNAVAILABLE'});}
}

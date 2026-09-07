import crypto from 'node:crypto';
import {get,WEBHOOK_URL,settleSquarePayment} from '../lib/square-bridge.js';
export const config={api:{bodyParser:false}};
export function verify(raw,signature,key){
 if(!key||typeof signature!=='string')return false;
 const expected=crypto.createHmac('sha256',key).update(WEBHOOK_URL+raw).digest('base64');
 const a=Buffer.from(expected),b=Buffer.from(signature);return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).end();
 try{
   const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>1000000)return res.status(413).end();chunks.push(c);}
   const raw=Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8');
   const saved=await get('square:webhook:'+process.env.SQUARE_ENV);
   if(!verify(raw,req.headers['x-square-hmacsha256-signature'],process.env.SQUARE_WEBHOOK_SIGNATURE_KEY||saved?.signature_key))return res.status(401).json({error:'Invalid signature'});
   const event=JSON.parse(raw);
   if(!['payment.created','payment.updated'].includes(event.type))return res.status(200).json({ignored:true});
   const payment=event.data?.object?.payment;
   if(!payment?.id||payment.status!=='COMPLETED')return res.status(200).json({ignored:true});
   return res.status(200).json(await settleSquarePayment(payment.id));
 }catch(e){console.error('Square webhook retry',e.message);return res.status(503).json({error:'Retry required'});}
}

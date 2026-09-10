import {loadCart,publicQuote,prepare,pay,status,promotion,storage} from '../lib/godaddy-embedded.js';
import {validSession} from '../lib/godaddy-embedded-core.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({code:'METHOD_NOT_ALLOWED'});
 if(req.method==='POST'){
  const origins=['https://checkout.puremajestypet.com','https://pmp-stripe-bridge.vercel.app'];
  if(process.env.VERCEL_ENV==='preview'&&process.env.VERCEL_URL)origins.push('https://'+process.env.VERCEL_URL);
  if(!origins.includes(String(req.headers.origin||''))||!String(req.headers['content-type']||'').startsWith('application/json'))return res.status(403).json({code:'ORIGIN_NOT_ALLOWED'});
  if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Buffer.byteLength(JSON.stringify(req.body))>12000)return res.status(400).json({code:'INVALID_REQUEST'});
 }
 const id=req.method==='GET'?req.query?.session_id:req.body?.sessionId;if(!validSession(id))return res.status(400).json({code:'INVALID_SESSION'});
 try{
  if(req.method==='GET'){
   if(req.query?.view==='status')return res.status(200).json(await status(id));
   const cart=await loadCart(id);return res.status(200).json({...publicQuote(cart),completed:Boolean(await storage.get('done:'+id))});
  }
  const body=req.body;
  if(body.action==='prepare')return res.status(200).json(await prepare(id,body));
  if(body.action==='pay')return res.status(200).json(await pay(id,body));
  if(body.action==='promotion')return res.status(200).json(await promotion(id,body));
  return res.status(400).json({code:'INVALID_ACTION'});
 }catch(e){const code=/^[A-Z_]+$/.test(e.code||'')?e.code:'CHECKOUT_UNAVAILABLE';return res.status(e.status||503).json({code});}
}

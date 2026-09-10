import {createFromSnapshot,dentalSuggestion,expandedQuote,revise} from '../lib/godaddy-cart.js';
import {canPrepare,loadCart,storage,promotion} from '../lib/godaddy-embedded.js';
import {validSession} from '../lib/godaddy-embedded-core.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(!canPrepare())return res.status(404).end();
 const origins=['https://www.puremajestypet.com','https://puremajestypet.com','https://checkout.puremajestypet.com'];
 if(process.env.VERCEL_ENV==='preview')for(const key of ['VERCEL_URL','VERCEL_BRANCH_URL'])if(process.env[key])origins.push('https://'+process.env[key]);
 const origin=String(req.headers.origin||'');
 if(origin&&!origins.includes(origin))return res.status(403).json({code:'ORIGIN_NOT_ALLOWED'});
 if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
 if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','POST, GET, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');return res.status(204).end();}
 if(!['GET','POST'].includes(req.method))return res.status(405).end();
 if(req.method==='POST'&&(!origin||!String(req.headers['content-type']||'').startsWith('application/json')||!req.body||Array.isArray(req.body)||Buffer.byteLength(JSON.stringify(req.body))>48000))return res.status(400).json({code:'INVALID_REQUEST'});
 try{
  if(req.method==='POST'&&req.body.action==='create')return res.status(200).json(await createFromSnapshot(req.body));
  const id=req.method==='GET'?req.query?.session_id:req.body?.sessionId;
  if(!validSession(id))return res.status(400).json({code:'INVALID_SESSION'});
  if(req.method==='GET'){
   const cart=await loadCart(id);
   if(req.query?.view==='options')return res.status(200).json({suggestions:await dentalSuggestion(cart)});
   return res.status(200).json({...expandedQuote(cart),completed:Boolean(await storage.get('done:'+id))});
  }
  if(req.body.action==='promotion'){
   const result=await promotion(id,req.body);return res.status(200).json(expandedQuote(await loadCart(result.sessionId)));
  }
  return res.status(200).json(await revise(id,req.body));
 }catch(e){return res.status(e.status||503).json({code:/^[A-Z_]+$/.test(e.code||'')?e.code:'CART_UNAVAILABLE'});}
}

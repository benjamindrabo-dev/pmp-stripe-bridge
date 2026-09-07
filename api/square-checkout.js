import baseHandler from '../lib/create-checkout-base.js';
import {get,validId,publicQuote,createSquareQuote,captureSquareContact} from '../lib/square-bridge.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method==='POST'&&req.body?.action==='contact'){try{return res.status(200).json(await captureSquareContact(req.body.sessionId,req.body.email));}catch(e){return res.status(e.status||503).json({error:e.message});}}
 if(req.method==='POST'){
   // A saved quote can be refreshed or have a supported promotion applied.
   if(req.body?.sessionId){
     try{const {reviseCart}=await import('../lib/square-cart.js');return res.status(200).json(await reviseCart(req.body.sessionId,req.body));}catch(e){return res.status(e.status||503).json({error:e.message});}
   }
   req.squareMode=true;return baseHandler(req,res);
 }
 if(req.method!=='GET')return res.status(405).end();
 try{const id=req.query?.session_id;if(!validId(id))return res.status(400).json({error:'Invalid checkout'});const cart=await get('sess:'+id);if(!cart)return res.status(410).json({error:'Checkout expired'});const pending=await get('square:attempt:'+id);return res.status(200).json({...publicQuote(cart),paymentPending:Boolean(pending&&!pending.failed),completed:Boolean(await get('done:'+id))});}catch{return res.status(503).json({error:'Checkout temporarily unavailable'});}
}

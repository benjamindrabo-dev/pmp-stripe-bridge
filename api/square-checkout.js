import baseHandler from '../lib/create-checkout-base.js';
import {get,validId,publicQuote,createSquareQuote} from '../lib/square-bridge.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method==='POST'){
   // A saved quote can be refreshed or have a supported promotion applied.
   if(req.body?.sessionId){
     try{if(!validId(req.body.sessionId))return res.status(400).json({error:'Invalid checkout'});
       const pending=await get('square:attempt:'+req.body.sessionId);if(pending&&!pending.failed)return res.status(409).json({error:'A payment is already being confirmed for this checkout.'});
       const cart=await get('sess:'+req.body.sessionId);if(!cart)return res.status(410).json({error:'Checkout expired'});
       return res.status(200).json(await createSquareQuote({...cart,items:cart.items.map(it=>({...it,price_cents:it.original_price_cents})),promotionCode:req.body.promotionCode||cart.promotionCode}));
     }catch(e){return res.status(e.status||503).json({error:e.message});}
   }
   req.squareMode=true;return baseHandler(req,res);
 }
 if(req.method!=='GET')return res.status(405).end();
 try{const id=req.query?.session_id;if(!validId(id))return res.status(400).json({error:'Invalid checkout'});const cart=await get('sess:'+id);if(!cart)return res.status(410).json({error:'Checkout expired'});const pending=await get('square:attempt:'+id);return res.status(200).json({...publicQuote(cart),paymentPending:Boolean(pending&&!pending.failed),completed:Boolean(await get('done:'+id))});}catch{return res.status(503).json({error:'Checkout temporarily unavailable'});}
}

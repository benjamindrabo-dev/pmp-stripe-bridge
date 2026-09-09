import {get,error} from '../lib/square-bridge.js';
import {validId,publicQuote,captureStripeContact,prepareStripePayment,captureProgress,stripeStatus} from '../lib/stripe-cad-bridge.js';
import {reviseCart,suggestions} from '../lib/stripe-cad-cart.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
 const origin=String(req.headers.origin||'');
 if(req.method==='POST'&&origin&&!['https://checkout.puremajestypet.com','https://pmp-stripe-bridge.vercel.app'].includes(origin))return res.status(403).json({error:'Origin not allowed'});
 try{
  const id=req.method==='GET'?req.query?.session_id:req.body?.sessionId;
  if(!validId(id))throw error('Invalid checkout',400);
  const cart=await get('sess:'+id);if(!cart||cart.provider!=='stripe')throw error('Checkout expired',410);
  if(req.method==='GET'){
   if(req.query?.view==='status')return res.status(200).json(await stripeStatus(id));
   if(req.query?.view==='options')return res.status(200).json({suggestions:await suggestions(cart)});
   const done=await get('done:'+id);
   return res.status(200).json({...publicQuote(cart),completed:Boolean(done)});
  }
  const body=req.body||{};
  if(body.action==='prepare')return res.status(200).json(await prepareStripePayment(id,body));
  if(body.action==='contact')return res.status(200).json(await captureStripeContact(id,body.email));
  if(body.action==='progress')return res.status(200).json(await captureProgress(id,body.stage));
  return res.status(200).json(await reviseCart(id,body));
 }catch(e){console.error('Stripe checkout',e.message);return res.status(e.status||503).json({error:e.status&&e.status<500?e.message:'Secure checkout temporarily unavailable. Please refresh.'});}
}

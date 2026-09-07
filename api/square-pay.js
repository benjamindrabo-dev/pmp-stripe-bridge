import {paySquare} from '../lib/square-bridge.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).end();
 try{return res.status(200).json(await paySquare(req.body?.sessionId,req.body||{}));}
 catch(e){return res.status([400,409,410,422].includes(e.status)?e.status:503).json({error:e.status===422?'Payment declined. Please check your card or try another card.':e.message||'Payment processing. Please retry.'});}
}

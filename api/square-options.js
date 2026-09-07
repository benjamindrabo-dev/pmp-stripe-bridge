import {get,validId} from '../lib/square-bridge.js';
import {suggestions} from '../lib/square-cart.js';
export default async function handler(req,res){res.setHeader('Cache-Control','no-store');if(req.method!=='GET')return res.status(405).end();try{const id=req.query?.session_id;if(!validId(id))return res.status(400).json({error:'Invalid checkout'});const cart=await get('sess:'+id);if(!cart)return res.status(410).json({error:'Checkout expired'});return res.json({suggestions:await suggestions(cart)});}catch{return res.status(503).json({error:'Suggestions unavailable'});}}

import {walletMerchant,walletProviderClient,WALLET_DOMAINS} from '../lib/godaddy-wallet-registration.js';
let cached=null,until=0;
export default async function handler(req,res){
 res.setHeader('X-Content-Type-Options','nosniff');
 if(!['GET','HEAD'].includes(req.method))return res.status(405).end();
 const host=String(req.headers.host||'').split(':')[0];
 if(process.env.VERCEL_ENV!=='production'||!WALLET_DOMAINS.includes(host))return res.status(404).end();
 try{
  if(!cached||Date.now()>until){const provider=await walletProviderClient(walletMerchant());cached=await provider('domain-association-file');until=Date.now()+3600000;}
  res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Cache-Control','public, max-age=300');
  return req.method==='HEAD'?res.status(200).end():res.status(200).send(cached);
 }catch{res.setHeader('Cache-Control','no-store');return res.status(503).end();}
}

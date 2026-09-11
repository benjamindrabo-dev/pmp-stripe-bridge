import {walletMerchant,walletRegistration,WALLET_DOMAINS} from '../lib/godaddy-wallet-registration.js';
import {loadCart} from '../lib/godaddy-embedded.js';
import {liveEnabled,validSession} from '../lib/godaddy-embedded-core.js';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET')return res.status(405).end();
 const host=String(req.headers.host||'').split(':')[0];
 if(process.env.VERCEL_ENV!=='production'||!WALLET_DOMAINS.includes(host))return res.status(404).end();
 const id=String(req.query.session_id||'');if(!validSession(id))return res.status(400).json({code:'INVALID_SESSION'});
 try{
  const cart=await loadCart(id),enabled=liveEnabled()&&!cart.supersededBy;
  const saved=await walletRegistration(walletMerchant()).catch(()=>null);
  return res.status(200).json({googlePay:enabled,applePay:enabled&&saved?.registeredDomains.includes(host)===true,merchantCountry:'CA',currency:'CAD'});
 }catch{return res.status(410).json({code:'CHECKOUT_UNAVAILABLE'});}
}

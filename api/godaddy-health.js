import {ensureStore} from '../lib/godaddy-embedded.js';
import {liveEnabled} from '../lib/godaddy-embedded-core.js';

export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET')return res.status(405).end();
 if(process.env.VERCEL_ENV!=='production')return res.status(404).end();
 try{
  // Authenticates with the provider, reads the configured store, and verifies
  // existing server-side webhook settings. Never charges, captures or pays out.
  await ensureStore();
  return res.status(200).json({
   provider:'godaddy',
   apiAccessVerified:true,
   webhookConfigurationVerified:true,
   chargeCurrency:'CAD',
   launchEnabled:liveEnabled(),
   newCheckoutRouting:process.env.CHECKOUT_PROVIDER==='godaddy'?'godaddy':'existing',
   providerReviewVerified:false,
   payoutAvailabilityVerified:false,
   monetaryRequestsPerformed:0
  });
 }catch(error){
  return res.status(503).json({provider:'godaddy',apiAccessVerified:false,launchEnabled:false,code:/^[A-Z_]+$/.test(error.code||'')?error.code:'CONFIGURATION_UNAVAILABLE',monetaryRequestsPerformed:0});
 }
}

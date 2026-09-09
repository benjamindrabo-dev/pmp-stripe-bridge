import {get,squareAccountScope,squareWebhookKey,squareApplePayKey,squareVerificationKey} from '../lib/square-bridge.js';
// Read-only. Returns no access tokens, signing keys, bank or customer data.
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET')return res.status(405).end();
  const required=['SQUARE_ACCESS_TOKEN','SQUARE_LOCATION_ID','SQUARE_APPLICATION_ID','SQUARE_ENV'];
  const missing=required.filter(k=>!process.env[k]);
  if(missing.length)return res.status(503).json({ready:false,missing});
  const environment=process.env.SQUARE_ENV;
  if(!['production','sandbox'].includes(environment))return res.status(503).json({ready:false,error:'Invalid SQUARE_ENV'});
  try {
    const base=environment==='production'?'https://connect.squareup.com':'https://connect.squareupsandbox.com';
    const response=await fetch(base+'/v2/locations/'+encodeURIComponent(process.env.SQUARE_LOCATION_ID),{
      headers:{Authorization:'Bearer '+process.env.SQUARE_ACCESS_TOKEN,'Square-Version':'2026-08-19'},signal:AbortSignal.timeout(8000)
    });
    const data=await response.json();
    if(!response.ok||!data.location)return res.status(503).json({ready:false,environment,error:'Square credential or location verification failed',squareStatus:response.status});
    const location=data.location;
    const cardProcessing=location.status==='ACTIVE'&&location.capabilities?.includes('CREDIT_CARD_PROCESSING')===true;
    const [hook,apple,verification]=await Promise.all([get(squareWebhookKey()),get(squareApplePayKey()),get(squareVerificationKey())]);
    const webhookConfigured=Boolean(hook?.signature_key&&hook.enabled);
    const ready=cardProcessing&&location.currency==='CAD'&&webhookConfigured;
    return res.status(ready?200:503).json({
      revision:'square-account-restore-2026-09-09',ready,environment,provider:'square',
      currency:location.currency,cardProcessing,accountScope:squareAccountScope(),
      applicationIdSuffix:process.env.SQUARE_APPLICATION_ID.slice(-6),locationIdSuffix:process.env.SQUARE_LOCATION_ID.slice(-6),
      webhookConfigured,webhookId:hook?.id||null,
      webhookTestStatus:verification?.squareDeliveryStatus??null,
      invalidSignatureRejected:verification?.invalidSignatureRejected===true,
      applePay:apple?.status||'NOT_REGISTERED'
    });
  }catch{return res.status(503).json({ready:false,environment,error:'Square verification unavailable'});}
}

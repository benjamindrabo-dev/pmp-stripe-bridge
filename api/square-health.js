import {get,BRIDGE_ORIGIN} from '../lib/square-bridge.js';
// Read-only readiness check. Never returns credentials or merchant/customer details.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).end();
  const required = ["SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID", "SQUARE_APPLICATION_ID", "SQUARE_ENV"];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length) return res.status(503).json({ready:false, missing});
  const environment = process.env.SQUARE_ENV;
  if (!["sandbox","production"].includes(environment)) return res.status(503).json({ready:false, error:"Invalid SQUARE_ENV"});
  const base = environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  try {
    const response = await fetch(base + "/v2/locations/" + encodeURIComponent(process.env.SQUARE_LOCATION_ID), {
      headers: {Authorization:"Bearer " + process.env.SQUARE_ACCESS_TOKEN, "Square-Version":"2026-08-19"},
      signal: AbortSignal.timeout(8000)
    });
    const data = await response.json();
    if (!response.ok || !data.location) return res.status(503).json({ready:false, environment, error:"Square credential or location verification failed", squareStatus:response.status});
    const location = data.location;
    const canProcessCards = location.status === "ACTIVE" && (location.capabilities || []).includes("CREDIT_CARD_PROCESSING");
    return res.status(canProcessCards ? 200 : 503).json({
      ready:canProcessCards, environment, currency:location.currency,
      cardProcessing:canProcessCards,
      webhookConfigured:Boolean(process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || (await get('square:webhook:'+environment))?.signature_key),
      applePay:(await get('square:apple-pay:'+environment+':'+new URL(BRIDGE_ORIGIN).hostname))?.status||'NOT_REGISTERED',
      provider:"square"
    });
  } catch {
    return res.status(503).json({ready:false, environment, error:"Square verification unavailable"});
  }
}

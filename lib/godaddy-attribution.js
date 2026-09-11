// The storefront already resolves last-paid (90 days), first-free and first-entry.
// Preserve that same Stripe-era contract across the GoDaddy handoff. This module
// does not collect new data, infer missing origins, renew timestamps or send events.
const MODEL = 'last_paid_else_first_free_v1';
const CLICK_IDS = ['gclid','gbraid','wbraid','dclid','fbclid','ttclid','msclkid','sccid'];

function containsEmail(value) {
  let text = String(value);
  for (let i = 0; i < 3; i++) {
    if (/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i.test(text)) return true;
    try { const next = decodeURIComponent(text); if (next === text) break; text = next; } catch { break; }
  }
  return false;
}
function text(value, max) {
  if (typeof value !== 'string' || value.length > 8000 || containsEmail(value)) return null;
  const clean = value.trim().replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ');
  return clean ? clean.slice(0,max) : null;
}
function opaque(value, max=255, min=1) {
  if (typeof value !== 'string' || value.trim().length > max) return null;
  const clean = text(value,max);
  return clean && clean.length >= min && /^[A-Za-z0-9._~-]+$/.test(clean) ? clean : null;
}
function page(value) {
  if (typeof value !== 'string' || value.length > 8000) return null;
  try {
    const u = new URL(value);
    if (!['https:','http:'].includes(u.protocol)) return null;
    u.username=''; u.password=''; u.hash=''; u.search='';
    if (containsEmail(u.pathname)) u.pathname='/';
    return (u.origin+u.pathname).slice(0,500);
  } catch { return null; }
}
function at(value) {
  const clean=text(value,40), ms=clean ? Date.parse(clean) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function facebook(value) {
  const clean=text(value,255);
  return clean && /^fb\.1\.\d{10,16}\.[A-Za-z0-9._~-]{6,200}$/.test(clean) ? clean : null;
}

export function normalizeGoDaddyAttribution(input) {
  const data=input && typeof input==='object' && !Array.isArray(input) ? input : {};
  const out={tracking_version:'pmp_v4',attribution_model:MODEL,marketing_allowed:data.marketing_allowed===true};
  const put=(key,value)=>{if(value!==null && value!==undefined && value!=='')out[key]=value;};
  put('journey_id',opaque(data.journey_id));
  for (const key of CLICK_IDS) put(key,opaque(data[key],255,6));
  for (const key of ['ga_client_id','ga_session_id','ga_session_number']) put(key,opaque(data[key],64));
  const browser=opaque(data.external_id||data.browser_id,64);
  for (const key of ['external_id','browser_id','person_id']) put(key,browser);
  put('fbp',facebook(data.fbp)); put('fbc',facebook(data.fbc));
  // Raw browser payload uses *_landing_url; persisted Stripe carts use *_landing.
  const landing=page(data.landing_url||data.landing_page);
  put('landing_page',landing); put('landing_url',landing);
  put('referrer',page(data.referrer));
  for (const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term']) {
    put(key,text(data[key],['utm_source','utm_medium'].includes(key)?100:200));
  }
  for (const prefix of ['first_entry','first_touch','last_touch']) {
    put(prefix+'_landing',page(data[prefix+'_landing_url']||data[prefix+'_landing']));
    put(prefix+'_referrer',page(data[prefix+'_referrer']));
    for (const field of ['source','medium','campaign','content','term']) {
      put(prefix+'_'+field,text(data[prefix+'_'+field],['source','medium'].includes(field)?100:200));
    }
    put(prefix+'_at',at(data[prefix+'_at']));
  }
  for (const key of ['bridge_started_at','captured_at']) put(key,at(data[key]));
  const cartUrl=page(data.shopify_cart_url);
  if(cartUrl){const u=new URL(cartUrl);if(u.protocol==='https:'&&['www.puremajestypet.com','puremajestypet.com'].includes(u.hostname))put('shopify_cart_url',cartUrl);}
  return out;
}

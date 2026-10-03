export const COLLAGEN_VARIANT = 43349565112394;
export const PROBIOTIC_VARIANT = 43660092473418;
export const COLLAGEN_PROBIOTIC_OFFER = 'collagen_probiotic_bogo_v1';

export function hasCollagen(items = []) {
  return items.some(it => Number(it.variant_id) === COLLAGEN_VARIANT &&
    Number.isInteger(Number(it.quantity)) && Number(it.quantity) > 0 && Number(it.price_cents) > 0);
}

export function offerEnabled() {
  return process.env.PMP_COLLAGEN_PROBIOTIC_OFFER_ENABLED !== '0';
}

export function offerAccepted(items = []) {
  return items.some(it => it.collagenProbioticOffer === COLLAGEN_PROBIOTIC_OFFER);
}

// Called with server-fetched catalog information, never a browser-supplied price.
export function addOfferPair(items, product, {scale, currency}) {
  if (!offerEnabled() || !hasCollagen(items)) throw Object.assign(new Error('This offer requires collagen in your order.'), {status:400});
  if (offerAccepted(items)) throw Object.assign(new Error('This offer is already in your order.'), {status:400});
  const gid = 'gid://shopify/ProductVariant/' + PROBIOTIC_VARIANT;
  const p = product?.contextualPricing?.price;
  if (product?.id !== gid || product.product?.status !== 'ACTIVE' ||
      !(product.inventoryPolicy === 'CONTINUE' || product.inventoryQuantity >= 2) ||
      p?.currencyCode !== currency || !(Number(p.amount) > 0)) {
    throw Object.assign(new Error('This probiotic offer is unavailable in this destination.'), {status:400});
  }
  const digits = new Intl.NumberFormat('en', {style:'currency',currency}).resolvedOptions().maximumFractionDigits;
  const quantum = scale / 10 ** digits;
  const price = Math.round(Number(p.amount) * scale / quantum) * quantum;
  if (!Number.isSafeInteger(price) || price <= 0) throw new Error('Invalid offer price');
  const base = {variant_id:PROBIOTIC_VARIANT, title:product.product.title, quantity:1,
    image:product.product.featuredImage?.url || null, addon:true,
    collagenProbioticOffer:COLLAGEN_PROBIOTIC_OFFER};
  return [...items, {...base, price_cents:price}, {...base, price_cents:0, offerGift:true}];
}

export function retainEligibleOffer(items) {
  // Removing collagen removes both promotional lines, including the paid add-on.
  return hasCollagen(items) ? items : items.filter(it => it.collagenProbioticOffer !== COLLAGEN_PROBIOTIC_OFFER);
}

export function assertOfferPair(items) {
  const pair = items.filter(it => it.collagenProbioticOffer === COLLAGEN_PROBIOTIC_OFFER);
  if (!pair.length) return;
  if (!hasCollagen(items) || pair.length !== 2 || pair.some(it =>
      Number(it.variant_id) !== PROBIOTIC_VARIANT || it.quantity !== 1 || !it.addon) ||
      pair.filter(it => !it.offerGift && it.price_cents > 0).length !== 1 ||
      pair.filter(it => it.offerGift === true && it.price_cents === 0).length !== 1) {
    throw Object.assign(new Error('Invalid collagen probiotic offer'), {status:400});
  }
}

// Anonymous, deduplicated operational counters; no email or payment data.
export async function recordOfferEvent(redis, cart, stage) {
  if (!['shown','declined','accepted','removed','purchased','completed'].includes(stage)) return;
  const root = cart.offerCheckoutId || cart.id;
  if (!/^st_[a-f0-9]{32}$/.test(root || '')) return;
  const day = new Date(cart.offerStartedAt || cart.createdAt || Date.now()).toISOString().slice(0,10);
  const country = /^[A-Z]{2}$/.test(cart.country || '') ? cart.country : 'XX';
  const script = "if redis.call('SET',KEYS[1],'1','NX','EX',7776000) then redis.call('HINCRBY',KEYS[2],ARGV[1],1);redis.call('EXPIRE',KEYS[2],7776000);return 1 else return 0 end";
  try {
    await redis(['EVAL',script,'2','offer:collagen-probiotic:'+root+':'+stage,
      'offer:collagen-probiotic:stats:'+day+':'+country,stage]);
  } catch { console.warn('Collagen probiotic offer counter unavailable'); }
}

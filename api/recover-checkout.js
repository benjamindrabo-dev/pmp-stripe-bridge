// GET /api/recover-checkout?session_id=cs_...
//
// Omnisend recovery links point here instead of at a browser-local Shopify
// cart. The Stripe session id is used only as an opaque Redis lookup key; the
// endpoint never returns the stored checkout data. A successful lookup becomes
// a Shopify cart permalink, which rebuilds the cart on any device.

const MAX_UNIQUE_VARIANTS = 50;
const MAX_QUANTITY_PER_VARIANT = 999;
const MAX_REDIS_RESPONSE_BYTES = 100_000;

export function safeSessionId(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return /^cs_[A-Za-z0-9_]{8,200}$/.test(clean) ? clean : null;
}

// STORE_ORIGIN is an operator-controlled trust boundary and ultimately becomes
// a Location header. Accept an HTTPS origin only: no credentials, path, query,
// fragment, non-standard port, or control characters.
export function safeStoreOrigin(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  if (!value || /[\u0000-\u001F\u007F]/.test(value)) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.port) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (!url.hostname || !url.hostname.includes(".")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function positiveInteger(value, max) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

export function groupedCartItems(cart) {
  if (!cart || !Array.isArray(cart.items) || cart.items.length === 0 || cart.items.length > 200) {
    return null;
  }

  const grouped = new Map();
  for (const item of cart.items) {
    if (!item || typeof item !== "object") return null;

    const variantId = typeof item.variant_id === "number"
      ? (Number.isSafeInteger(item.variant_id) && item.variant_id > 0 ? String(item.variant_id) : null)
      : (typeof item.variant_id === "string" && /^[1-9][0-9]{0,19}$/.test(item.variant_id)
        ? item.variant_id
        : null);
    const quantity = positiveInteger(item.quantity, MAX_QUANTITY_PER_VARIANT);
    if (!variantId || !quantity) return null;

    const total = (grouped.get(variantId) || 0) + quantity;
    if (total > MAX_QUANTITY_PER_VARIANT) return null;
    grouped.set(variantId, total);
    if (grouped.size > MAX_UNIQUE_VARIANTS) return null;
  }

  return [...grouped].map(([variantId, quantity]) => ({ variantId, quantity }));
}

export function buildRecoveryUrl(storeOrigin, sessionId, cart) {
  const origin = safeStoreOrigin(storeOrigin);
  const id = safeSessionId(sessionId);
  const items = groupedCartItems(cart);
  if (!origin || !id || !items) return null;

  const lines = items.map(({ variantId, quantity }) => `${variantId}:${quantity}`).join(",");
  const url = new URL(`/cart/${lines}`, origin);
  url.searchParams.set("attributes[pmp_recovery_session]", id);
  url.searchParams.set("utm_source", "omnisend");
  url.searchParams.set("utm_medium", "email");
  url.searchParams.set("utm_campaign", "checkout_recovery");
  url.searchParams.set("utm_content", "stripe_bridge");
  return url.toString();
}

function safeUpstashBase(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function decodeRedisResult(result) {
  let value = result;
  // Upstash normally returns the SET body as a JSON string. Supporting an
  // already-decoded object also keeps this compatible with JSON-aware clients.
  for (let attempt = 0; attempt < 2 && typeof value === "string"; attempt += 1) {
    if (value.length > MAX_REDIS_RESPONSE_BYTES) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function readSessionCart(sessionId) {
  const base = safeUpstashBase(process.env.UPSTASH_REDIS_REST_URL);
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("recovery_storage_not_configured");

  const response = await fetch(`${base}/get/${encodeURIComponent(`sess:${sessionId}`)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error("recovery_storage_failed");

  const body = await response.text();
  if (body.length > MAX_REDIS_RESPONSE_BYTES) throw new Error("recovery_storage_response_too_large");
  const envelope = JSON.parse(body);
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, "result")) return null;
  return decodeRedisResult(envelope.result);
}

function redirect(res, location) {
  res.setHeader("Location", location);
  return res.status(302).end();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }

  const origin = safeStoreOrigin(process.env.STORE_ORIGIN);
  // Never construct a Location header from a malformed environment value.
  if (!origin) return res.status(500).end();

  const fallback = new URL("/cart", origin).toString();
  const sessionId = safeSessionId(req.query && req.query.session_id);
  if (!sessionId) return redirect(res, fallback);

  try {
    const cart = await readSessionCart(sessionId);
    const recoveryUrl = buildRecoveryUrl(origin, sessionId, cart);
    return redirect(res, recoveryUrl || fallback);
  } catch (error) {
    // The email recipient gets a safe cart page, never Redis/configuration
    // details. Keep one generic server-side signal for operational diagnosis.
    console.error("recover-checkout failed", error instanceof Error ? error.message : "unknown");
    return redirect(res, fallback);
  }
}

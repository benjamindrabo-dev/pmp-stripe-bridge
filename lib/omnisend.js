import crypto from "node:crypto";

export const OMNISEND_EVENTS_URL = "https://api.omnisend.com/api/events";
export const OMNISEND_API_VERSION = "2026-03-15";

const EVENT_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // RFC 4122 URL namespace
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_LOCAL_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_LOCAL_EVENTS = 1000;
const localEvents = new Map();

function cleanText(value, max = 500) {
  if (value == null) return null;
  const clean = String(value).trim().replace(/[\u0000-\u001F\u007F]/g, "");
  return clean ? clean.slice(0, max) : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

/**
 * Returns a lower-cased, syntactically valid mailbox or null.
 * This deliberately validates syntax, not deliverability or marketing consent.
 */
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || /[\u0000-\u0020\u007F-\uFFFF]/.test(email)) return null;

  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return null;
  if (domain.length > 253 || !domain.includes(".")) return null;

  const labels = domain.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    return null;
  }
  if (labels.at(-1).length < 2 || !/^[a-z][a-z0-9-]*$/i.test(labels.at(-1))) return null;
  return email;
}

export function isValidEmail(value) {
  return normalizeEmail(value) !== null;
}

function uuidBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

/** Deterministic UUID v5 accepted by Omnisend's eventID field. */
export function deterministicEventId(eventName, stableId) {
  const name = cleanText(eventName, 100);
  const id = cleanText(stableId, 500);
  if (!name || !id) throw new TypeError("eventName and stableId are required");
  const digest = crypto
    .createHash("sha1")
    .update(Buffer.concat([uuidBytes(EVENT_NAMESPACE), Buffer.from(`pmp-omnisend/${name}/${id}`, "utf8")]))
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validEventId(value) {
  const id = cleanText(value, 36);
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[4-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id.toLowerCase()
    : null;
}

function isoTime(value) {
  if (value == null || value === "") return null;
  let date;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value < 1e12 ? value * 1000 : value);
  } else if (typeof value === "string" && /^\d{10,13}$/.test(value.trim())) {
    const number = Number(value);
    date = new Date(number < 1e12 ? number * 1000 : number);
  } else {
    date = new Date(value);
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function currencyCode(value) {
  const currency = cleanText(value, 3)?.toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function cleanUrl(value) {
  const text = cleanText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

function finiteMoney(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object") {
    return finiteMoney(firstValue(value.amount, value.shop_money?.amount, value.presentment_money?.amount));
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

function centsMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) / 100 : null;
}

function positiveQuantity(value) {
  const quantity = Number(value);
  return Number.isFinite(quantity) && quantity > 0 ? Math.max(1, Math.round(quantity)) : 1;
}

function deepClean(value) {
  if (Array.isArray(value)) return value.map(deepClean).filter((item) => item !== undefined);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    const clean = deepClean(item);
    if (Array.isArray(clean) && clean.length === 0) continue;
    if (clean && typeof clean === "object" && !Array.isArray(clean) && Object.keys(clean).length === 0) continue;
    result[key] = clean;
  }
  return result;
}

function itemPrice(item) {
  const cents = firstValue(item.price_cents, item.unit_amount, item.price?.unit_amount, item.amount_cents);
  if (cents !== undefined) return centsMoney(cents);
  return finiteMoney(firstValue(item.productPrice, item.price?.amount, item.price, item.unit_price, item.amount));
}

function imageUrl(item) {
  const image = firstValue(
    item.productImageURL,
    item.productVariantImageURL,
    item.image_url,
    item.image,
    item.image?.src,
    item.image?.url,
  );
  return cleanUrl(typeof image === "object" ? firstValue(image.src, image.url) : image);
}

function productUrl(item) {
  return cleanUrl(firstValue(item.productURL, item.product_url, item.url, item.handle_url));
}

function itemIdentity(item) {
  return cleanText(firstValue(
    item.productVariantID,
    item.variant_id,
    item.variantId,
    item.productID,
    item.product_id,
    item.productId,
    item.price?.product,
    item.id,
    item.sku,
  ), 255);
}

function buildLineItem(item) {
  if (!item || typeof item !== "object") return null;
  const variantID = cleanText(firstValue(item.productVariantID, item.variant_id, item.variantId), 255);
  const productID = cleanText(firstValue(item.productID, item.product_id, item.productId, variantID, item.price?.product, item.id, item.sku), 255);
  if (!productID) return null;

  const image = imageUrl(item);
  return deepClean({
    productID,
    productImageURL: image,
    productPrice: itemPrice(item),
    productQuantity: positiveQuantity(firstValue(item.productQuantity, item.quantity)),
    productSKU: cleanText(firstValue(item.productSKU, item.sku), 255),
    productTitle: cleanText(firstValue(item.productTitle, item.title, item.name), 500),
    productURL: productUrl(item),
    productVariantID: variantID,
    productVariantImageURL: image,
    productVariantTitle: cleanText(firstValue(item.productVariantTitle, item.variant_title), 500),
    productVendor: cleanText(firstValue(item.productVendor, item.vendor), 255),
  });
}

function chooseItems(input) {
  const orderItems = Array.isArray(input.order?.line_items) ? input.order.line_items : null;
  const cartItems = Array.isArray(input.cart?.items) ? input.cart.items : null;
  const sessionItems = Array.isArray(input.session?.line_items?.data) ? input.session.line_items.data : null;
  const explicitItems = Array.isArray(input.items) ? input.items : null;
  const primary = explicitItems || orderItems || cartItems || sessionItems || [];

  // Shopify order lines contain the final paid price, while the saved cart often
  // has the image and product URL. Merge those non-financial fields by variant.
  if (primary === orderItems && cartItems) {
    const byId = new Map(cartItems.map((item) => [itemIdentity(item), item]).filter(([id]) => id));
    return orderItems.map((item) => {
      const merged = { ...(byId.get(itemIdentity(item)) || {}), ...item };
      // An order's dollar-denominated price is authoritative. Do not let the
      // cart's earlier price_cents win merely because both representations were
      // merged to recover an image/URL.
      if (firstValue(item.productPrice, item.price?.amount, item.price, item.unit_price) !== undefined) {
        delete merged.price_cents;
        delete merged.unit_amount;
        delete merged.amount_cents;
      }
      return merged;
    });
  }
  return primary;
}

function eventLineItems(input) {
  const items = chooseItems(input).map(buildLineItem).filter(Boolean);
  if (!items.length) throw new TypeError("At least one valid line item is required");
  return items;
}

function lineItemsValue(items) {
  return Math.round(items.reduce(
    (total, item) => total + (Number(item.productPrice) || 0) * (Number(item.productQuantity) || 1),
    0,
  ) * 100) / 100;
}

function contactEmail(input) {
  return normalizeEmail(firstValue(
    input.email,
    input.contact?.email,
    input.order?.email,
    input.order?.contact_email,
    input.session?.customer_details?.email,
    input.session?.customer_email,
    input.cart?.email,
  ));
}

function requireEmail(input) {
  const email = contactEmail(input);
  if (!email) throw new TypeError("A valid customer email is required");
  return email;
}

function requireCurrency(input) {
  const currency = currencyCode(firstValue(input.currency, input.order?.currency, input.session?.currency, input.cart?.currency));
  if (!currency) throw new TypeError("A valid ISO 4217 currency is required");
  return currency;
}

function resolveEventId(input, eventName, stableId) {
  const explicit = validEventId(input.eventID);
  return explicit || deterministicEventId(eventName, firstValue(input.idempotencyKey, stableId));
}

export function buildStartedCheckoutEvent(input = {}) {
  const session = input.session || {};
  const cart = input.cart || {};
  const email = requireEmail(input);
  const currency = requireCurrency(input);
  const lineItems = eventLineItems(input);
  const cartID = cleanText(firstValue(input.cartID, cart.cartID, cart.cart_id, cart.token, cart.id, session.id), 255);
  if (!cartID) throw new TypeError("A stable cart or Checkout Session ID is required");

  const eventTime = isoTime(firstValue(input.eventTime, session.created, cart.created_at));
  const explicitValue = finiteMoney(input.value);
  const value = explicitValue ?? centsMoney(firstValue(session.amount_total, cart.total_price)) ?? lineItemsValue(lineItems);
  const abandonedCheckoutURL = cleanUrl(firstValue(
    input.abandonedCheckoutURL,
    cart.abandonedCheckoutURL,
    cart.abandoned_checkout_url,
    cart.checkout_url,
    session.url,
    cart.landing_url,
  ));

  return deepClean({
    eventName: "started checkout",
    origin: "api",
    eventVersion: "",
    eventID: resolveEventId(input, "started checkout", firstValue(session.id, cartID)),
    eventTime,
    contact: { email },
    properties: {
      abandonedCheckoutURL,
      cartID,
      currency,
      lineItems,
      value,
    },
  });
}

function splitName(value) {
  const name = cleanText(value, 255);
  if (!name) return {};
  const parts = name.split(/\s+/);
  return {
    firstName: parts.shift(),
    lastName: parts.length ? parts.join(" ") : undefined,
  };
}

function omnisendAddress(address, fallbackName, fallbackPhone) {
  if (!address || typeof address !== "object") return null;
  const name = splitName(firstValue(address.name, fallbackName));
  return deepClean({
    address1: cleanText(firstValue(address.address1, address.line1), 500),
    address2: cleanText(firstValue(address.address2, address.line2), 500),
    city: cleanText(address.city, 255),
    company: cleanText(address.company, 255),
    country: cleanText(firstValue(address.country, address.country_code), 255),
    firstName: cleanText(firstValue(address.first_name, address.firstName, name.firstName), 255),
    lastName: cleanText(firstValue(address.last_name, address.lastName, name.lastName), 255),
    phone: cleanText(firstValue(address.phone, fallbackPhone), 50),
    state: cleanText(firstValue(address.province, address.state), 255),
    stateCode: cleanText(firstValue(address.province_code, address.state_code), 50),
    zip: cleanText(firstValue(address.zip, address.postal_code), 50),
  });
}

function paymentStatus(value) {
  const status = cleanText(value, 50)?.toLowerCase().replace(/[\s-]+/g, "_");
  return ({
    paid: "paid",
    complete: "paid",
    partially_paid: "partiallyPaid",
    partially_refunded: "partiallyRefunded",
    refunded: "refunded",
    voided: "voided",
    pending: "awaitingPayment",
    unpaid: "awaitingPayment",
    authorized: "awaitingPayment",
  })[status] || "paid";
}

function fulfillmentStatus(value) {
  const status = cleanText(value, 50)?.toLowerCase().replace(/[\s-]+/g, "_");
  return ({ fulfilled: "fulfilled", delivered: "delivered", restocked: "restocked", partial: "inProgress", in_progress: "inProgress" })[status] || "unfulfilled";
}

function orderTags(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map((tag) => cleanText(tag, 255)).filter(Boolean);
}

function orderDiscounts(order) {
  const discounts = Array.isArray(order?.discount_codes) ? order.discount_codes : [];
  return discounts.map((discount) => deepClean({
    amount: finiteMoney(discount.amount),
    code: cleanText(discount.code, 255),
    type: cleanText(discount.type, 100),
  })).filter((discount) => discount.code || discount.amount !== undefined);
}

function numericOrderNumber(value) {
  if (value == null) return null;
  const number = Number(String(value).replace(/^#/, ""));
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function buildPlacedOrderEvent(input = {}) {
  const order = input.order || {};
  const session = input.session || {};
  const email = requireEmail(input);
  const currency = requireCurrency(input);
  const lineItems = eventLineItems(input);
  const orderID = cleanText(firstValue(input.orderID, order.id, order.admin_graphql_api_id, order.order_number, session.id), 255);
  if (!orderID) throw new TypeError("A stable order or Checkout Session ID is required");

  const createdAt = isoTime(firstValue(input.createdAt, order.created_at, input.eventTime, session.created)) || new Date().toISOString();
  const eventTime = isoTime(firstValue(input.eventTime, order.created_at, session.created, createdAt));
  const totalPrice = finiteMoney(firstValue(input.totalPrice, order.current_total_price, order.total_price))
    ?? centsMoney(session.amount_total)
    ?? lineItemsValue(lineItems);
  const shippingDetails = firstValue(session.shipping_details, session.collected_information?.shipping_details) || {};
  const customer = session.customer_details || {};

  return deepClean({
    eventName: "placed order",
    origin: "api",
    eventVersion: "v2",
    eventID: resolveEventId(input, "placed order", firstValue(session.id, orderID)),
    eventTime,
    contact: { email },
    properties: {
      billingAddress: omnisendAddress(order.billing_address || customer.address, customer.name, customer.phone),
      createdAt,
      currency,
      discounts: orderDiscounts(order),
      fulfillmentStatus: fulfillmentStatus(firstValue(input.fulfillmentStatus, order.fulfillment_status)),
      lineItems,
      note: cleanText(firstValue(input.note, order.note), 1000),
      orderID,
      orderNumber: numericOrderNumber(firstValue(input.orderNumber, order.order_number)),
      orderStatusURL: cleanUrl(firstValue(input.orderStatusURL, order.order_status_url)),
      paymentMethod: cleanText(firstValue(input.paymentMethod, order.payment_gateway_names?.[0], session.payment_method_types?.[0], "stripe"), 100),
      paymentStatus: paymentStatus(firstValue(input.paymentStatus, order.financial_status, session.payment_status)),
      shippingAddress: omnisendAddress(order.shipping_address || shippingDetails.address, shippingDetails.name, customer.phone),
      shippingMethod: cleanText(firstValue(input.shippingMethod, order.shipping_lines?.[0]?.title), 255),
      shippingPrice: finiteMoney(order.total_shipping_price_set) ?? centsMoney(firstValue(session.shipping_cost?.amount_total, session.total_details?.amount_shipping)),
      subTotalPrice: finiteMoney(firstValue(order.current_subtotal_price, order.subtotal_price)) ?? centsMoney(session.amount_subtotal),
      subTotalTaxIncluded: typeof order.taxes_included === "boolean" ? order.taxes_included : undefined,
      tags: orderTags(firstValue(input.tags, order.tags)),
      totalDiscount: finiteMoney(firstValue(order.current_total_discounts, order.total_discounts)) ?? centsMoney(session.total_details?.amount_discount),
      totalPrice,
      totalTax: finiteMoney(order.total_tax) ?? centsMoney(session.total_details?.amount_tax),
    },
  });
}

function pruneLocalEvents(now = Date.now()) {
  for (const [id, state] of localEvents) {
    if (state.expiresAt <= now) localEvents.delete(id);
  }
  while (localEvents.size >= MAX_LOCAL_EVENTS) localEvents.delete(localEvents.keys().next().value);
}

/** Exposed for deterministic tests and operational hot-reload cleanup. */
export function clearOmnisendLocalIdempotency() {
  localEvents.clear();
}

async function responseBody(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { return text.slice(0, 500); }
  } catch {
    return null;
  }
}

function logFailure(logger, eventName, result) {
  if (!logger || typeof logger.error !== "function") return;
  logger.error(`Omnisend ${eventName || "event"} not sent: ${result.reason || `HTTP ${result.status || "unknown"}`}`);
}

/**
 * Sends one already-built event. It never throws and is bounded by a timeout.
 * A deterministic eventID plus the warm-instance cache prevents local retries
 * and concurrent webhook deliveries from posting the same event twice. Omnisend
 * does not promise real-time automation dedupe, so durable callers should still
 * use their Redis/DB completion marker across serverless instances.
 */
export async function sendOmnisendEvent(event, options = {}) {
  const eventID = validEventId(event?.eventID);
  const eventName = cleanText(event?.eventName, 100);
  if (!event || typeof event !== "object" || !eventID || !eventName) {
    return { ok: false, skipped: true, reason: "invalid_event", eventID: eventID || null };
  }

  const apiKeyValue = options.apiKey !== undefined ? options.apiKey : process.env.OMNISEND_API_KEY;
  const apiKey = cleanText(apiKeyValue, 1000);
  if (!apiKey) return { ok: false, skipped: true, reason: "not_configured", eventID };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, skipped: true, reason: "fetch_unavailable", eventID };

  const now = Date.now();
  pruneLocalEvents(now);
  const existing = localEvents.get(eventID);
  if (existing?.status === "sent") return { ...existing.result, deduplicated: true };
  if (existing?.status === "pending") {
    const result = await existing.promise;
    return { ...result, deduplicated: true };
  }

  const timeoutMs = Math.min(10000, Math.max(250, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const ttlMs = Math.max(1000, Number(options.localDedupeTtlMs) || DEFAULT_LOCAL_DEDUPE_TTL_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const promise = (async () => {
    try {
      const response = await fetchImpl(OMNISEND_EVENTS_URL, {
        method: "POST",
        headers: {
          Authorization: `Omnisend-API-Key ${apiKey}`,
          "Content-Type": "application/json",
          "Omnisend-Version": OMNISEND_API_VERSION,
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      const body = await responseBody(response);
      const result = {
        ok: Boolean(response.ok),
        skipped: false,
        status: Number(response.status) || null,
        eventID,
        body,
        reason: response.ok ? undefined : "api_rejected",
      };
      if (!result.ok) logFailure(options.logger ?? console, eventName, result);
      return result;
    } catch (error) {
      const reason = error?.name === "AbortError" ? "timeout" : "network_error";
      const result = { ok: false, skipped: false, status: null, eventID, reason };
      logFailure(options.logger ?? console, eventName, result);
      return result;
    } finally {
      clearTimeout(timer);
    }
  })();

  localEvents.set(eventID, { status: "pending", expiresAt: now + ttlMs, promise });
  const result = await promise;
  if (result.ok) localEvents.set(eventID, { status: "sent", expiresAt: Date.now() + ttlMs, result });
  else localEvents.delete(eventID); // allow a later retry after timeout/API failure
  return result;
}

async function safelyBuildAndSend(builder, input, options) {
  let event;
  try {
    event = builder(input);
  } catch (error) {
    const result = { ok: false, skipped: true, reason: "invalid_input", error: cleanText(error?.message, 300) || "Invalid input" };
    logFailure(options?.logger ?? console, builder === buildPlacedOrderEvent ? "placed order" : "started checkout", result);
    return result;
  }
  return sendOmnisendEvent(event, options);
}

/** Safe bridge helper: never makes checkout creation fail. */
export function trySendStartedCheckout(input, options = {}) {
  return safelyBuildAndSend(buildStartedCheckoutEvent, input, options);
}

/** Safe webhook helper: never makes Shopify order creation fail. */
export function trySendPlacedOrder(input, options = {}) {
  return safelyBuildAndSend(buildPlacedOrderEvent, input, options);
}

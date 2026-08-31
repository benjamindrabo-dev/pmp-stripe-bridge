(function installPmpCheckoutEvents(root) {
  "use strict";

  var memorySeen = Object.create(null);
  var STORAGE_PREFIX = "pmp:checkout-event:";

  function cleanText(value, fallback, maxLength) {
    var clean = String(value == null ? "" : value).trim();
    if (!clean) clean = fallback || "";
    return clean.slice(0, maxLength || 100);
  }

  function finiteMoney(value) {
    var number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? Number(number.toFixed(2))
      : null;
  }

  function normalizedItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map(function normalizeItem(item) {
      var source = item || {};
      var price = finiteMoney(source.price);
      var quantity = Number(source.quantity);
      return {
        item_id: cleanText(source.item_id, "unknown", 100),
        item_name: cleanText(source.item_name, "Item", 250),
        price: price == null ? 0 : price,
        quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1,
      };
    }).filter(function validItem(item) {
      return item.item_id !== "unknown" || item.item_name !== "Item";
    });
  }

  function storageHas(key) {
    if (memorySeen[key]) return true;
    try {
      return root.sessionStorage && root.sessionStorage.getItem(STORAGE_PREFIX + key) === "1";
    } catch (_error) {
      return false;
    }
  }

  function storageMark(key) {
    memorySeen[key] = true;
    try {
      if (root.sessionStorage) root.sessionStorage.setItem(STORAGE_PREFIX + key, "1");
    } catch (_error) {
      // Browsers can disable storage. The in-memory guard still prevents
      // duplicate calls during this page lifecycle.
    }
  }

  function googleEvent(name, params) {
    root.dataLayer = root.dataLayer || [];
    if (typeof root.gtag !== "function") {
      root.gtag = function gtagQueue() {
        root.dataLayer.push(arguments);
      };
    }
    root.gtag("event", name, params);
  }

  function clarityCall() {
    if (typeof root.clarity !== "function") return;
    root.clarity.apply(root, arguments);
  }

  function checkoutPayload(response) {
    var source = response && response.analytics && response.analytics.beginCheckout;
    if (!source) source = response && response.beginCheckout;
    if (!source) source = response;
    source = source || {};

    var eventId = cleanText(source.eventId, "", 100);
    var currency = cleanText(source.currency, "", 3).toUpperCase();
    var value = finiteMoney(source.value);
    var items = normalizedItems(source.items);

    if (!eventId || !/^[A-Za-z0-9:_-]+$/.test(eventId)) return null;
    if (!/^[A-Z]{3}$/.test(currency) || value == null || items.length === 0) return null;

    return {
      event_id: eventId,
      currency: currency,
      value: value,
      items: items,
    };
  }

  function beginCheckout(response) {
    var payload = checkoutPayload(response);
    var sessionId = cleanText(response && response.sessionId, "", 100);
    if (!payload || !sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return false;
    var eventKey = "begin_checkout:event:" + payload.event_id;
    var sessionKey = "begin_checkout:session:" + sessionId;
    if (storageHas(eventKey) || storageHas(sessionKey)) return false;

    // Mark before dispatch so two synchronous mount callbacks cannot both
    // enqueue the event. These are the same keys used by the live ScriptTag.
    storageMark(eventKey);
    storageMark(sessionKey);
    googleEvent("begin_checkout", payload);
    clarityCall("set", "pmp_checkout_event_id", payload.event_id);
    clarityCall("event", "begin_checkout");
    return true;
  }

  function checkoutError(details) {
    var source = details || {};
    var stage = cleanText(source.stage, "unknown", 40).replace(/[^A-Za-z0-9_-]/g, "_");
    var code = cleanText(source.code, "unknown", 80).replace(/[^A-Za-z0-9_-]/g, "_");
    clarityCall("set", "pmp_checkout_error_stage", stage);
    clarityCall("set", "pmp_checkout_error_code", code);
    clarityCall("event", "checkout_error");
  }

  root.PMPCheckoutEvents = Object.freeze({
    beginCheckout: beginCheckout,
    checkoutError: checkoutError,
  });
})(typeof window !== "undefined" ? window : globalThis);

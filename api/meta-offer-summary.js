// GET /api/meta-offer-summary.js
// Storefront helper injected by Shopify ScriptTag.
// It sends the selected market country to the checkout bridge and keeps the
// existing Meta retargeting discount summary in sync.

const JS = String.raw`(function(){
  'use strict';

  /* ---------- Temporary US display-USD / charge-CAD bridge ---------- */
  if (!window.__pmpCheckoutCountryBridge) {
    window.__pmpCheckoutCountryBridge = true;
    var nativeFetch = window.fetch.bind(window);
    var checkoutEventsSeen = Object.create(null);
    var checkoutEventStoragePrefix = 'pmp:checkout-event:';
    var ga4Destination = 'G-KKS5T7SPHR';
    var gtagGuardAttempts = 0;
    var maxGtagGuardAttempts = 120;

    function cleanEventValue(value, fallback, maxLength){
      var clean = String(value == null ? '' : value).trim();
      if (!clean) clean = fallback || '';
      return clean.slice(0, maxLength || 100);
    }

    function checkoutEventSeen(key){
      if (!key) return false;
      if (checkoutEventsSeen[key]) return true;
      try {
        return sessionStorage.getItem(checkoutEventStoragePrefix + key) === '1';
      } catch (_) { return false; }
    }

    function markCheckoutEvent(key){
      if (!key) return;
      checkoutEventsSeen[key] = true;
      try { sessionStorage.setItem(checkoutEventStoragePrefix + key, '1'); }
      catch (_) {}
    }

    function clarityCall(){
      if (typeof window.clarity !== 'function') {
        window.clarity = function(){
          (window.clarity.q = window.clarity.q || []).push(arguments);
        };
      }
      window.clarity.apply(window, arguments);
    }

    function isPrematureBeginCheckout(args){
      if (!args || args[0] !== 'event' || args[1] !== 'begin_checkout') return false;
      var params = args[2] && typeof args[2] === 'object' ? args[2] : {};
      var hasEventId = Boolean(cleanEventValue(params.event_id, '', 100));
      var hasItems = Array.isArray(params.items) && params.items.length > 0;
      return !hasEventId && !hasItems;
    }

    function installGtagGuard(){
      var current = window.gtag;
      if (typeof current !== 'function') return false;
      if (current.__pmpBeginCheckoutGuard === true) return true;

      function guardedGtag(){
        if (isPrematureBeginCheckout(arguments)) return undefined;
        return current.apply(this, arguments);
      }
      // Preserve queue/config metadata that Google or another integration may
      // have attached to the function. Every non-targeted call is forwarded
      // with its original receiver, arguments and return value.
      try {
        Object.keys(current).forEach(function(key){ guardedGtag[key] = current[key]; });
      } catch (_) {}
      guardedGtag.__pmpBeginCheckoutGuard = true;
      guardedGtag.__pmpOriginalGtag = current;
      window.gtag = guardedGtag;
      return true;
    }

    function retryGtagGuard(){
      gtagGuardAttempts += 1;
      if (installGtagGuard() || gtagGuardAttempts >= maxGtagGuardAttempts) return;
      setTimeout(retryGtagGuard, 250);
    }

    // Google may have loaded before this ScriptTag or may define gtag later.
    // Retry for at most 30 seconds; no permanent timer or property trap remains.
    retryGtagGuard();

    function checkoutError(stage, code){
      var safeStage = cleanEventValue(stage, 'create_checkout', 40).replace(/[^A-Za-z0-9_-]/g, '_');
      var safeCode = cleanEventValue(code, 'unknown', 80).replace(/[^A-Za-z0-9_-]/g, '_');
      clarityCall('set', 'pmp_checkout_error_stage', safeStage);
      clarityCall('set', 'pmp_checkout_error_code', safeCode);
      clarityCall('event', 'checkout_error');
    }

    function normalizedCheckoutAnalytics(data){
      var source = data && data.analytics && data.analytics.beginCheckout;
      if (!source) return null;
      var eventId = cleanEventValue(source.eventId, '', 100);
      var sessionId = cleanEventValue(data.sessionId, '', 100);
      var currency = cleanEventValue(source.currency, '', 3).toUpperCase();
      var value = Number(source.value);
      var sourceItems = Array.isArray(source.items) ? source.items : [];
      var items = sourceItems.map(function(item){
        var price = Number(item && item.price);
        var quantity = Number(item && item.quantity);
        return {
          item_id: cleanEventValue(item && item.item_id, 'unknown', 100),
          item_name: cleanEventValue(item && item.item_name, 'Item', 250),
          price: Number.isFinite(price) && price >= 0 ? Number(price.toFixed(2)) : 0,
          quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : 1
        };
      });

      if (!eventId || !/^[A-Za-z0-9:_-]+$/.test(eventId)) return null;
      if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
      if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(value) || value < 0 || !items.length) return null;
      return {
        eventId: eventId,
        sessionId: sessionId,
        currency: currency,
        value: Number(value.toFixed(2)),
        items: items
      };
    }

    function beginCheckout(data){
      var checkout = normalizedCheckoutAnalytics(data);
      if (!checkout) return null;
      var eventKey = 'begin_checkout:event:' + checkout.eventId;
      var sessionKey = 'begin_checkout:session:' + checkout.sessionId;
      if (checkoutEventSeen(eventKey) || checkoutEventSeen(sessionKey)) return false;

      // Mark both server event ID and Stripe Session ID before dispatch so
      // repeated fetch callbacks and page reloads cannot enqueue duplicates.
      markCheckoutEvent(eventKey);
      markCheckoutEvent(sessionKey);
      window.dataLayer = window.dataLayer || [];
      if (typeof window.gtag !== 'function') {
        window.gtag = function(){ window.dataLayer.push(arguments); };
      }
      installGtagGuard();
      window.gtag('event', 'begin_checkout', {
        send_to: ga4Destination,
        event_id: checkout.eventId,
        currency: checkout.currency,
        value: checkout.value,
        items: checkout.items
      });
      clarityCall('set', 'pmp_checkout_event_id', checkout.eventId);
      clarityCall('event', 'begin_checkout');
      return true;
    }

    function selectedCountry(){
      var selector = document.querySelector('#PmpHeaderCountrySelectorV3');
      var value = selector && String(selector.value || '').trim().toUpperCase();
      return /^[A-Z]{2}$/.test(value) ? value : null;
    }

    function isCheckoutRequest(input, init){
      if (!init || String(init.method || 'GET').toUpperCase() !== 'POST') return false;
      var raw = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        var url = new URL(raw, location.href);
        return url.hostname === 'pmp-stripe-bridge.vercel.app' && url.pathname === '/api/create-checkout';
      } catch (_) { return false; }
    }

    function isCartAddRequest(input, init){
      var method = init && init.method || (input && typeof input === 'object' && input.method) || 'GET';
      if (String(method).toUpperCase() !== 'POST') return false;
      var raw = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        var url = new URL(raw, location.href);
        var storefront = new URL(location.href);
        return url.origin === storefront.origin &&
          (url.pathname === '/cart/add.js' || url.pathname === '/cart/add');
      } catch (_) { return false; }
    }

    window.fetch = function pmpCountryAwareFetch(input, init){
      if (isCartAddRequest(input, init)) {
        return nativeFetch(input, init).then(function(response){
          // Shopify's own pixel already emits GA4 add_to_cart. Clarity receives
          // one event only after Shopify confirms that the mutation succeeded.
          if (response.ok) clarityCall('event', 'add_to_cart');
          return response;
        });
      }
      if (!isCheckoutRequest(input, init)) return nativeFetch(input, init);

      var nextInit = Object.assign({}, init);
      try {
        var body = JSON.parse(String(nextInit.body || '{}'));
        var country = selectedCountry();
        if (country) body.checkout_country = country;
        nextInit.body = JSON.stringify(body);
      } catch (_) {}

      return nativeFetch(input, nextInit).then(function(response){
        if (!response.ok) {
          checkoutError('create_checkout', 'http_' + String(response.status || 0));
          return response;
        }

        // Read only a clone: the caller receives the exact original Response
        // with its body untouched and can continue mounting Stripe normally.
        return Promise.resolve().then(function(){
          return response.clone().json();
        }).then(function(data){
          if (!data || !data.clientSecret || !data.sessionId) {
            checkoutError('create_checkout', 'invalid_success_payload');
          } else {
            var tracked = beginCheckout(data);
            if (tracked === null) checkoutError('checkout_tracking', 'invalid_analytics');
          }
          return response;
        }).catch(function(){
          checkoutError('checkout_tracking', 'invalid_json');
          return response;
        });
      }, function(error){
        checkoutError('create_checkout', 'network_error');
        throw error;
      });
    };
  }

  /* ---------- Meta WELCOME20 summary ---------- */
  if (window.__pmpMetaOfferSummary) return;
  window.__pmpMetaOfferSummary = true;

  var OFFER = {
    source: 'meta',
    medium: 'paid_social',
    campaign: 'liquid_retargeting_product_view',
    code: 'WELCOME20',
    percent: 20
  };

  function norm(v){ return String(v == null ? '' : v).trim().toLowerCase(); }

  function paramsFrom(value){
    try { return new URL(value, location.href).searchParams; }
    catch (_) { return new URLSearchParams(''); }
  }

  function campaignParams(){
    var current = paramsFrom(location.href);
    if (current.get('utm_source') || current.get('utm_medium') || current.get('utm_campaign')) return current;
    try {
      var landing = sessionStorage.getItem('pmp_landing_url');
      if (landing) return paramsFrom(landing);
    } catch (_) {}
    return current;
  }

  function qualifies(){
    var p = campaignParams();
    return norm(p.get('utm_source')) === OFFER.source &&
      norm(p.get('utm_medium')) === OFFER.medium &&
      norm(p.get('utm_campaign')) === OFFER.campaign;
  }

  if (!qualifies()) return;

  var busy = false;
  var queued = false;
  var lastSignature = '';

  function money(cents, currency){
    var value = (Number(cents) || 0) / 100;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(value);
    } catch (_) {
      return '$' + value.toFixed(2);
    }
  }

  function sync(){
    if (busy) { queued = true; return; }
    var summary = document.getElementById('pmp-summary');
    if (!summary) return;
    var totals = summary.querySelector('.pmp-sum-totals');
    if (!totals) return;

    busy = true;
    fetch('/cart.js', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function(r){ if (!r.ok) throw new Error('cart'); return r.json(); })
      .then(function(cart){
        var subtotal = Number(cart.total_price) || 0;
        var currency = String(cart.currency || 'USD').toUpperCase();
        var discount = Math.round(subtotal * OFFER.percent / 100);
        var total = Math.max(0, subtotal - discount);
        var signature = [subtotal, currency, discount, total].join('|');

        var totalRow = totals.querySelector('.pmp-sum-total');
        if (!totalRow) return;

        var promoRow = totals.querySelector('[data-pmp-meta-offer-row]');
        if (!promoRow) {
          promoRow = document.createElement('div');
          promoRow.className = 'pmp-sum-row pmp-meta-offer-row';
          promoRow.setAttribute('data-pmp-meta-offer-row', 'true');
          totalRow.insertAdjacentElement('beforebegin', promoRow);
        }

        promoRow.innerHTML = '<span>' + OFFER.code + ' (20% off)</span><strong>−' + money(discount, currency) + '</strong>';
        totalRow.innerHTML = '<span>Total</span><span>' + money(total, currency) + ' ' + currency + '</span>';
        totals.setAttribute('data-pmp-meta-offer-applied', 'true');
        lastSignature = signature;
      })
      .catch(function(){})
      .finally(function(){
        busy = false;
        if (queued) { queued = false; setTimeout(sync, 0); }
      });
  }

  var timer = null;
  function schedule(){
    clearTimeout(timer);
    timer = setTimeout(sync, 50);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
  else schedule();

  new MutationObserver(function(mutations){
    var relevant = false;
    for (var i = 0; i < mutations.length; i++) {
      var target = mutations[i].target;
      if (target && (target.id === 'pmp-summary' || (target.closest && target.closest('#pmp-summary')))) {
        relevant = true; break;
      }
      var nodes = mutations[i].addedNodes || [];
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n && n.nodeType === 1 && (n.id === 'pmp-summary' || (n.querySelector && n.querySelector('#pmp-summary')))) {
          relevant = true; break;
        }
      }
      if (relevant) break;
    }
    if (relevant) schedule();
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('pageshow', schedule);
})();`;

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).send(JS);
}

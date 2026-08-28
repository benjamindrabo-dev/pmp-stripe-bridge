// GET /api/meta-offer-summary.js
// Storefront helper injected by Shopify ScriptTag.
// It sends the selected market country to the checkout bridge, surfaces an
// exact CAD charge notice when the temporary US override is active, and keeps
// the existing Meta retargeting discount summary in sync.

const JS = String.raw`(function(){
  'use strict';

  /* ---------- Temporary US display-USD / charge-CAD bridge ---------- */
  if (!window.__pmpCheckoutCountryBridge) {
    window.__pmpCheckoutCountryBridge = true;
    var nativeFetch = window.fetch.bind(window);
    var currencyNotice = null;

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

    function formatCad(cents){
      var value = (Number(cents) || 0) / 100;
      try { return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', currencyDisplay: 'narrowSymbol' }).format(value); }
      catch (_) { return '$' + value.toFixed(2); }
    }

    function syncCurrencyNotice(){
      var old = document.querySelector('[data-pmp-us-cad-notice]');
      if (!currencyNotice) { if (old) old.remove(); return; }

      var totals = document.querySelector('#pmp-summary .pmp-sum-totals');
      var totalRow = totals && totals.querySelector('.pmp-sum-total');
      if (!totalRow) return;

      var notice = old;
      if (!notice) {
        notice = document.createElement('div');
        notice.setAttribute('data-pmp-us-cad-notice', 'true');
        notice.style.cssText = 'margin-top:10px;padding:10px 12px;border-radius:8px;background:#f4f7f5;color:#20372b;font-size:12px;line-height:1.45;';
        totalRow.insertAdjacentElement('afterend', notice);
      }
      notice.innerHTML = '<strong>Prices shown in USD.</strong><br>Your card will be charged ' +
        '<strong>' + formatCad(currencyNotice.amountTotal) + ' CAD</strong>, the equivalent amount in Canadian dollars.';
    }

    window.fetch = function pmpCountryAwareFetch(input, init){
      if (!isCheckoutRequest(input, init)) return nativeFetch(input, init);

      var nextInit = Object.assign({}, init);
      try {
        var body = JSON.parse(String(nextInit.body || '{}'));
        var country = selectedCountry();
        if (country) body.checkout_country = country;
        nextInit.body = JSON.stringify(body);
      } catch (_) {}

      return nativeFetch(input, nextInit).then(function(response){
        try {
          response.clone().json().then(function(data){
            var amountTotal = Number(data && data.amountTotal);
            currencyNotice = data && data.temporaryCurrencyOverride && Number.isFinite(amountTotal) && amountTotal > 0 ? {
              amountTotal: amountTotal,
              currency: data.currency || 'CAD'
            } : null;
            setTimeout(syncCurrencyNotice, 0);
          }).catch(function(){});
        } catch (_) {}
        return response;
      });
    };

    new MutationObserver(function(){
      if (currencyNotice) setTimeout(syncCurrencyNotice, 0);
    }).observe(document.documentElement, { childList: true, subtree: true });
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

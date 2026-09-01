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
    var attributionStorageKey = 'pmp:attribution:v1';
    var attributionSessionKey = 'pmp:attribution:session-landing:v1';
    var attributionModel = 'last_paid_else_first_free_v1';
    var attributionTtlMs = 90 * 24 * 60 * 60 * 1000;
    var attributionSessionTtlMs = 30 * 60 * 1000;
    var attributionState = null;
    var attributionInitialized = false;
    var currentSessionTouch = null;

    function trackingAllowed(){
      var privacy = window.Shopify && window.Shopify.customerPrivacy;
      if (!privacy || typeof privacy.userCanBeTracked !== 'function') return true;
      try { return privacy.userCanBeTracked() === true; }
      catch (_) { return false; }
    }

    function plainAttributionText(value, maxLength){
      var clean = String(value == null ? '' : value).trim();
      return clean.slice(0, maxLength || 250);
    }

    function decodedAttributionText(value){
      var decoded = plainAttributionText(value, 2000);
      for (var i = 0; i < 2; i++) {
        try {
          var next = decodeURIComponent(decoded.replace(/\+/g, '%20'));
          if (next === decoded) break;
          decoded = next;
        } catch (_) { break; }
      }
      return decoded;
    }

    function containsEmailLike(value){
      return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(decodedAttributionText(value));
    }

    function attributionText(value, maxLength){
      var clean = plainAttributionText(value, maxLength);
      return containsEmailLike(clean) ? '' : clean;
    }

    function attributionUrl(value){
      var clean = plainAttributionText(value, 1500);
      if (!clean) return '';
      try {
        var parsed = new URL(clean, location.href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        parsed.username = '';
        parsed.password = '';
        if (containsEmailLike(parsed.pathname)) parsed.pathname = '/';
        // Query values frequently contain click IDs, search terms and sometimes
        // PII. Dedicated sanitized fields retain attribution; stored page URLs
        // only need the origin and path.
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().slice(0, 1500);
      } catch (_) { return ''; }
    }

    function safeClickId(value){
      var clean = attributionText(value, 300);
      return /^[A-Za-z0-9][A-Za-z0-9._~-]{5,299}$/.test(clean) ? clean : '';
    }

    function safeFacebookCookie(value, prefix){
      var clean = attributionText(value, 300);
      var expected = prefix === 'fbp' ? /^fb\.1\.\d{10,16}\.[A-Za-z0-9._~-]{6,200}$/ :
        /^fb\.1\.\d{10,16}\.[A-Za-z0-9._~-]{6,240}$/;
      return expected.test(clean) ? clean : '';
    }

    function normalizedMedium(value){
      return attributionText(value, 100).toLowerCase().replace(/[\s-]+/g, '_');
    }

    function isPaidMedium(value){
      var medium = normalizedMedium(value);
      return [
        'paid', 'cpc', 'ppc', 'paid_social', 'paid_search', 'paidsearch',
        'sem', 'display', 'retargeting', 'remarketing', 'cpm'
      ].indexOf(medium) !== -1;
    }

    function touchTime(value, fallback){
      var numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      var parsed = Date.parse(String(value || ''));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    function externalReferrer(value){
      var clean = attributionUrl(value);
      if (!clean) return '';
      try {
        var ref = new URL(clean);
        var page = new URL(location.href);
        var refHost = ref.hostname.toLowerCase().replace(/^www\./, '');
        var pageHost = page.hostname.toLowerCase().replace(/^www\./, '');
        return refHost === pageHost ? '' : clean;
      } catch (_) { return ''; }
    }

    function inferredSource(referrer){
      if (!referrer) return { source: 'direct', medium: 'none' };
      try {
        var host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
        if (/(^|\.)google\./.test(host)) return { source: 'google', medium: 'organic' };
        if (/(^|\.)bing\.com$/.test(host)) return { source: 'bing', medium: 'organic' };
        if (/(^|\.)yahoo\./.test(host)) return { source: 'yahoo', medium: 'organic' };
        if (/(^|\.)duckduckgo\.com$/.test(host)) return { source: 'duckduckgo', medium: 'organic' };
        if (/(^|\.)instagram\.com$/.test(host)) return { source: 'instagram', medium: 'organic_social' };
        if (/(^|\.)facebook\.com$/.test(host) || /(^|\.)fb\.com$/.test(host)) {
          return { source: 'facebook', medium: 'organic_social' };
        }
        if (host === 't.co' || /(^|\.)(twitter|x)\.com$/.test(host)) {
          return { source: 'twitter', medium: 'organic_social' };
        }
        return { source: host.slice(0, 100), medium: 'referral' };
      } catch (_) { return { source: 'direct', medium: 'none' }; }
    }

    function touchFromValues(values, now){
      var rawLanding = plainAttributionText(values && (values.landing_url || values.landing), 1500);
      var landingParams;
      try { landingParams = new URL(rawLanding || location.href, location.href).searchParams; }
      catch (_) { landingParams = new URLSearchParams(''); }
      function supplied(name, fallbackName){
        var direct = values && (values[name] || (fallbackName && values[fallbackName]));
        return direct == null || direct === '' ? landingParams.get(name) : direct;
      }
      var landing = attributionUrl(rawLanding);
      var referrer = externalReferrer(values && values.referrer);
      var source = attributionText(supplied('utm_source', 'source'), 100).toLowerCase();
      var medium = normalizedMedium(supplied('utm_medium', 'medium'));
      var campaign = attributionText(supplied('utm_campaign', 'campaign'), 200);
      var content = attributionText(supplied('utm_content', 'content'), 200);
      var term = attributionText(supplied('utm_term', 'term'), 200);
      var inferred = inferredSource(referrer);
      var gclid = safeClickId(supplied('gclid'));
      var gbraid = safeClickId(supplied('gbraid'));
      var wbraid = safeClickId(supplied('wbraid'));
      var fbclid = safeClickId(supplied('fbclid'));
      var ttclid = safeClickId(supplied('ttclid'));
      var msclkid = safeClickId(supplied('msclkid'));
      var fbc = safeFacebookCookie(values && values.fbc, 'fbc');

      if (!source) {
        if (gclid || gbraid || wbraid) source = 'google';
        else if (msclkid) source = 'microsoft';
        else if (ttclid) source = 'tiktok';
        // A bare fbclid proves a Meta redirect, not that the click was paid.
        else if (fbclid) source = inferred.source !== 'direct' ? inferred.source : 'meta';
        else source = inferred.source;
      }
      if (!medium) {
        if (gclid || gbraid || wbraid || msclkid || ttclid) medium = 'cpc';
        else if (fbclid) medium = 'organic_social';
        else medium = inferred.medium;
      }

      var occurredAt = touchTime(values && (values.at || values.captured_at), now);
      var paid = Boolean(gclid || gbraid || wbraid || msclkid || ttclid || isPaidMedium(medium));
      var identifiableFree = !paid && !(source === 'direct' && (medium === 'none' || !medium));
      return {
        landing_url: landing,
        referrer: referrer,
        source: source || 'direct',
        medium: medium || 'none',
        campaign: campaign,
        content: content,
        term: term,
        gclid: gclid,
        gbraid: gbraid,
        wbraid: wbraid,
        fbclid: fbclid,
        ttclid: ttclid,
        msclkid: msclkid,
        fbc: fbc,
        at: new Date(occurredAt).toISOString(),
        _time: occurredAt,
        _paid: paid,
        _free: identifiableFree
      };
    }

    function touchFromPage(now){
      var rawUrl = plainAttributionText(location.href, 1500);
      var url = attributionUrl(rawUrl);
      var params;
      try { params = new URL(rawUrl || location.href).searchParams; }
      catch (_) { params = new URLSearchParams(''); }
      return touchFromValues({
        landing_url: url,
        referrer: document.referrer || '',
        utm_source: params.get('utm_source'),
        utm_medium: params.get('utm_medium'),
        utm_campaign: params.get('utm_campaign'),
        utm_content: params.get('utm_content'),
        utm_term: params.get('utm_term'),
        gclid: params.get('gclid'),
        gbraid: params.get('gbraid'),
        wbraid: params.get('wbraid'),
        fbclid: params.get('fbclid'),
        ttclid: params.get('ttclid'),
        msclkid: params.get('msclkid'),
        captured_at: now
      }, now);
    }

    function publicTouch(touch){
      if (!touch) return null;
      return {
        landing_url: attributionUrl(touch.landing_url),
        referrer: attributionUrl(touch.referrer),
        source: attributionText(touch.source, 100).toLowerCase(),
        medium: normalizedMedium(touch.medium),
        campaign: attributionText(touch.campaign, 200),
        content: attributionText(touch.content, 200),
        term: attributionText(touch.term, 200),
        gclid: safeClickId(touch.gclid),
        gbraid: safeClickId(touch.gbraid),
        wbraid: safeClickId(touch.wbraid),
        fbclid: safeClickId(touch.fbclid),
        ttclid: safeClickId(touch.ttclid),
        msclkid: safeClickId(touch.msclkid),
        fbc: safeFacebookCookie(touch.fbc, 'fbc'),
        at: new Date(touchTime(touch.at, Date.now())).toISOString()
      };
    }

    function normalizedTouch(touch, now){
      if (!touch || typeof touch !== 'object') return null;
      var clean = touchFromValues(touch, now);
      if (!clean.landing_url && !clean.referrer && clean.source === 'direct') return null;
      return clean;
    }

    function emptyAttributionState(){
      return { version: 1, expiresAt: 0, firstEntry: null, firstFree: null, lastPaid: null };
    }

    function normalizedState(candidate, now){
      if (!candidate || typeof candidate !== 'object') return null;
      var expiresAt = Number(candidate.expiresAt || candidate.expires_at || 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
      var state = emptyAttributionState();
      state.expiresAt = expiresAt;
      state.firstEntry = normalizedTouch(candidate.firstEntry, now);
      state.firstFree = normalizedTouch(candidate.firstFree, now);
      state.lastPaid = normalizedTouch(candidate.lastPaid, now);
      if (state.firstFree && (!state.firstFree._free || state.firstFree._paid)) state.firstFree = null;
      if (state.lastPaid && !state.lastPaid._paid) state.lastPaid = null;
      return state;
    }

    function earlierTouch(left, right){
      if (!left) return right || null;
      if (!right) return left;
      return left._time <= right._time ? left : right;
    }

    function laterTouch(left, right){
      if (!left) return right || null;
      if (!right) return left;
      return left._time >= right._time ? left : right;
    }

    function mergeAttributionStates(left, right, now){
      var a = normalizedState(left, now);
      var b = normalizedState(right, now);
      if (!a) return b;
      if (!b) return a;
      return {
        version: 1,
        expiresAt: Math.max(a.expiresAt, b.expiresAt),
        firstEntry: earlierTouch(a.firstEntry, b.firstEntry),
        firstFree: earlierTouch(a.firstFree, b.firstFree),
        lastPaid: laterTouch(a.lastPaid, b.lastPaid)
      };
    }

    function readAttributionState(now){
      try {
        var raw = localStorage.getItem(attributionStorageKey);
        if (!raw) return null;
        var state = normalizedState(JSON.parse(raw), now);
        if (!state) localStorage.removeItem(attributionStorageKey);
        return state;
      } catch (_) { return null; }
    }

    function writeAttributionState(state){
      try {
        localStorage.setItem(attributionStorageKey, JSON.stringify({
          version: 1,
          expiresAt: state.expiresAt,
          firstEntry: publicTouch(state.firstEntry),
          firstFree: publicTouch(state.firstFree),
          lastPaid: publicTouch(state.lastPaid)
        }));
      } catch (_) {}
    }

    function legacyTouch(key, now){
      try {
        var raw = localStorage.getItem(key);
        if (!raw) return null;
        var value = JSON.parse(raw);
        var captured = touchTime(value && (value.captured_at || value.at), 0);
        if (!captured || captured + attributionTtlMs <= now) return null;
        return touchFromValues(value, captured);
      } catch (_) { return null; }
    }

    function mergeLegacyState(state, now){
      var next = state || emptyAttributionState();
      var legacyPrimary = legacyTouch('pmp_paid_attribution_v3', now);
      var legacyFallback = legacyTouch('pmp_last_touch_v1', now);
      if (legacyPrimary && legacyPrimary._paid) {
        next.lastPaid = laterTouch(next.lastPaid, legacyPrimary);
        next.expiresAt = Math.max(next.expiresAt, legacyPrimary._time + attributionTtlMs);
      } else if (legacyPrimary && legacyPrimary._free) {
        next.firstFree = earlierTouch(next.firstFree, legacyPrimary);
        next.expiresAt = Math.max(next.expiresAt, legacyPrimary._time + attributionTtlMs);
      }
      // The generic last-touch record was not guaranteed to contain paid data;
      // it is therefore accepted only as a clearly unpaid fallback.
      if (legacyFallback && legacyFallback._free) {
        next.firstFree = earlierTouch(next.firstFree, legacyFallback);
        next.expiresAt = Math.max(next.expiresAt, legacyFallback._time + attributionTtlMs);
      }
      return next;
    }

    function touchFingerprint(touch){
      if (!touch) return '';
      return [
        touch.landing_url, touch.referrer, touch.source, touch.medium, touch.campaign,
        touch.gclid, touch.gbraid, touch.wbraid, touch.fbclid, touch.ttclid, touch.msclkid
      ].join('|');
    }

    function readSessionTouch(now){
      try {
        var value = JSON.parse(sessionStorage.getItem(attributionSessionKey) || 'null');
        if (!value || typeof value !== 'object') return null;
        var capturedAt = Number(value.capturedAt || 0);
        var touch = normalizedTouch(value.touch, now);
        if (!touch || !capturedAt) return null;
        return { touch: touch, capturedAt: capturedAt, fingerprint: attributionText(value.fingerprint, 2500) };
      } catch (_) { return null; }
    }

    function writeSessionTouch(touch, now){
      try {
        sessionStorage.setItem(attributionSessionKey, JSON.stringify({
          capturedAt: now,
          fingerprint: touchFingerprint(touch),
          touch: publicTouch(touch)
        }));
      } catch (_) {}
    }

    function recordCurrentVisit(state, now){
      var next = state || emptyAttributionState();
      var pageTouch = touchFromPage(now);
      var session = readSessionTouch(now);
      var sameTouch = session && session.fingerprint === touchFingerprint(pageTouch);
      var hasAcquisition = pageTouch._paid || pageTouch._free;
      var sessionFresh = session && session.capturedAt + attributionSessionTtlMs > now;
      var isNewTouch = !session || (!sameTouch && (hasAcquisition || !sessionFresh));

      // firstEntry is literal: it is the first page this version actually saw.
      // It is never synthesized from an older mixed-attribution record.
      if (!next.firstEntry) {
        next.firstEntry = pageTouch;
        next.expiresAt = Math.max(next.expiresAt, now + attributionTtlMs);
      }
      if (isNewTouch) {
        currentSessionTouch = pageTouch;
        writeSessionTouch(pageTouch, now);
        if (pageTouch._paid) next.lastPaid = laterTouch(next.lastPaid, pageTouch);
        else if (pageTouch._free) next.firstFree = earlierTouch(next.firstFree, pageTouch);
        if (pageTouch._paid || pageTouch._free) {
          next.expiresAt = Math.max(next.expiresAt, now + attributionTtlMs);
        }
      } else {
        currentSessionTouch = session ? session.touch : pageTouch;
      }
      return next;
    }

    function refreshAttributionState(recordVisit){
      if (!trackingAllowed()) {
        attributionState = null;
        currentSessionTouch = null;
        return null;
      }
      var now = Date.now();
      var memory = normalizedState(attributionState, now);
      var stored = readAttributionState(now);
      attributionState = mergeAttributionStates(memory, stored, now);
      attributionState = mergeLegacyState(attributionState, now);
      if (recordVisit || !attributionState || !attributionState.firstEntry) {
        attributionState = recordCurrentVisit(attributionState, now);
      }
      attributionState.expiresAt = Math.max(Number(attributionState.expiresAt || 0), now + 1);
      writeAttributionState(attributionState);
      attributionInitialized = true;
      return attributionState;
    }

    var sensitiveTrackingKeys = [
      'attribution_model', 'landing_url', 'referrer',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid',
      'fbp', 'fbc', 'external_id', 'ga_client_id', 'ga_session_id', 'ga_session_number'
    ];

    function removeTrackingBody(body){
      Object.keys(body || {}).forEach(function(key){
        if (sensitiveTrackingKeys.indexOf(key) !== -1 ||
          /^first_(entry|touch|free)_/.test(key) || /^last_(touch|paid)_/.test(key)) {
          delete body[key];
        }
      });
    }

    function sanitizeBodyIdentifiers(body){
      ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'].forEach(function(key){
        var clean = safeClickId(body[key]);
        if (clean) body[key] = clean;
        else delete body[key];
      });
      var fbp = safeFacebookCookie(body.fbp, 'fbp');
      var fbc = safeFacebookCookie(body.fbc, 'fbc');
      if (fbp) body.fbp = fbp; else delete body.fbp;
      if (fbc) body.fbc = fbc; else delete body.fbc;
    }

    function sanitizeBodyAttributionText(body){
      ['landing_url', 'referrer'].forEach(function(key){
        var clean = attributionUrl(body[key]);
        if (clean) body[key] = clean;
        else delete body[key];
      });
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function(key){
        var clean = attributionText(body[key], key === 'utm_source' || key === 'utm_medium' ? 100 : 200);
        if (clean) body[key] = clean;
        else delete body[key];
      });
      ['external_id', 'ga_client_id', 'ga_session_id', 'ga_session_number'].forEach(function(key){
        if (containsEmailLike(body[key])) delete body[key];
      });
    }

    function bodyTouch(body, now){
      return touchFromValues({
        landing_url: body.landing_url || location.href,
        referrer: body.referrer || '',
        utm_source: body.utm_source,
        utm_medium: body.utm_medium,
        utm_campaign: body.utm_campaign,
        utm_content: body.utm_content,
        utm_term: body.utm_term,
        gclid: body.gclid,
        gbraid: body.gbraid,
        wbraid: body.wbraid,
        fbclid: body.fbclid,
        ttclid: body.ttclid,
        msclkid: body.msclkid,
        fbc: body.fbc,
        captured_at: now
      }, now);
    }

    function clearTouchFields(body, prefix){
      [
        'landing_url', 'referrer', 'source', 'medium', 'campaign', 'content', 'term', 'at',
        'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid', 'fbc'
      ].forEach(function(field){
        delete body[prefix + '_' + field];
      });
    }

    function injectTouchFields(body, prefix, touch){
      clearTouchFields(body, prefix);
      if (!touch) return;
      body[prefix + '_landing_url'] = touch.landing_url || '';
      body[prefix + '_referrer'] = touch.referrer || '';
      body[prefix + '_source'] = touch.source || '';
      body[prefix + '_medium'] = touch.medium || '';
      body[prefix + '_campaign'] = touch.campaign || '';
      body[prefix + '_at'] = touch.at || '';
    }

    function paidPlatform(touch){
      if (!touch) return '';
      var source = attributionText(touch.source, 100).toLowerCase();
      if (touch.gclid || touch.gbraid || touch.wbraid || /google/.test(source)) return 'google';
      if (touch.msclkid || /microsoft|bing/.test(source)) return 'microsoft';
      if (touch.ttclid || /tiktok/.test(source)) return 'tiktok';
      if (touch.fbclid || touch.fbc || /meta|facebook|instagram|\bfb\b|\big\b/.test(source)) return 'meta';
      return '';
    }

    function derivedFbc(fbclid, touch){
      var click = safeClickId(fbclid);
      if (!click) return '';
      var when = touchTime(touch && touch.at, Date.now());
      return 'fb.1.' + String(Math.round(when)) + '.' + click;
    }

    function injectAttribution(body){
      if (!trackingAllowed()) {
        removeTrackingBody(body);
        return;
      }

      sanitizeBodyIdentifiers(body);
      Object.keys(body).forEach(function(key){
        if (/^first_free_/.test(key) || /^last_paid_/.test(key)) delete body[key];
      });
      var now = Date.now();
      var state = refreshAttributionState(!attributionInitialized);
      var supplied = bodyTouch(body, now);
      sanitizeBodyAttributionText(body);
      // A valid paid signal already captured by the theme can seed last-paid
      // only when this version has not observed a paid touch itself.
      if (state && !state.lastPaid && supplied._paid) {
        state.lastPaid = supplied;
        state.expiresAt = Math.max(state.expiresAt, now + attributionTtlMs);
        attributionState = state;
        writeAttributionState(state);
      }

      body.attribution_model = attributionModel;
      injectTouchFields(body, 'first_entry', state && state.firstEntry);
      injectTouchFields(body, 'first_touch', state && state.firstFree);
      injectTouchFields(body, 'last_touch', state && state.lastPaid);

      var sessionTouch = currentSessionTouch || touchFromPage(now);
      body.landing_url = sessionTouch.landing_url || attributionUrl(location.href);
      body.referrer = sessionTouch.referrer || '';

      var existingFbc = safeFacebookCookie(body.fbc, 'fbc');
      var existingFbp = safeFacebookCookie(body.fbp, 'fbp');
      ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'].forEach(function(key){ delete body[key]; });
      delete body.fbc;
      var paid = state && state.lastPaid;
      var platform = paidPlatform(paid);
      if (paid) {
        ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid'].forEach(function(key){
          var clean = safeClickId(paid[key]);
          if (clean) body[key] = clean;
        });
        if (platform === 'meta') {
          var paidFbc = safeFacebookCookie(paid.fbc, 'fbc') ||
            derivedFbc(paid.fbclid, paid) || existingFbc;
          if (paidFbc) body.fbc = paidFbc;
        }
      } else {
        // A bare Meta redirect remains an unpaid/free touch, but retaining its
        // valid click cookie still improves server-side event matching.
        var unpaidMeta = supplied.fbclid ? supplied :
          (state && state.firstFree && state.firstFree.fbclid ? state.firstFree : null);
        if (unpaidMeta) {
          body.fbclid = unpaidMeta.fbclid;
          body.fbc = unpaidMeta.fbc || derivedFbc(unpaidMeta.fbclid, unpaidMeta);
        }
      }
      if (existingFbp) body.fbp = existingFbp;
    }

    // Capture the first observable page as soon as the ScriptTag loads, but do
    // not touch nonessential storage until Shopify says tracking is allowed.
    refreshAttributionState(true);

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
        injectAttribution(body);
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
    var privacy = window.Shopify && window.Shopify.customerPrivacy;
    if (privacy && typeof privacy.userCanBeTracked === 'function') {
      try { if (privacy.userCanBeTracked() !== true) return current; }
      catch (_) { return current; }
    }
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

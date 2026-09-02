// GET /api/meta-offer-summary.js
// Storefront helper served from Vercel and currently loaded by a Shopify theme
// section. It sends the selected market country to the checkout bridge, keeps
// the Meta retargeting discount summary in sync, and temporarily captures paid
// attribution until the durable Shopify Custom Pixel can be connected.

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
    // This writer is a transition fallback. The Shopify Custom Pixel remains
    // the durable owner because this file's loader currently lives in a theme.
    var canonicalAttributionKey = 'pmp:attribution';
    var paidJournalPrefix = 'pmp:attribution:paid:';
    var legacyAttributionKeys = ['pmp_paid_attribution_v3', 'pmp:attribution:v1'];
    var clickIdKeys = ['gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid', 'ttclid', 'sccid'];
    var attributionModel = 'last_paid_else_first_free_v1';
    var attributionTtlMs = 90 * 24 * 60 * 60 * 1000;
    var maxPaidJournalEntries = 64;
    var minimumAttributionDate = Date.UTC(2020, 0, 1);
    var pageObservedAt = Date.now();

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

    function safeAttributionPath(pathname){
      var raw = plainAttributionText(pathname || '/', 1500) || '/';
      var decoded = decodedAttributionText(raw);
      if (containsEmailLike(decoded)) return '/';
      var segments = decoded.split('/').filter(Boolean);
      var offset = segments[0] && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]) ? 1 : 0;
      var prefix = offset ? '/' + segments[0].toLowerCase() + '/' : '/';
      if (segments.length === offset) return prefix;
      var root = segments[offset].toLowerCase();
      if (['products', 'collections', 'pages', 'blogs', 'search'].indexOf(root) !== -1) return raw;
      if (root === 'cart') return prefix + 'cart';
      // Account, checkout, order-status and app routes can contain opaque
      // customer or pre-authentication tokens. Attribution never needs them.
      return prefix;
    }

    function attributionUrl(value){
      var clean = plainAttributionText(value, 1500);
      if (!clean) return '';
      try {
        var parsed = new URL(clean, location.href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        parsed.username = '';
        parsed.password = '';
        parsed.pathname = safeAttributionPath(parsed.pathname);
        // Query values frequently contain click IDs, search terms and sometimes
        // PII. Dedicated sanitized fields retain attribution; stored page URLs
        // only need the origin and path.
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().slice(0, 1500);
      } catch (_) { return ''; }
    }

    function safeClickId(value){
      var raw = String(value == null ? '' : value).trim();
      if (raw.length > 255) return '';
      var clean = attributionText(raw, 255);
      return /^[A-Za-z0-9][A-Za-z0-9._~-]{5,254}$/.test(clean) ? clean : '';
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
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric < 100000000000 ? numeric * 1000 : numeric;
      }
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

    function touchFromValues(values, now, allowPageFallback){
      var rawLanding = plainAttributionText(values && (values.landing_url || values.landing), 1500);
      var landingParams;
      var fallbackUrl = allowPageFallback === false ? 'https://puremajestypet.com/' : location.href;
      try { landingParams = new URL(rawLanding || fallbackUrl, fallbackUrl).searchParams; }
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
      var dclid = safeClickId(supplied('dclid'));
      var fbclid = safeClickId(supplied('fbclid'));
      var ttclid = safeClickId(supplied('ttclid'));
      var msclkid = safeClickId(supplied('msclkid'));
      var sccid = safeClickId(supplied('sccid'));
      var fbc = safeFacebookCookie(values && values.fbc, 'fbc');

      if (!source) {
        if (gclid || gbraid || wbraid || dclid) source = 'google';
        else if (msclkid) source = 'microsoft';
        else if (ttclid) source = 'tiktok';
        else if (sccid) source = 'snapchat';
        else if (fbclid) source = 'meta';
        else source = inferred.source;
      }
      if (!medium) {
        if (gclid || gbraid || wbraid || dclid || fbclid || msclkid || ttclid || sccid) medium = 'cpc';
        else medium = inferred.medium;
      }

      var occurredAt = touchTime(values && (values.at || values.captured_at), now);
      // Corrupt legacy numbers can be finite yet outside JavaScript Date's
      // supported range. Never let one malformed record abort all capture.
      if (!Number.isFinite(new Date(occurredAt).getTime())) {
        occurredAt = Number.isFinite(new Date(now).getTime()) ? now : Date.now();
      }
      var paid = Boolean(gclid || gbraid || wbraid || dclid || fbclid || msclkid || ttclid || sccid || isPaidMedium(medium));
      var identifiableFree = !paid && Boolean(referrer || campaign ||
        (source && source !== 'direct') || (medium && medium !== 'none'));
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
        dclid: dclid,
        fbclid: fbclid,
        ttclid: ttclid,
        msclkid: msclkid,
        sccid: sccid,
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
        dclid: params.get('dclid'),
        fbclid: params.get('fbclid'),
        ttclid: params.get('ttclid'),
        msclkid: params.get('msclkid'),
        sccid: params.get('sccid'),
        captured_at: now
      }, now);
    }

    function clickValue(value, key){
      var direct = value && safeClickId(value[key]);
      if (direct) return direct;
      return value && value.clickIds && safeClickId(value.clickIds[key]);
    }

    function firstValidTime(values, fallback){
      for (var i = 0; i < values.length; i++) {
        var parsed = touchTime(values[i], 0);
        if (parsed) return parsed;
      }
      return fallback || 0;
    }

    function storedTouch(value, parent, now){
      if (!value || typeof value !== 'object' || !Object.keys(value).length) return null;
      var occurredAt = firstValidTime([
        value.capturedAt, value.captured_at, value.at,
        parent && parent.capturedAt, parent && parent.captured_at, parent && parent.at
      ], 0);
      var touch = touchFromValues({
        landing_url: value.landingUrl || value.landing_url || value.landing ||
          (parent && (parent.landingUrl || parent.landing_url || parent.landing)),
        referrer: value.referrer || (parent && parent.referrer),
        source: value.source || value.utm_source,
        medium: value.medium || value.utm_medium,
        campaign: value.campaign || value.utm_campaign,
        content: value.content || value.utm_content,
        term: value.term || value.utm_term,
        gclid: clickValue(value, 'gclid'),
        gbraid: clickValue(value, 'gbraid'),
        wbraid: clickValue(value, 'wbraid'),
        dclid: clickValue(value, 'dclid'),
        fbclid: clickValue(value, 'fbclid'),
        ttclid: clickValue(value, 'ttclid'),
        msclkid: clickValue(value, 'msclkid'),
        sccid: clickValue(value, 'sccid'),
        fbc: value.fbc,
        captured_at: occurredAt || now
      }, occurredAt || now, false);
      if (touch) touch._eventId = safeClickId(value.eventId);
      return touch;
    }

    function readCanonicalAttribution(now){
      try {
        var value = JSON.parse(localStorage.getItem(canonicalAttributionKey) || 'null');
        if (!value || Number(value.schemaVersion) !== 3) return null;
        var paid = value.lastPaid && typeof value.lastPaid === 'object' ? value.lastPaid : null;
        var capturedAt = paid && Number(paid.capturedAt || 0);
        var hasDatedStoredPaid = Boolean(paid && Object.keys(paid).length && capturedAt > 0);
        var startedAt = Number(value.startedAt || 0);
        var expiresAt = Number(value.expiresAt || 0);
        var storedPaid = paid && storedTouch(paid, value, capturedAt || now);
        var activePaid = storedPaid && storedPaid._paid && capturedAt > 0 && expiresAt > now ? storedPaid : null;
        var activeDirectJourney = !hasDatedStoredPaid && Number.isFinite(startedAt) &&
          startedAt > 0 && startedAt + attributionTtlMs > now;
        if (!activePaid && !activeDirectJourney) return null;
        var firstFree = storedTouch(value.firstFree, value, now);
        if (firstFree && (!firstFree._free || firstFree._paid)) firstFree = null;
        return {
          version: 1,
          journeyId: safeClickId(value.journeyId),
          expiresAt: activePaid ? expiresAt : 0,
          firstEntry: storedTouch(value.firstEntry, value, now),
          firstFree: firstFree,
          lastPaid: activePaid
        };
      } catch (_) { return null; }
    }

    function readLegacyPaidAttribution(now){
      var latest = null;
      ['pmp_paid_attribution_v3', 'pmp:attribution:v1'].forEach(function(key){
        try {
          var record = JSON.parse(localStorage.getItem(key) || 'null');
          if (!record || typeof record !== 'object') return;
          var paid = record.lastPaid && typeof record.lastPaid === 'object' ? record.lastPaid : record;
          var occurredAt = firstValidTime([
            paid.capturedAt, paid.captured_at, paid.at,
            record.capturedAt, record.captured_at, record.at
          ], 0);
          if (!occurredAt || occurredAt > now + 5 * 60 * 1000 || occurredAt + attributionTtlMs <= now) return;
          var touch = storedTouch(paid, record, occurredAt);
          if (touch && touch._paid && (!latest || touch._time > latest._time)) latest = touch;
        } catch (_) {}
      });
      return latest;
    }

    function readPaidJournalAttribution(now){
      var candidates = [];
      try {
        var length = Number(localStorage.length) || 0;
        for (var i = 0; i < length; i++) {
          var key = localStorage.key(i);
          if (typeof key !== 'string' || key.indexOf(paidJournalPrefix) !== 0) continue;
          try {
            var record = JSON.parse(localStorage.getItem(key) || 'null');
            if (!record || typeof record !== 'object') continue;
            var paid = record.lastPaid && storedTouch(record.lastPaid, record, now);
            if (!paid || !paid._paid || !paid._time || paid._time + attributionTtlMs <= now) continue;
            var firstFree = storedTouch(record.firstFree, record, now);
            if (firstFree && (!firstFree._free || firstFree._paid)) firstFree = null;
            var candidate = {
              version: 1,
              contextPending: record.contextPending === true,
              journeyId: safeClickId(record.journeyId),
              startedAt: firstValidTime([record.startedAt], 0),
              expiresAt: paid._time + attributionTtlMs,
              firstEntry: storedTouch(record.firstEntry, record, now),
              firstFree: firstFree,
              lastPaid: paid
            };
            candidates.push(candidate);
          } catch (_) {}
        }
      } catch (_) {}
      candidates.sort(function(left, right){
        if (paidTouchIsNewer(left.lastPaid, right.lastPaid)) return -1;
        if (paidTouchIsNewer(right.lastPaid, left.lastPaid)) return 1;
        return 0;
      });
      var latest = candidates[0] || null;
      if (latest && latest.contextPending) {
        var prior = candidates.slice(1).find(function(candidate){
          return !candidate.contextPending && Boolean(candidate.journeyId);
        });
        if (prior) latest = Object.assign({}, latest, {
          journeyId: prior.journeyId,
          startedAt: prior.startedAt,
          firstEntry: prior.firstEntry,
          firstFree: prior.firstFree
        });
      }
      return latest;
    }

    function paidTouchFromBody(body, now){
      var occurredAt = firstValidTime([
        body.last_touch_at, body.last_paid_at, body.captured_at
      ], 0);
      if (!occurredAt || occurredAt > now + 5 * 60 * 1000 || occurredAt + attributionTtlMs <= now) return null;
      var touch = touchFromValues({
        landing_url: body.last_touch_landing_url || body.last_paid_landing_url || body.landing_url,
        referrer: body.last_touch_referrer || body.last_paid_referrer || body.referrer,
        source: body.last_touch_source || body.last_paid_source || body.utm_source,
        medium: body.last_touch_medium || body.last_paid_medium || body.utm_medium,
        campaign: body.last_touch_campaign || body.last_paid_campaign || body.utm_campaign,
        content: body.last_touch_content || body.last_paid_content || body.utm_content,
        term: body.last_touch_term || body.last_paid_term || body.utm_term,
        gclid: body.gclid || body.last_touch_gclid || body.last_paid_gclid,
        gbraid: body.gbraid || body.last_touch_gbraid || body.last_paid_gbraid,
        wbraid: body.wbraid || body.last_touch_wbraid || body.last_paid_wbraid,
        dclid: body.dclid || body.last_touch_dclid || body.last_paid_dclid,
        fbclid: body.fbclid || body.last_touch_fbclid || body.last_paid_fbclid,
        ttclid: body.ttclid || body.last_touch_ttclid || body.last_paid_ttclid,
        msclkid: body.msclkid || body.last_touch_msclkid || body.last_paid_msclkid,
        sccid: body.sccid || body.last_touch_sccid || body.last_paid_sccid,
        fbc: body.fbc,
        captured_at: occurredAt
      }, occurredAt, false);
      return touch && touch._paid ? touch : null;
    }

    function latestPaidTouch(candidates){
      return candidates.filter(Boolean).reduce(function(latest, touch){
        if (!latest || touch._time > latest._time) return touch;
        if (touch._time === latest._time && (touch._eventId || '') > (latest._eventId || '')) return touch;
        return latest;
      }, null);
    }

    function earliestTouch(candidates){
      return candidates.filter(Boolean).reduce(function(earliest, touch){
        return !earliest || touch._time < earliest._time ? touch : earliest;
      }, null);
    }

    function paidTouchIsNewer(left, right){
      if (!left) return false;
      if (!right) return true;
      if (left._time !== right._time) return left._time > right._time;
      return (left._eventId || '') > (right._eventId || '');
    }

    function mergedContextState(state, journalState){
      if (!state) return journalState;
      if (!journalState) return state;
      var chosen = paidTouchIsNewer(journalState.lastPaid, state.lastPaid) ? journalState : state;
      if (!state.journeyId || state.journeyId !== journalState.journeyId) return chosen;
      return Object.assign({}, chosen, {
        firstEntry: earliestTouch([state.firstEntry, journalState.firstEntry]),
        firstFree: earliestTouch([state.firstFree, journalState.firstFree])
      });
    }

    /* ---------- Transitional canonical attribution writer ---------- */
    function plausibleAttributionDate(value, now){
      var parsed = touchTime(value, 0);
      return parsed >= minimumAttributionDate && parsed <= now + 5 * 60 * 1000 ? parsed : 0;
    }

    function firstPlausibleAttributionDate(values, now){
      for (var i = 0; i < values.length; i++) {
        var parsed = plausibleAttributionDate(values[i], now);
        if (parsed) return parsed;
      }
      return 0;
    }

    function storageRecord(key){
      try {
        var parsed = JSON.parse(localStorage.getItem(key) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (_) { return null; }
    }

    function generatedJourneyId(){
      try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
          return window.crypto.randomUUID();
        }
      } catch (_) {}
      return 'pmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
    }

    function emptyAttributionState(now){
      return {
        schemaVersion: 3,
        journeyId: generatedJourneyId(),
        startedAt: now,
        migrationCompletedAt: 0,
        legacyVersions: {},
        expiresAt: 0,
        firstEntry: {},
        firstFree: {},
        lastPaid: {},
        writer: 'pmp-storefront-fallback-v3'
      };
    }

    function storedEntry(value, now){
      if (!value || typeof value !== 'object') return {};
      var touch = storedTouch(value, null, now);
      var capturedAt = firstPlausibleAttributionDate([
        value.capturedAt, value.captured_at, value.at
      ], now);
      var entry = {
        landingUrl: touch && touch.landing_url || '',
        referrer: touch && touch.referrer || '',
        source: touch && touch.source || '',
        medium: touch && touch.medium || '',
        campaign: touch && touch.campaign || '',
        content: touch && touch.content || '',
        term: touch && touch.term || '',
        capturedAt: capturedAt
      };
      if (!entry.landingUrl && !entry.referrer && !entry.source && !entry.medium &&
        !entry.campaign && !entry.content && !entry.term && !entry.capturedAt) return {};
      return entry;
    }

    function entryFromTouch(touch){
      if (!touch) return {};
      return {
        landingUrl: touch.landing_url || '',
        referrer: touch.referrer || '',
        source: touch.source || '',
        medium: touch.medium || '',
        campaign: touch.campaign || '',
        content: touch.content || '',
        term: touch.term || '',
        capturedAt: touch._time || 0
      };
    }

    function clickIdsFromTouch(touch){
      var ids = {};
      clickIdKeys.forEach(function(key){
        var clean = touch && safeClickId(touch[key]);
        if (clean) ids[key] = clean;
      });
      return ids;
    }

    function hasStoredPaid(value){
      if (!value || typeof value !== 'object') return false;
      var ids = value.clickIds && typeof value.clickIds === 'object' ? value.clickIds : value;
      var hasClick = clickIdKeys.some(function(key){ return Boolean(safeClickId(ids[key])); });
      return hasClick || isPaidMedium(value.medium || value.utm_medium);
    }

    function paidRecord(value, parent, now, migrated){
      if (!value || typeof value !== 'object') return null;
      var paid = value.lastPaid && typeof value.lastPaid === 'object' ? value.lastPaid : value;
      var touch = storedTouch(paid, parent || value, now);
      if (!touch || !touch._paid) return null;
      var capturedAt = firstPlausibleAttributionDate([
        paid.capturedAt, paid.captured_at, paid.at,
        parent && parent.capturedAt, parent && parent.captured_at, parent && parent.at,
        value.capturedAt, value.captured_at, value.at
      ], now);
      var record = Object.assign(entryFromTouch(touch), {
        clickIds: clickIdsFromTouch(touch),
        capturedAt: capturedAt,
        dateUncertain: capturedAt === 0,
        eventId: safeClickId(paid.eventId)
      });
      if (migrated || paid.migrated === true) record.migrated = true;
      return record;
    }

    function legacyAttributionSignature(raw){
      if (typeof raw !== 'string' || !raw) return '';
      var hash = 2166136261;
      for (var i = 0; i < raw.length; i++) {
        hash ^= raw.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return raw.length.toString(36) + '-' + (hash >>> 0).toString(36);
    }

    function validLegacyVersions(value){
      var versions = {};
      var source = value && typeof value === 'object' ? value : {};
      legacyAttributionKeys.forEach(function(key){
        var signature = typeof source[key] === 'string' ? source[key].slice(0, 40) : '';
        if (/^[a-z0-9]+-[a-z0-9]+$/i.test(signature)) versions[key] = signature;
      });
      return versions;
    }

    function earlierStoredEntry(left, right){
      if (!left || !Object.keys(left).length) return right || {};
      if (!right || !Object.keys(right).length) return left;
      if (!left.capturedAt) return right.capturedAt ? right : left;
      if (!right.capturedAt) return left;
      return left.capturedAt <= right.capturedAt ? left : right;
    }

    function normalizeCanonicalForWrite(value, now){
      var state = emptyAttributionState(now);
      if (!value || typeof value !== 'object') return state;
      state.journeyId = safeClickId(value.journeyId) || state.journeyId;
      state.startedAt = plausibleAttributionDate(value.startedAt, now) || now;
      state.migrationCompletedAt = plausibleAttributionDate(value.migrationCompletedAt, now);
      state.legacyVersions = validLegacyVersions(value.legacyVersions);
      state.firstEntry = storedEntry(value.firstEntry, now);
      state.firstFree = storedEntry(value.firstFree, now);
      var paid = paidRecord(value.lastPaid, value, now, false);
      if (paid && paid.capturedAt && paid.capturedAt + attributionTtlMs <= now) {
        var paidRotation = emptyAttributionState(now);
        paidRotation.migrationCompletedAt = now;
        paidRotation.legacyVersions = state.legacyVersions;
        return paidRotation;
      }
      if ((!paid || !paid.capturedAt) && state.startedAt + attributionTtlMs <= now) {
        var directRotation = emptyAttributionState(now);
        directRotation.migrationCompletedAt = now;
        directRotation.legacyVersions = state.legacyVersions;
        return directRotation;
      }
      if (paid) state.lastPaid = paid;
      state.expiresAt = paid && paid.capturedAt ? paid.capturedAt + attributionTtlMs : 0;
      return state;
    }

    function canonicalValueIsActiveForWrite(value, now){
      if (!value || typeof value !== 'object') return false;
      var paid = paidRecord(value.lastPaid, value, now, false);
      if (paid && paid.capturedAt) return paid.capturedAt + attributionTtlMs > now;
      var startedAt = plausibleAttributionDate(value.startedAt, now);
      return Boolean(startedAt && startedAt + attributionTtlMs > now);
    }

    function migrateAttributionState(now){
      var state = normalizeCanonicalForWrite(storageRecord(canonicalAttributionKey), now);
      var candidates = [];
      if (hasStoredPaid(state.lastPaid)) candidates.push(state.lastPaid);
      legacyAttributionKeys.forEach(function(key){
        var raw;
        try { raw = localStorage.getItem(key); }
        catch (_) { return; }
        var signature = legacyAttributionSignature(raw);
        if (!signature || state.legacyVersions[key] === signature) return;
        var legacy;
        try { legacy = JSON.parse(raw); }
        catch (_) { legacy = null; }
        if (legacy && typeof legacy === 'object') {
          var candidate = paidRecord(legacy, legacy, now, true);
          if (candidate && (!candidate.capturedAt || candidate.capturedAt + attributionTtlMs > now)) {
            candidates.push(candidate);
          }
          var legacyEntry = storedEntry(legacy.firstEntry, now);
          var legacyFree = storedEntry(legacy.firstFree, now);
          if (legacyEntry.capturedAt && legacyEntry.capturedAt + attributionTtlMs > now) {
            state.firstEntry = earlierStoredEntry(state.firstEntry, legacyEntry);
          }
          if (legacyFree.capturedAt && legacyFree.capturedAt + attributionTtlMs > now) {
            state.firstFree = earlierStoredEntry(state.firstFree, legacyFree);
          }
        }
        state.legacyVersions[key] = signature;
        state.migrationCompletedAt = now;
      });
      var dated = candidates.filter(function(candidate){ return candidate.capturedAt > 0; });
      if (dated.length) {
        dated.sort(function(left, right){
          if (left.capturedAt !== right.capturedAt) return right.capturedAt - left.capturedAt;
          return (right.eventId || '') > (left.eventId || '') ? 1 : -1;
        });
        state.lastPaid = dated[0];
      } else if (candidates.length) {
        state.lastPaid = candidates[0];
      }
      state.expiresAt = state.lastPaid && state.lastPaid.capturedAt ?
        state.lastPaid.capturedAt + attributionTtlMs : 0;
      return state;
    }

    function statePaidTime(state){
      return hasStoredPaid(state && state.lastPaid) ? Number(state.lastPaid.capturedAt || 0) : 0;
    }

    function statePaidIsNewer(left, right){
      var leftTime = statePaidTime(left);
      var rightTime = statePaidTime(right);
      if (leftTime !== rightTime) return leftTime > rightTime;
      var leftEvent = left && left.lastPaid && left.lastPaid.eventId || '';
      var rightEvent = right && right.lastPaid && right.lastPaid.eventId || '';
      return leftEvent > rightEvent;
    }

    function mergeWriterStates(state, current){
      if (!current) return state;
      if (current.journeyId === state.journeyId) {
        state.firstEntry = earlierStoredEntry(state.firstEntry, current.firstEntry);
        state.firstFree = earlierStoredEntry(state.firstFree, current.firstFree);
        state.migrationCompletedAt = Math.max(
          state.migrationCompletedAt || 0, current.migrationCompletedAt || 0
        );
        state.legacyVersions = Object.assign({}, current.legacyVersions, state.legacyVersions);
        if (statePaidIsNewer(current, state)) {
          state.lastPaid = current.lastPaid;
          state.expiresAt = current.expiresAt;
          state.legacyVersions = Object.assign({}, state.legacyVersions, current.legacyVersions);
        }
      } else if (statePaidIsNewer(current, state) ||
        (!statePaidTime(state) && Number(current.startedAt || 0) > Number(state.startedAt || 0))) {
        state = current;
      }
      return state;
    }

    function writePaidJournalSync(state, contextPending){
      var eventId = safeClickId(state && state.lastPaid && state.lastPaid.eventId);
      if (!eventId) return false;
      try {
        localStorage.setItem(paidJournalPrefix + eventId, JSON.stringify({
          schemaVersion: 1,
          contextPending: contextPending === true,
          journeyId: state.journeyId,
          startedAt: state.startedAt,
          firstEntry: state.firstEntry,
          firstFree: state.firstFree,
          lastPaid: state.lastPaid
        }));
        return true;
      } catch (_) { return false; }
    }

    function readLatestPaidJournalForWrite(now, excludedEventId){
      var valid = [];
      var removals = [];
      try {
        var length = Number(localStorage.length) || 0;
        var keys = [];
        for (var i = 0; i < length; i++) {
          var key = localStorage.key(i);
          if (typeof key === 'string' && key.indexOf(paidJournalPrefix) === 0) keys.push(key);
        }
        keys.forEach(function(key){
          var record = storageRecord(key);
          var rawPaid = record && record.lastPaid;
          var rawCapturedAt = firstValidTime([
            rawPaid && rawPaid.capturedAt,
            rawPaid && rawPaid.captured_at,
            rawPaid && rawPaid.at
          ], 0);
          // Another tab can race this document in tests or during a clock
          // adjustment. Never delete an entry merely because it appears to be
          // in the future; leave it for a later, plausible read.
          if (rawCapturedAt > now + 5 * 60 * 1000) return;
          var paid = paidRecord(record && record.lastPaid, record, now, false);
          if (paid && paid.eventId === excludedEventId) return;
          if (!paid || !paid.capturedAt || paid.capturedAt + attributionTtlMs <= now) {
            removals.push(key);
            return;
          }
          valid.push({
            journalKey: key,
            contextPending: record.contextPending === true,
            journeyId: safeClickId(record.journeyId),
            startedAt: plausibleAttributionDate(record.startedAt, now),
            firstEntry: storedEntry(record.firstEntry, now),
            firstFree: storedEntry(record.firstFree, now),
            lastPaid: paid,
            expiresAt: paid.capturedAt + attributionTtlMs
          });
        });
        valid.sort(function(left, right){
          if (statePaidIsNewer(left, right)) return -1;
          if (statePaidIsNewer(right, left)) return 1;
          return 0;
        });
        valid.slice(maxPaidJournalEntries).forEach(function(candidate){
          removals.push(candidate.journalKey);
        });
        removals.forEach(function(key){
          try { localStorage.removeItem(key); }
          catch (_) {}
        });
      } catch (_) {}
      var latest = valid[0] || null;
      if (latest && latest.contextPending) {
        var resolved = valid.find(function(candidate){
          return !candidate.contextPending && Boolean(candidate.journeyId);
        });
        if (resolved) latest = Object.assign({}, latest, {
          journeyId: resolved.journeyId,
          startedAt: resolved.startedAt,
          firstEntry: resolved.firstEntry,
          firstFree: resolved.firstFree
        });
      }
      return latest;
    }

    function mergeWriterJournal(state, journal){
      if (!journal) return state;
      var sameJourney = Boolean(state.journeyId && state.journeyId === journal.journeyId);
      if (sameJourney) {
        state.firstEntry = earlierStoredEntry(state.firstEntry, journal.firstEntry);
        state.firstFree = earlierStoredEntry(state.firstFree, journal.firstFree);
      }
      if (!statePaidIsNewer(journal, state)) return state;
      state.journeyId = journal.journeyId || state.journeyId;
      state.startedAt = journal.startedAt || state.startedAt;
      state.firstEntry = sameJourney ? state.firstEntry :
        (journal.firstEntry && Object.keys(journal.firstEntry).length ? journal.firstEntry : state.firstEntry);
      state.firstFree = sameJourney ? state.firstFree :
        (journal.firstFree && Object.keys(journal.firstFree).length ? journal.firstFree : state.firstFree);
      state.lastPaid = journal.lastPaid;
      state.expiresAt = journal.expiresAt;
      return state;
    }

    function paidStateFromTouch(touch){
      return Object.assign(entryFromTouch(touch), {
        clickIds: clickIdsFromTouch(touch),
        capturedAt: touch._time,
        dateUncertain: false,
        eventId: generatedJourneyId()
      });
    }

    function initializeAttributionFallback(){
      var now = Date.now();
      try {
        var state = migrateAttributionState(now);
        state = mergeWriterJournal(state, readLatestPaidJournalForWrite(now, ''));
        var pageTouch = touchFromPage(pageObservedAt);
        if (!state.firstEntry || !Object.keys(state.firstEntry).length) {
          state.firstEntry = entryFromTouch(pageTouch);
        }
        if ((!state.firstFree || !Object.keys(state.firstFree).length) && pageTouch._free) {
          state.firstFree = entryFromTouch(pageTouch);
        }
        if (pageTouch._paid) {
          var pagePaid = paidStateFromTouch(pageTouch);
          var candidate = Object.assign({}, state, {
            lastPaid: pagePaid,
            expiresAt: pageTouch._time + attributionTtlMs
          });
          writePaidJournalSync(candidate, true);
          // A newer journal (or an equal-time click with a higher event ID)
          // must beat an older URL left open in another tab.
          var competingJournal = readLatestPaidJournalForWrite(now, pagePaid.eventId);
          writePaidJournalSync(candidate, false);
          state = statePaidIsNewer(candidate, state) ? candidate : state;
          state = mergeWriterJournal(state, competingJournal);
        }
        var currentRaw = storageRecord(canonicalAttributionKey);
        if (canonicalValueIsActiveForWrite(currentRaw, now)) {
          state = mergeWriterStates(state, normalizeCanonicalForWrite(currentRaw, now));
        }
        state = mergeWriterJournal(state, readLatestPaidJournalForWrite(now, ''));
        state.schemaVersion = 3;
        state.writer = 'pmp-storefront-fallback-v3';
        state.expiresAt = state.lastPaid && state.lastPaid.capturedAt ?
          state.lastPaid.capturedAt + attributionTtlMs : 0;
        localStorage.setItem(canonicalAttributionKey, JSON.stringify(state));
      } catch (_) {}
    }

    function sanitizeBodyIdentifiers(body){
      ['gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'ttclid', 'msclkid', 'sccid'].forEach(function(key){
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

    function clearTouchFields(body, prefix){
      [
        'landing_url', 'referrer', 'source', 'medium', 'campaign', 'content', 'term', 'at',
        'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'ttclid', 'msclkid', 'sccid', 'fbc'
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
      if (touch.gclid || touch.gbraid || touch.wbraid || touch.dclid || /google/.test(source)) return 'google';
      if (touch.msclkid || /microsoft|bing/.test(source)) return 'microsoft';
      if (touch.ttclid || /tiktok/.test(source)) return 'tiktok';
      if (touch.sccid || /snapchat|\bsnap\b/.test(source)) return 'snapchat';
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
      sanitizeBodyIdentifiers(body);
      var now = Date.now();
      var suppliedPaid = paidTouchFromBody(body, now);
      // journey_id is accepted only from the canonical Custom Pixel record.
      // A stale or forged value supplied by another theme script must not pass.
      delete body.journey_id;
      Object.keys(body).forEach(function(key){
        if (/^first_free_/.test(key) || /^last_paid_/.test(key)) delete body[key];
      });
      // Capture already ran once at document initialization. Checkout performs
      // only reads so opening checkout cannot renew or replace a paid window.
      var state = readCanonicalAttribution(now);
      var journalState = readPaidJournalAttribution(now);
      var pageTouch = touchFromPage(pageObservedAt);
      var pagePaid = pageTouch && pageTouch._paid && pageTouch._time + attributionTtlMs > now ? pageTouch : null;
      var legacyPaid = readLegacyPaidAttribution(now);
      var storedPaid = latestPaidTouch([state && state.lastPaid, journalState && journalState.lastPaid, legacyPaid]);
      var contextState = mergedContextState(state, journalState);
      var paid = latestPaidTouch([storedPaid, pagePaid]) || suppliedPaid;
      sanitizeBodyAttributionText(body);

      body.attribution_model = attributionModel;
      if (contextState && contextState.journeyId) body.journey_id = contextState.journeyId;
      injectTouchFields(body, 'first_entry', contextState && contextState.firstEntry);
      injectTouchFields(body, 'first_touch', contextState && contextState.firstFree);
      injectTouchFields(body, 'last_touch', paid);

      var sessionTouch = pageTouch;
      body.landing_url = sessionTouch.landing_url || attributionUrl(location.href);
      body.referrer = sessionTouch.referrer || '';

      var existingFbc = safeFacebookCookie(body.fbc, 'fbc');
      var existingFbp = safeFacebookCookie(body.fbp, 'fbp');
      ['gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'ttclid', 'msclkid', 'sccid'].forEach(function(key){ delete body[key]; });
      delete body.fbc;
      var platform = paidPlatform(paid);
      if (paid) {
        ['gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'ttclid', 'msclkid', 'sccid'].forEach(function(key){
          var clean = safeClickId(paid[key]);
          if (clean) body[key] = clean;
        });
        if (platform === 'meta') {
          var paidFbc = safeFacebookCookie(paid.fbc, 'fbc') ||
            derivedFbc(paid.fbclid, paid) || existingFbc;
          if (paidFbc) body.fbc = paidFbc;
        }
      }
      if (existingFbp) body.fbp = existingFbp;
    }

    // Run once per document behind __pmpCheckoutCountryBridge. This first-party
    // order attribution must remain available in every Shopify market. The
    // Customer Events privacy setting controls the Custom Pixel separately.
    initializeAttributionFallback();

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

    // Google may have loaded before this helper or may define gtag later.
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

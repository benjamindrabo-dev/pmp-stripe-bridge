// Shopify Custom Pixel name: PMP Paid Attribution
// Paste this complete file into Settings -> Customer events -> Add custom pixel.
// This code deliberately uses Shopify's sandboxed, asynchronous browser API.
(function () {
  "use strict";

  var KEY = "pmp:attribution";
  var PAID_JOURNAL_PREFIX = "pmp:attribution:paid:";
  var LEGACY_KEYS = ["pmp_paid_attribution_v3", "pmp:attribution:v1"];
  var CLICK_KEYS = ["gclid", "gbraid", "wbraid", "dclid", "fbclid", "msclkid", "ttclid", "sccid"];
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
  var TTL_MS = 90 * 24 * 60 * 60 * 1000;
  var MAX_PAID_JOURNAL_ENTRIES = 64;
  var MIN_DATE_MS = Date.UTC(2020, 0, 1);
  var writeQueue = Promise.resolve();

  function numberDate(value) {
    var result = 0;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) result = value;
    else if (typeof value === "string" && value.trim()) {
      var numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) result = numeric;
      else {
        var parsed = Date.parse(value);
        if (Number.isFinite(parsed) && parsed > 0) result = parsed;
      }
    }
    // A few legacy writers used Unix seconds instead of milliseconds.
    if (result > 0 && result < 100000000000) result *= 1000;
    return result;
  }

  function plausibleDate(value, now) {
    var parsed = numberDate(value);
    return parsed >= MIN_DATE_MS && parsed <= now + 5 * 60 * 1000 ? parsed : 0;
  }

  function safeId(value) {
    var clean = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z0-9][A-Za-z0-9._~-]{5,254}$/.test(clean) ? clean : "";
  }

  function decodedText(value) {
    var decoded = String(value == null ? "" : value);
    for (var i = 0; i < 2; i += 1) {
      try {
        var next = decodeURIComponent(decoded.replace(/\+/g, "%20"));
        if (next === decoded) break;
        decoded = next;
      } catch (_) { break; }
    }
    return decoded;
  }

  function containsEmail(value) {
    return /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i.test(decodedText(value));
  }

  function safeCampaignValue(value, max) {
    var clean = typeof value === "string" ? value.trim()
      .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ") : "";
    if (!clean || containsEmail(clean)) return "";
    return clean.slice(0, max || 200);
  }

  function firstSafeId(values) {
    for (var i = 0; i < values.length; i += 1) {
      var clean = safeId(values[i]);
      if (clean) return clean;
    }
    return "";
  }

  function firstDate(values, now) {
    for (var i = 0; i < values.length; i += 1) {
      var parsed = plausibleDate(values[i], now);
      if (parsed) return parsed;
    }
    return 0;
  }

  function firstCampaign(values, max) {
    for (var i = 0; i < values.length; i += 1) {
      var clean = safeCampaignValue(values[i], max);
      if (clean) return clean;
    }
    return "";
  }

  function firstUrl(values) {
    for (var i = 0; i < values.length; i += 1) {
      var clean = cleanUrl(values[i]);
      if (clean) return clean;
    }
    return "";
  }

  function safePath(pathname) {
    var decoded = decodedText(pathname || "/");
    if (containsEmail(decoded)) return "/";
    var segments = decoded.split("/").filter(Boolean);
    var offset = segments[0] && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0]) ? 1 : 0;
    var prefix = offset ? "/" + segments[0].toLowerCase() + "/" : "/";
    if (segments.length === offset) return prefix;
    var root = segments[offset].toLowerCase();
    if (["products", "collections", "pages", "blogs", "search"].indexOf(root) !== -1) return pathname;
    if (root === "cart") return prefix + "cart";
    // Checkout, order-status, account and app paths can contain opaque customer
    // or pre-authentication tokens. Their exact path is not needed for attribution.
    return prefix;
  }

  function clickIdsFrom(value) {
    var source = value && typeof value === "object" ? value : {};
    var ids = {};
    CLICK_KEYS.forEach(function (key) {
      var clean = firstSafeId([source[key], source.clickIds && source.clickIds[key]]);
      if (clean) ids[key] = clean;
    });
    return ids;
  }

  function hasIds(ids) { return Object.keys(ids || {}).length > 0; }

  function hasPaidRecord(value) {
    return Boolean(value && (hasIds(value.clickIds) || paidMedium(value.medium)));
  }

  function cleanUrl(value) {
    try {
      var url = new URL(String(value || ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      url.username = "";
      url.password = "";
      url.hash = "";
      url.pathname = safePath(url.pathname);

      // Rebuild the query from a strict allowlist. This prevents customer data,
      // search terms and arbitrary app parameters from entering persistent storage.
      var retained = [];
      Array.from(url.searchParams.entries()).forEach(function (pair) {
        var key = pair[0].toLowerCase();
        var value = pair[1];
        if (CLICK_KEYS.indexOf(key) !== -1) {
          var click = safeId(value);
          if (click) retained.push([key, click]);
        } else if (UTM_KEYS.indexOf(key) !== -1) {
          var campaign = safeCampaignValue(value, 200);
          if (campaign) retained.push([key, campaign]);
        }
      });
      url.search = "";
      retained.forEach(function (pair) { url.searchParams.append(pair[0], pair[1]); });
      return url.toString().slice(0, 1500);
    } catch (_) { return ""; }
  }

  function journeyId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "pmp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 14);
  }

  function emptyState(now) {
    return {
      schemaVersion: 3,
      journeyId: journeyId(),
      startedAt: now,
      migrationCompletedAt: 0,
      legacyVersions: {},
      expiresAt: 0,
      firstEntry: {},
      firstFree: {},
      lastPaid: {},
      writer: "pmp-custom-pixel"
    };
  }

  function parse(raw) {
    if (!raw) return null;
    try { var value = JSON.parse(raw); return value && typeof value === "object" ? value : null; }
    catch (_) { return null; }
  }

  function normalizedEntry(value, now) {
    if (!value || typeof value !== "object") return {};
    var landingUrl = firstUrl([value.landingUrl, value.landing_url, value.landing]);
    var capturedAt = firstDate([value.capturedAt, value.captured_at, value.at], now);
    var entry = {
      landingUrl: landingUrl,
      referrer: firstUrl([value.referrer]),
      source: firstCampaign([value.source, value.utm_source], 100),
      medium: firstCampaign([value.medium, value.utm_medium], 100),
      campaign: firstCampaign([value.campaign, value.utm_campaign], 200),
      content: firstCampaign([value.content, value.utm_content], 200),
      term: firstCampaign([value.term, value.utm_term], 200),
      capturedAt: capturedAt
    };
    if (!landingUrl && !entry.referrer && !entry.source && !entry.medium && !entry.campaign && !capturedAt) return {};
    return entry;
  }

  function paidCandidate(value, now, migrated) {
    if (!value || typeof value !== "object") return null;
    var paid = value.lastPaid && typeof value.lastPaid === "object" ? value.lastPaid : value;
    var ids = clickIdsFrom(paid);
    var capturedAt = firstDate([paid.capturedAt, paid.captured_at, paid.at, value.capturedAt, value.captured_at, value.at], now);
    var result = Object.assign(normalizedEntry({
      landingUrl: firstUrl([paid.landingUrl, paid.landing_url, value.landingUrl, value.landing_url]),
      referrer: paid.referrer || value.referrer,
      source: firstCampaign([paid.source, paid.utm_source, value.source, value.utm_source], 100),
      medium: firstCampaign([paid.medium, paid.utm_medium, value.medium, value.utm_medium], 100),
      campaign: firstCampaign([paid.campaign, paid.utm_campaign, value.campaign, value.utm_campaign], 200),
      content: firstCampaign([paid.content, paid.utm_content, value.content, value.utm_content], 200),
      term: firstCampaign([paid.term, paid.utm_term, value.term, value.utm_term], 200),
      capturedAt: capturedAt
    }, now), {
      clickIds: ids,
      capturedAt: capturedAt,
      dateUncertain: capturedAt === 0,
      eventId: safeId(paid.eventId)
    });
    if (!hasIds(ids) && !paidMedium(result.medium)) return null;
    if (migrated || paid.migrated === true) result.migrated = true;
    return result;
  }

  function canonicalValueIsActive(value, now) {
    if (!value || typeof value !== "object") return false;
    var paid = paidCandidate(value.lastPaid, now, false);
    if (paid && paid.capturedAt) return paid.capturedAt + TTL_MS > now;
    var startedAt = plausibleDate(value.startedAt, now);
    return Boolean(startedAt && startedAt + TTL_MS > now);
  }

  function legacySignature(raw) {
    if (typeof raw !== "string" || !raw) return "";
    // FNV-1a is only a compact change detector; this is not a security boundary.
    var hash = 2166136261;
    for (var i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return raw.length.toString(36) + "-" + (hash >>> 0).toString(36);
  }

  function normalizedLegacyVersions(value) {
    var versions = {};
    var source = value && typeof value === "object" ? value : {};
    LEGACY_KEYS.forEach(function (key) {
      var signature = typeof source[key] === "string" ? source[key].slice(0, 40) : "";
      if (/^[a-z0-9]+-[a-z0-9]+$/i.test(signature)) versions[key] = signature;
    });
    return versions;
  }

  function normalizeCanonical(value, now) {
    var state = emptyState(now);
    if (!value || typeof value !== "object") return state;
    state.journeyId = safeId(value.journeyId) || state.journeyId;
    state.startedAt = plausibleDate(value.startedAt, now) || now;
    state.migrationCompletedAt = plausibleDate(value.migrationCompletedAt, now);
    state.legacyVersions = normalizedLegacyVersions(value.legacyVersions);
    state.firstEntry = normalizedEntry(value.firstEntry, now);
    state.firstFree = normalizedEntry(value.firstFree, now);
    var paid = paidCandidate(value.lastPaid, now, false);
    // Once a reliably dated paid journey expires, start a fresh journey rather
    // than correlating future direct traffic with an attribution older than 90 days.
    if (paid && paid.capturedAt && paid.capturedAt + TTL_MS <= now) {
      var paidRotation = emptyState(now);
      paidRotation.migrationCompletedAt = now;
      paidRotation.legacyVersions = state.legacyVersions;
      return paidRotation;
    }
    if ((!paid || !paid.capturedAt) && state.startedAt + TTL_MS <= now) {
      var directRotation = emptyState(now);
      directRotation.migrationCompletedAt = now;
      directRotation.legacyVersions = state.legacyVersions;
      return directRotation;
    }
    if (paid) state.lastPaid = paid;
    state.expiresAt = paid && paid.capturedAt ? paid.capturedAt + TTL_MS : 0;
    return state;
  }

  function earlierEntry(a, b) {
    if (!a || !Object.keys(a).length) return b || {};
    if (!b || !Object.keys(b).length) return a;
    if (!a.capturedAt) return b.capturedAt ? b : a;
    if (!b.capturedAt) return a;
    return a.capturedAt <= b.capturedAt ? a : b;
  }

  async function migrate(now) {
    var state = normalizeCanonical(parse(await browser.localStorage.getItem(KEY)), now);
    var candidates = [];
    if (hasPaidRecord(state.lastPaid)) candidates.push(state.lastPaid);
    for (var i = 0; i < LEGACY_KEYS.length; i += 1) {
      var key = LEGACY_KEYS[i];
      var raw = await browser.localStorage.getItem(key);
      var signature = legacySignature(raw);
      if (!signature || state.legacyVersions[key] === signature) continue;
      var legacy = parse(raw);
      var candidate = paidCandidate(legacy, now, true);
      if (candidate && (!candidate.capturedAt || candidate.capturedAt + TTL_MS > now)) candidates.push(candidate);

      // Only dated, still-active context can join the new 90-day journey.
      if (legacy && typeof legacy === "object") {
        var legacyEntry = normalizedEntry(legacy.firstEntry, now);
        var legacyFree = normalizedEntry(legacy.firstFree, now);
        if (legacyEntry.capturedAt && legacyEntry.capturedAt + TTL_MS > now) {
          state.firstEntry = earlierEntry(state.firstEntry, legacyEntry);
        }
        if (legacyFree.capturedAt && legacyFree.capturedAt + TTL_MS > now) {
          state.firstFree = earlierEntry(state.firstFree, legacyFree);
        }
      }
      state.legacyVersions[key] = signature;
      state.migrationCompletedAt = now;
    }
    var dated = candidates.filter(function (item) { return item.capturedAt > 0; });
    if (dated.length) {
      dated.sort(function (a, b) { return b.capturedAt - a.capturedAt; });
      state.lastPaid = dated[0];
    } else if (candidates.length) {
      // Preserve an undated legacy signal, but expiresAt=0 prevents pretending
      // it received a fresh 90-day window. A subsequent real click replaces it.
      state.lastPaid = candidates[0];
    }
    state.expiresAt = state.lastPaid.capturedAt ? state.lastPaid.capturedAt + TTL_MS : 0;
    return state;
  }

  function paidTime(state) {
    return hasPaidRecord(state && state.lastPaid) ? Number(state.lastPaid.capturedAt || 0) : 0;
  }

  function paidIsNewer(left, right) {
    var leftTime = paidTime(left);
    var rightTime = paidTime(right);
    if (leftTime !== rightTime) return leftTime > rightTime;
    var leftId = left && left.lastPaid && left.lastPaid.eventId || "";
    var rightId = right && right.lastPaid && right.lastPaid.eventId || "";
    return leftId > rightId;
  }

  async function writePaidJournal(state, contextPending) {
    var eventId = safeId(state && state.lastPaid && state.lastPaid.eventId);
    if (!eventId) return false;
    var record = {
      schemaVersion: 1,
      contextPending: contextPending === true,
      journeyId: state.journeyId,
      startedAt: state.startedAt,
      firstEntry: state.firstEntry,
      firstFree: state.firstFree,
      lastPaid: state.lastPaid
    };
    try {
      await browser.localStorage.setItem(PAID_JOURNAL_PREFIX + eventId, JSON.stringify(record));
      return true;
    } catch (_) { return false; }
  }

  async function readLatestPaidJournal(now, excludedEventId, scanStatus) {
    var valid = [];
    var expiredKeys = [];
    try {
      var length = await browser.localStorage.length();
      var keys = [];
      for (var i = 0; i < length; i += 1) {
        var key = await browser.localStorage.key(i);
        if (typeof key === "string" && key.indexOf(PAID_JOURNAL_PREFIX) === 0) keys.push(key);
      }
      for (var j = 0; j < keys.length; j += 1) {
        var record = parse(await browser.localStorage.getItem(keys[j]));
        var paid = paidCandidate(record && record.lastPaid, now, false);
        if (paid && paid.eventId && paid.eventId === excludedEventId) continue;
        if (!paid || !paid.capturedAt || paid.capturedAt + TTL_MS <= now) {
          expiredKeys.push(keys[j]);
          continue;
        }
        var candidate = {
          journalKey: keys[j],
          contextPending: record.contextPending === true,
          journeyId: safeId(record.journeyId),
          startedAt: plausibleDate(record.startedAt, now),
          firstEntry: normalizedEntry(record.firstEntry, now),
          firstFree: normalizedEntry(record.firstFree, now),
          lastPaid: paid,
          expiresAt: paid.capturedAt + TTL_MS
        };
        valid.push(candidate);
      }
      valid.sort(function (left, right) {
        if (paidIsNewer(left, right)) return -1;
        if (paidIsNewer(right, left)) return 1;
        return 0;
      });
      valid.slice(MAX_PAID_JOURNAL_ENTRIES).forEach(function (candidate) {
        expiredKeys.push(candidate.journalKey);
      });
      for (var k = 0; k < expiredKeys.length; k += 1) {
        await browser.localStorage.removeItem(expiredKeys[k]);
      }
      if (scanStatus) scanStatus.ok = true;
    } catch (_) {}
    var latest = valid[0] || null;
    if (latest && latest.contextPending) {
      var resolved = valid.find(function (candidate) {
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

  function mergeJournal(state, journal) {
    if (!journal || !paidIsNewer(journal, state)) return state;
    var sameJourney = Boolean(state.journeyId && state.journeyId === journal.journeyId);
    state.journeyId = journal.journeyId || state.journeyId;
    state.startedAt = journal.startedAt || state.startedAt;
    state.firstEntry = sameJourney ? earlierEntry(state.firstEntry, journal.firstEntry) :
      (journal.firstEntry && Object.keys(journal.firstEntry).length ? journal.firstEntry : state.firstEntry);
    state.firstFree = sameJourney ? earlierEntry(state.firstFree, journal.firstFree) :
      (journal.firstFree && Object.keys(journal.firstFree).length ? journal.firstFree : state.firstFree);
    state.lastPaid = journal.lastPaid;
    state.expiresAt = journal.expiresAt;
    return state;
  }

  function mergeStates(state, current) {
    if (current.journeyId === state.journeyId) {
      state.firstEntry = earlierEntry(state.firstEntry, current.firstEntry);
      state.firstFree = earlierEntry(state.firstFree, current.firstFree);
      state.migrationCompletedAt = Math.max(state.migrationCompletedAt || 0, current.migrationCompletedAt || 0);
      state.legacyVersions = Object.assign({}, current.legacyVersions, state.legacyVersions);
      if (paidIsNewer(current, state)) {
        state.lastPaid = current.lastPaid;
        state.expiresAt = current.expiresAt;
        state.legacyVersions = Object.assign({}, state.legacyVersions, current.legacyVersions);
      }
    } else if (paidIsNewer(current, state) ||
      (!paidTime(state) && Number(current.startedAt || 0) > Number(state.startedAt || 0))) {
      state = current;
    }
    return state;
  }

  function settle(delay) {
    return new Promise(function (resolve) { setTimeout(resolve, delay); });
  }

  async function persistWithReconciliation(state) {
    // Write the current click immediately so navigation-away does not wait for
    // journal enumeration. Two delayed rounds then reconcile concurrent tabs.
    var currentValue = parse(await browser.localStorage.getItem(KEY));
    var currentNow = Date.now();
    if (canonicalValueIsActive(currentValue, currentNow)) {
      state = mergeStates(state, normalizeCanonical(currentValue, currentNow));
    }
    state.schemaVersion = 3;
    state.writer = "pmp-custom-pixel";
    await browser.localStorage.setItem(KEY, JSON.stringify(state));
    var delays = [25, 100];
    for (var i = 0; i < delays.length; i += 1) {
      await settle(delays[i]);
      var currentValue = parse(await browser.localStorage.getItem(KEY));
      var currentNow = Date.now();
      if (canonicalValueIsActive(currentValue, currentNow)) {
        state = mergeStates(state, normalizeCanonical(currentValue, currentNow));
      }
      state = mergeJournal(state, await readLatestPaidJournal(Date.now()));
      state.schemaVersion = 3;
      state.writer = "pmp-custom-pixel";
      await browser.localStorage.setItem(KEY, JSON.stringify(state));
    }
  }

  function eventUrl(event) {
    return event && event.context && event.context.document && event.context.document.location &&
      event.context.document.location.href || "";
  }

  function eventReferrer(event) {
    return event && event.context && event.context.document && event.context.document.referrer || "";
  }

  function normalizedToken(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  }

  function paidMedium(value) {
    return ["paid", "cpc", "ppc", "paid_social", "paid_search", "paidsearch", "sem", "display",
      "retargeting", "remarketing", "cpm"].indexOf(normalizedToken(value)) !== -1;
  }

  function safeExternalReferrer(value, pageUrl) {
    var referrer = cleanUrl(value);
    if (!referrer) return "";
    try {
      var ref = new URL(referrer);
      var page = new URL(pageUrl);
      return ref.hostname.replace(/^www\./, "").toLowerCase() ===
        page.hostname.replace(/^www\./, "").toLowerCase() ? "" : referrer;
    } catch (_) { return ""; }
  }

  function inferredSource(referrer) {
    if (!referrer) return { source: "direct", medium: "none" };
    try {
      var host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
      if (/(^|\.)google\./.test(host)) return { source: "google", medium: "organic" };
      if (/(^|\.)bing\.com$/.test(host)) return { source: "bing", medium: "organic" };
      if (/(^|\.)yahoo\./.test(host)) return { source: "yahoo", medium: "organic" };
      if (/(^|\.)instagram\.com$/.test(host)) return { source: "instagram", medium: "organic_social" };
      if (/(^|\.)(facebook|fb)\.com$/.test(host)) return { source: "facebook", medium: "organic_social" };
      if (/(^|\.)tiktok\.com$/.test(host)) return { source: "tiktok", medium: "organic_social" };
      return { source: host.slice(0, 100), medium: "referral" };
    } catch (_) { return { source: "direct", medium: "none" }; }
  }

  function pageTouch(event, rawUrl, now) {
    var landingUrl = cleanUrl(rawUrl);
    var ids = {};
    var params;
    try { params = new URL(rawUrl).searchParams; }
    catch (_) { params = new URLSearchParams(""); }
    CLICK_KEYS.forEach(function (key) { var id = safeId(params.get(key)); if (id) ids[key] = id; });
    var referrer = safeExternalReferrer(eventReferrer(event), rawUrl);
    var inferred = inferredSource(referrer);
    var source = safeCampaignValue(params.get("utm_source"), 100);
    var medium = safeCampaignValue(params.get("utm_medium"), 100);
    var campaign = safeCampaignValue(params.get("utm_campaign"), 200);
    var content = safeCampaignValue(params.get("utm_content"), 200);
    var term = safeCampaignValue(params.get("utm_term"), 200);
    if (!source) {
      if (ids.gclid || ids.gbraid || ids.wbraid || ids.dclid) source = "google";
      else if (ids.fbclid) source = "meta";
      else if (ids.msclkid) source = "microsoft";
      else if (ids.ttclid) source = "tiktok";
      else if (ids.sccid) source = "snapchat";
      else source = inferred.source;
    }
    if (!medium) medium = hasIds(ids) ? "cpc" : inferred.medium;
    var entry = {
      landingUrl: landingUrl,
      referrer: referrer,
      source: source,
      medium: medium,
      campaign: campaign,
      content: content,
      term: term,
      capturedAt: now
    };
    var paid = hasIds(ids) || paidMedium(medium);
    var sourceToken = normalizedToken(source);
    var mediumToken = normalizedToken(medium);
    var identifiableFree = !paid && Boolean(referrer || campaign ||
      (sourceToken && sourceToken !== "direct") || (mediumToken && mediumToken !== "none"));
    return { entry: entry, clickIds: ids, paid: paid, free: identifiableFree };
  }

  function eventTime(event, fallback) {
    return plausibleDate(event && event.timestamp, fallback) || fallback;
  }

  async function capture(event) {
    var wallNow = Date.now();
    var now = eventTime(event, wallNow);
    var state = await migrate(wallNow); // Migration always precedes the visit write.
    var rawUrl = eventUrl(event);
    var touch = pageTouch(event, rawUrl, now);
    if (!state.firstEntry || !Object.keys(state.firstEntry).length) {
      state.firstEntry = touch.entry;
    }
    if ((!state.firstFree || !Object.keys(state.firstFree).length) && touch.free) {
      state.firstFree = touch.entry;
    }
    if (touch.paid) {
      var priorState = Object.assign({}, state);
      state.lastPaid = Object.assign({ clickIds: touch.clickIds, eventId: journeyId() }, touch.entry);
      state.expiresAt = now + TTL_MS;
      // Protect the click before any key enumeration. If the page unloads while
      // context is still pending, the bridge can combine this click with the
      // immediately preceding journal journey.
      var journalWritten = await writePaidJournal(state, true);
      if (journalWritten) {
        var scanStatus = { ok: false };
        var priorJournal = await readLatestPaidJournal(wallNow, state.lastPaid.eventId, scanStatus);
        var paidRecord = state.lastPaid;
        state = mergeJournal(priorState, priorJournal);
        state.lastPaid = paidRecord;
        state.expiresAt = now + TTL_MS;
        if (scanStatus.ok) await writePaidJournal(state, false);
      }
    }

    // Shopify exposes no atomic compare-and-swap for sandbox storage. The
    // per-runtime queue serializes local events and bounded repair rounds make
    // simultaneously stale tabs converge on the newest dated paid click.
    await persistWithReconciliation(state);
  }

  analytics.subscribe("page_viewed", function (event) {
    writeQueue = writeQueue.then(function () { return capture(event); }).catch(function () {});
  });
  // These subscriptions intentionally perform no duplicate network send. They
  // make the native Shopify checkout lifecycle available for future consumers;
  // this shop currently creates its order through the external Stripe bridge.
  analytics.subscribe("checkout_started", function () {});
  analytics.subscribe("checkout_completed", function () {});
})();

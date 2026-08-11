// GET /api/ga4-retry?key=<GA4_RETRY_KEY|BACKFILL_KEY>[&max=25][&validate=1][&session=cs_...]
//
// Retry endpoint for the GA4 Measurement Protocol outbox written by
// api/stripe-webhook.js. The webhook drains at most 3 entries per invocation;
// this endpoint lets a human (or, later, a cron) catch up in bulk.
//
// Outbox schema (Upstash Redis, REST API):
//   ga4:<stripe_session_id>  JSON { session_id, payload, status, attempts,
//                                  first_seen_at, sent_at?, last_error? }
//                            status ∈ pending | sent | expired.  TTL 4 days.
//   ga4:queue                LIST of pending stripe session ids (never SCAN).
//
// GA4 drops events backdated by more than 72h, so an entry older than that is
// marked `expired` and abandoned instead of being retried forever.
//
// validate=1 does NOT send anything: it posts each pending payload to
//   https://www.google-analytics.com/debug/mp/collect
// with validationBehavior "ENFORCE_RECOMMENDATIONS" and returns the raw
// validationMessages. That is the objective way to settle whether
// engagement_time_msec belongs on this server-side purchase event.
//
// Protection is modelled on api/capi-backfill.js: a shared-secret query key.
// It uses GA4_RETRY_KEY when that variable exists, and otherwise falls back to
// the already-provisioned BACKFILL_KEY. There is deliberately NO kill switch
// equivalent to ENABLE_BACKFILL: replaying this outbox is idempotent-safe
// (transaction_id is the Stripe session id, GA4 de-dupes on it), and the whole
// point is that it stays available when a conversion needs rescuing.

const GA4_OUTBOX_TTL = 345600;           // 4 days
const GA4_QUEUE_KEY = "ga4:queue";
const GA4_MAX_AGE_MS = 72 * 3600 * 1000; // GA4 backdating limit

async function redisCommand(command) {
  const r = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || typeof j !== "object" || "error" in j) {
    throw new Error("Upstash command failed: " + r.status + " " + JSON.stringify(j || {}).slice(0, 200));
  }
  return j.result;
}

async function kvGet(key) {
  const result = await redisCommand(["GET", key]);
  return result ? JSON.parse(result) : null;
}
async function kvSet(key, value, ttlSeconds) {
  const result = await redisCommand(["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]);
  if (result !== "OK") throw new Error("Upstash SET was not acknowledged");
}
async function kvRPush(key, member) { return redisCommand(["RPUSH", key, String(member)]); }
async function kvLPop(key) { return redisCommand(["LPOP", key]); }
async function kvLLen(key) { return Number(await redisCommand(["LLEN", key])) || 0; }

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function ga4Post(payload, { validate = false } = {}) {
  const measurementId = process.env.GA4_MEASUREMENT_ID;
  const apiSecret = process.env.GA4_API_SECRET;
  if (!measurementId || !apiSecret) throw new Error("GA4_MEASUREMENT_ID / GA4_API_SECRET not set");
  const base = validate
    ? "https://www.google-analytics.com/debug/mp/collect"
    : "https://www.google-analytics.com/mp/collect";
  const body = validate ? { ...payload, validationBehavior: "ENFORCE_RECOMMENDATIONS" } : payload;
  const r = await fetchWithTimeout(
    `${base}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    8000
  );
  let json = null;
  if (validate) json = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, json };
}

async function trySend(entry) {
  const key = `ga4:${entry.session_id}`;
  const micros = Number(entry.payload && entry.payload.timestamp_micros) || 0;
  if (micros > 0 && Date.now() - micros / 1000 > GA4_MAX_AGE_MS) {
    entry.status = "expired";
    entry.last_error = "older than GA4's 72h backdating limit — abandoned";
    await kvSet(key, entry, GA4_OUTBOX_TTL);
    return entry;
  }
  try {
    const r = await ga4Post(entry.payload);
    if (!r.ok) throw new Error("Measurement Protocol HTTP " + r.status);
    entry.status = "sent";
    entry.sent_at = Date.now();
    delete entry.last_error;
  } catch (e) {
    entry.status = "pending";
    entry.attempts = (Number(entry.attempts) || 0) + 1;
    entry.last_error = String((e && e.message) || e).slice(0, 200);
  }
  await kvSet(key, entry, GA4_OUTBOX_TTL);
  return entry;
}

export default async function handler(req, res) {
  const q = req.query || {};
  const expected = process.env.GA4_RETRY_KEY || process.env.BACKFILL_KEY;
  if (!expected || q.key !== expected) {
    return res.status(403).json({ error: "Forbidden (set GA4_RETRY_KEY or BACKFILL_KEY and pass ?key=)" });
  }

  const validate = q.validate === "1" || q.validate === "true";
  const max = Math.max(1, Math.min(100, Number(q.max) || 25));
  const budgetMs = 20000;
  const startedAt = Date.now();

  try {
    // Single-session mode: inspect / retry / validate one specific payload.
    if (q.session) {
      const entry = await kvGet(`ga4:${q.session}`);
      if (!entry) return res.status(404).json({ error: "no outbox entry", session: String(q.session) });
      if (validate) {
        const r = await ga4Post(entry.payload, { validate: true });
        return res.status(200).json({
          mode: "validate", session: entry.session_id, status: entry.status, attempts: entry.attempts,
          httpStatus: r.status, validationMessages: (r.json && r.json.validationMessages) || [], debugResponse: r.json,
          payload: entry.payload,
        });
      }
      const out = await trySend(entry);
      return res.status(200).json({ mode: "retry", session: out.session_id, status: out.status, attempts: out.attempts, last_error: out.last_error || null });
    }

    // Validation mode: never sends real events, only reports what GA4 thinks.
    if (validate) {
      const reports = [];
      const requeue = [];
      while (reports.length < max && Date.now() - startedAt < budgetMs) {
        const id = await kvLPop(GA4_QUEUE_KEY);
        if (!id) break;
        requeue.push(id);
        const entry = await kvGet(`ga4:${id}`);
        if (!entry) continue;
        const r = await ga4Post(entry.payload, { validate: true });
        reports.push({
          session: entry.session_id, status: entry.status, attempts: entry.attempts,
          httpStatus: r.status,
          validationMessages: (r.json && r.json.validationMessages) || [],
        });
      }
      // Validation must not consume the queue: everything popped goes back.
      for (const id of requeue) await kvRPush(GA4_QUEUE_KEY, id);
      return res.status(200).json({
        mode: "validate", validationBehavior: "ENFORCE_RECOMMENDATIONS",
        inspected: reports.length, queueLength: await kvLLen(GA4_QUEUE_KEY), reports,
      });
    }

    // Drain mode.
    const summary = { popped: 0, sent: 0, failed: 0, expired: 0, skipped: 0 };
    const details = [];
    while (summary.popped < max && Date.now() - startedAt < budgetMs) {
      const id = await kvLPop(GA4_QUEUE_KEY);
      if (!id) break;
      summary.popped += 1;
      const entry = await kvGet(`ga4:${id}`);
      if (!entry || entry.status === "sent" || entry.status === "expired") { summary.skipped += 1; continue; }
      const out = await trySend(entry);
      if (out.status === "sent") summary.sent += 1;
      else if (out.status === "expired") summary.expired += 1;
      else { summary.failed += 1; await kvRPush(GA4_QUEUE_KEY, String(id)); }
      details.push({ session: out.session_id, status: out.status, attempts: out.attempts, last_error: out.last_error || null });
    }
    return res.status(200).json({
      mode: "drain", ...summary, queueLength: await kvLLen(GA4_QUEUE_KEY),
      elapsedMs: Date.now() - startedAt, details,
    });
  } catch (e) {
    console.error("ga4-retry error", e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}

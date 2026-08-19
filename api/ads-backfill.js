// api/ads-backfill.js
//
// Uploads paid Stripe Checkout Sessions to Google Ads as offline conversions.
//
// Why a backfill instead of a hook inside stripe-webhook.js: the webhook is the
// payment path. Nothing that can fail should be added to it, and Google Ads has
// no real-time requirement — offline conversions are accepted up to 90 days
// after the click. This mirrors the existing capi-backfill.js / ga4-retry.js
// pattern already used in this project.
//
// create-checkout.js already writes gclid / gbraid / wbraid into
// session.metadata, so every ad-attributed order is recoverable from Stripe
// alone. Nothing else in the codebase needs to change.
//
// Idempotency: an Upstash key per Stripe session id, TTL 90 days. Google also
// dedupes on orderId, so a double send is harmless — this just avoids the call.

import { uploadPurchase, adsConfigured } from "./google-ads-lib.js";

const LOOKBACK_HOURS = 48;   // comfortably covers a missed cron run
const MAX_PER_RUN = 100;     // Stripe page size; keeps the run well under the timeout
const DEDUPE_TTL = 60 * 60 * 24 * 90;

async function redis(command) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`redis_failed status=${res.status}`);
  return (await res.json()).result;
}

// SET key value NX EX ttl -> "OK" when we won the claim, null when already done.
async function claim(sessionId) {
  const result = await redis([
    "SET", `ads:sent:${sessionId}`, "1", "NX", "EX", String(DEDUPE_TTL),
  ]);
  return result === "OK";
}

async function release(sessionId) {
  try {
    await redis(["DEL", `ads:sent:${sessionId}`]);
  } catch (_) {
    // A stuck claim only costs one missed conversion; never throw from cleanup.
  }
}

async function listRecentSessions() {
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_HOURS * 3600;
  const params = new URLSearchParams({
    limit: String(MAX_PER_RUN),
    "created[gte]": String(since),
  });

  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`stripe_list_failed status=${res.status} ${detail.slice(0, 300)}`);
  }

  return (await res.json()).data || [];
}

export default async function handler(req, res) {
  // Vercel cron sets x-vercel-cron. Anything else must present CRON_SECRET.
  // Without this the endpoint is a free way for anyone to burn your API quota.
  const isCron = Boolean(req.headers["x-vercel-cron"]) || /^vercel-cron/i.test(req.headers["user-agent"] || "");
  const secret = process.env.BACKFILL_KEY || process.env.CRON_SECRET;
  const authorized =
    isCron || (secret && req.headers.authorization === `Bearer ${secret}`);

  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  if (!adsConfigured()) {
    return res.status(200).json({ ok: false, skipped: "ads_not_configured" });
  }

  const summary = { scanned: 0, eligible: 0, uploaded: 0, skipped: 0, failed: 0 };
  const errors = [];

  let sessions;
  try {
    sessions = await listRecentSessions();
  } catch (err) {
    console.error("ADS BACKFILL: cannot list sessions:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }

  for (const session of sessions) {
    summary.scanned++;

    if (session.payment_status !== "paid") continue;

    const md = session.metadata || {};
    if (!md.gclid && !md.gbraid && !md.wbraid) continue;

    summary.eligible++;

    // Claim before sending, so two overlapping runs cannot both upload.
    let won = false;
    try {
      won = await claim(session.id);
    } catch (err) {
      summary.failed++;
      errors.push(`${session.id}: redis ${err.message}`);
      continue;
    }
    if (!won) {
      summary.skipped++;
      continue;
    }

    try {
      const result = await uploadPurchase({
        gclid: md.gclid || null,
        gbraid: md.gbraid || null,
        wbraid: md.wbraid || null,
        // amount_total is in minor units. Dividing here, not in the module,
        // keeps the module's contract in major units like everything else.
        value: Number(session.amount_total || 0) / 100,
        currency: session.currency,
        orderId: session.id,
        occurredAt: session.created
          ? new Date(session.created * 1000).toISOString()
          : undefined,
        email: (session.customer_details && session.customer_details.email) || null,
      });

      if (result.ok) {
        summary.uploaded++;
      } else if (result.partialFailure) {
        // Google accepted the request but rejected the row. Retrying will not
        // help, so the claim stays and we surface it in the response.
        summary.failed++;
        errors.push(`${session.id}: ${result.partialFailure}`);
      } else {
        summary.skipped++;
      }
    } catch (err) {
      // Transport or auth failure — release the claim so the next run retries.
      await release(session.id);
      summary.failed++;
      errors.push(`${session.id}: ${err.message}`);
    }
  }

  console.log("ADS BACKFILL", JSON.stringify(summary));
  if (errors.length) console.error("ADS BACKFILL ERRORS", JSON.stringify(errors.slice(0, 3)));

  return res.status(200).json({
    ok: true,
    lookback_hours: LOOKBACK_HOURS,
    ...summary,
    errors: errors.slice(0, 10),
  });
}

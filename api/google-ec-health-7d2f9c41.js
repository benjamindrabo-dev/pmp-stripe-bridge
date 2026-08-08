// Temporary operational self-test. It never returns customer data or hashes.
// It verifies that the production session-status route can derive privacy-safe
// Google enhanced-conversion identifiers from a known paid Stripe session when
// called from the configured storefront origin.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (process.env.VERCEL_ENV !== "production") return res.status(404).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const sessionId = "cs_live_b1zeEjFXODl3doJ32qvqIkBTLIA2ChkWfDyyUESMwQsGALoeixhFDcAWNM";
  const origin = process.env.STORE_ORIGIN || "https://www.puremajestypet.com";
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || "pmp-stripe-bridge.vercel.app";
  const response = await fetch(`https://${host}/api/session-status?session_id=${encodeURIComponent(sessionId)}`, {
    headers: { Origin: origin, Referer: origin + "/pages/thank-you" },
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  const userData = data && data.google_user_data || {};
  const emailHash = String(userData.sha256_email_address || "");
  const phoneHash = String(userData.sha256_phone_number || "");

  return res.status(response.ok ? 200 : 502).json({
    ok: response.ok,
    paid: Boolean(data && data.paid),
    amount_and_currency_present: Number.isFinite(Number(data && data.amount)) && Boolean(data && data.currency),
    has_google_user_data: Boolean(emailHash || phoneHash),
    email_hash_is_sha256: /^[a-f0-9]{64}$/.test(emailHash),
    phone_hash_is_sha256_or_absent: !phoneHash || /^[a-f0-9]{64}$/.test(phoneHash),
  });
}

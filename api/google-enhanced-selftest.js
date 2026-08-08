// Temporary preview-only test. It verifies that a paid Stripe session produces
// privacy-safe Google enhanced-conversion identifiers without returning them.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (process.env.VERCEL_ENV !== "preview") return res.status(404).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const sessionId = String(req.query && req.query.session_id || "");
  if (!/^cs_live_[A-Za-z0-9_]+$/.test(sessionId)) {
    return res.status(400).json({ error: "Bad session_id" });
  }

  const origin = process.env.STORE_ORIGIN || "https://www.puremajestypet.com";
  const host = process.env.VERCEL_URL;
  const response = await fetch(`https://${host}/api/session-status?session_id=${encodeURIComponent(sessionId)}`, {
    headers: { Origin: origin, Referer: origin + "/pages/thank-you" },
  });
  const data = await response.json().catch(() => null);
  const userData = data && data.google_user_data || {};
  const emailHash = String(userData.sha256_email_address || "");
  const phoneHash = String(userData.sha256_phone_number || "");

  return res.status(response.ok ? 200 : 502).json({
    ok: response.ok,
    paid: Boolean(data && data.paid),
    has_google_user_data: Boolean(emailHash || phoneHash),
    email_hash_is_sha256: /^[a-f0-9]{64}$/.test(emailHash),
    phone_hash_is_sha256: !phoneHash || /^[a-f0-9]{64}$/.test(phoneHash),
  });
}

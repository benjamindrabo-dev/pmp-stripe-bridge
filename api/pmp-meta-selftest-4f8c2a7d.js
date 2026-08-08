// Temporary one-shot operational test for the production Shopify -> Stripe
// attribution pipeline. It creates one unpaid Checkout Session with synthetic
// attribution data, then refuses to create another. Remove after verification.

const TEST_KEY = "ops:pmp-meta-selftest-4f8c2a7d";
const RESULT_KEY = TEST_KEY + ":result";

async function redis(command) {
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || typeof data !== "object" || "error" in data) {
    throw new Error("Upstash command failed");
  }
  return data.result;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const prior = await redis(["GET", RESULT_KEY]);
    if (prior) return res.status(200).json(JSON.parse(prior));

    const claimed = await redis(["SET", TEST_KEY, "running", "NX", "EX", "900"]);
    if (claimed !== "OK") return res.status(409).json({ error: "Self-test already running" });

    const now = Date.now();
    const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || "pmp-stripe-bridge.vercel.app";
    const response = await fetch(`https://${host}/api/create-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{
          variant_id: 43349565112394,
          title: "Liquid Collagen for Dogs – Hydrolyzed Collagen Supplement for Joints, Skin & Coat",
          quantity: 1,
          price_cents: 2399,
          image: "https://cdn.shopify.com/s/files/1/0696/7440/1866/files/ChatGPT_Image_11_juil._2026_09_08_46.png?v=1783775478"
        }],
        currency: "USD",
        note: "Automated attribution pipeline self-test — unpaid session",
        fbp: `fb.1.${now}.pmp_pipeline_selftest`,
        fbc: `fb.1.${now}.pmp_pipeline_selftest_click`,
        external_id: "pmp-meta-pipeline-selftest-20260808",
        landing_url: "https://www.puremajestypet.com/products/liquid-collagen-for-dogs?utm_source=facebook&utm_medium=paid_social&utm_campaign=pipeline_selftest",
        referrer: "https://www.facebook.com/",
        utm_source: "facebook",
        utm_medium: "paid_social",
        utm_campaign: "pipeline_selftest",
        utm_content: "synthetic_ad",
        utm_term: "synthetic_adset"
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || !payload.sessionId) {
      await redis(["DEL", TEST_KEY]);
      return res.status(502).json({
        error: "Canonical checkout self-test failed",
        status: response.status,
        detail: payload && (payload.error || payload.detail) || null,
      });
    }

    const result = {
      ok: true,
      unpaid: true,
      session_id: payload.sessionId,
      expected_tracking_version: "pmp_v2",
      created_at: new Date().toISOString(),
    };
    await redis(["SET", RESULT_KEY, JSON.stringify(result), "EX", "86400"]);
    await redis(["SET", TEST_KEY, "done", "EX", "86400"]);
    return res.status(200).json(result);
  } catch (error) {
    try { await redis(["DEL", TEST_KEY]); } catch (_) {}
    return res.status(500).json({ error: String(error && error.message || error) });
  }
}

const SESSIONS = [
  { order: '#1555', id: 'cs_live_b11IlNrz6p6URvQZ9aKa95D0PZ52grmYKc56cZ0ybmVA08JrhL0YTAANsC' },
  { order: '#1556', id: 'cs_live_b1wQCGJmc1zhuMUXVSIQo1ERDaTVLHRfz9bs9JWUwCgGj8juFxsIaet1z2' },
];

function host(value) {
  if (!value) return null;
  try { return new URL(value).hostname || null; } catch { return null; }
}

function classify(metadata) {
  const m = metadata || {};
  const source = String(m.utm_source || '').toLowerCase();
  if (m.gclid || m.gbraid || m.wbraid || source.includes('google')) return 'google';
  if (m.fbc || m.fbp || source.includes('facebook') || source.includes('meta') || source.includes('instagram')) return 'meta';
  if (m.ttclid || source.includes('tiktok')) return 'tiktok';
  if (m.msclkid || source.includes('bing') || source.includes('microsoft')) return 'microsoft';
  if (source) return source;
  const ref = host(m.referrer);
  return ref || 'direct_or_unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const results = [];
  for (const item of SESSIONS) {
    try {
      const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(item.id)}`, {
        headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
      });
      const session = await response.json();
      if (!response.ok) throw new Error(session?.error?.message || `Stripe ${response.status}`);
      const m = session.metadata || {};
      results.push({
        order: item.order,
        source: classify(m),
        landing_host: host(m.landing_page),
        landing_path: (() => { try { return new URL(m.landing_page).pathname; } catch { return null; } })(),
        referrer_host: host(m.referrer),
        utm_source: m.utm_source || null,
        utm_medium: m.utm_medium || null,
        utm_campaign: m.utm_campaign || null,
        utm_content: m.utm_content || null,
        utm_term: m.utm_term || null,
        has_gclid: Boolean(m.gclid),
        has_gbraid: Boolean(m.gbraid),
        has_wbraid: Boolean(m.wbraid),
        has_fbc: Boolean(m.fbc),
        has_fbp: Boolean(m.fbp),
        has_ttclid: Boolean(m.ttclid),
        has_msclkid: Boolean(m.msclkid),
      });
    } catch (error) {
      results.push({ order: item.order, error: String(error?.message || error) });
    }
  }
  console.log('TMP_ATTRIBUTION_AUDIT_1555_1556', JSON.stringify(results));
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, checked: results.length });
}

import { MCP_NON_SECRET_DEFAULTS } from './mcp-oauth.js';

async function googleToken(cfg) {
  const body = new URLSearchParams({ client_id: cfg.google_client_id, client_secret: process.env.GOOGLE_CLIENT_SECRET || '', refresh_token: process.env.GOOGLE_REFRESH_TOKEN || '', grant_type: 'refresh_token' });
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `OAuth ${response.status}`);
  return data.access_token;
}

async function conversionActions(token, customerId) {
  const query = `SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.type, conversion_action.status, conversion_action.primary_for_goal FROM conversion_action`;
  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '', 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Google Ads ${response.status}`);
  return (data.results || []).map((row) => {
    const a = row.conversionAction || {};
    return { id: a.id || null, name: a.name || null, category: a.category || null, type: a.type || null, status: a.status || null, primary_for_goal: Boolean(a.primaryForGoal) };
  });
}

async function ga4Events(token, propertyId) {
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }, { name: 'purchaseRevenue' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'] } } }, limit: '20'
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `GA4 ${response.status}`);
  return (data.rows || []).map((row) => ({ event: row.dimensionValues?.[0]?.value || null, event_count: Number(row.metricValues?.[0]?.value || 0), users: Number(row.metricValues?.[1]?.value || 0), purchase_revenue: Number(row.metricValues?.[2]?.value || 0) }));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const cfg = {
    google_client_id: process.env.GOOGLE_CLIENT_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_CLIENT_ID,
    google_ads_login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    google_ads_customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_CUSTOMER_ID,
    ga4_property_id: process.env.GA4_PROPERTY_ID || MCP_NON_SECRET_DEFAULTS.GA4_PROPERTY_ID,
    mcp_oauth_client_id: process.env.MCP_OAUTH_CLIENT_ID || MCP_NON_SECRET_DEFAULTS.MCP_OAUTH_CLIENT_ID,
  };
  const configured = {
    google_ads_developer_token: Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN), google_client_id: Boolean(cfg.google_client_id), google_client_secret: Boolean(process.env.GOOGLE_CLIENT_SECRET), google_refresh_token: Boolean(process.env.GOOGLE_REFRESH_TOKEN), google_ads_login_customer_id: Boolean(cfg.google_ads_login_customer_id), google_ads_customer_id: Boolean(cfg.google_ads_customer_id), ga4_property_id: Boolean(cfg.ga4_property_id), mcp_oauth_client_id: Boolean(cfg.mcp_oauth_client_id), mcp_oauth_client_secret: Boolean(process.env.MCP_OAUTH_CLIENT_SECRET), mcp_owner_password: Boolean(process.env.MCP_OWNER_PASSWORD), mcp_oauth_signing_secret: Boolean(process.env.MCP_OAUTH_SIGNING_SECRET)
  };
  const result = { ok: Object.values(configured).every(Boolean), service: 'Pure Majesty Google Ads + GA4 MCP', version: '1.4.4-tracking-audit', google_ads_api_version: 'v25', configured };
  if (String(req.query?.tracking || '') === '1') {
    result.tracking_audit = { conversions_by_owner: {}, ga4_events_30d: null };
    try {
      const token = await googleToken(cfg);
      for (const id of [String(cfg.google_ads_customer_id).replace(/\D/g, ''), String(cfg.google_ads_login_customer_id).replace(/\D/g, ''), '2096373623']) {
        try { result.tracking_audit.conversions_by_owner[id] = await conversionActions(token, id); }
        catch (error) { result.tracking_audit.conversions_by_owner[id] = { error: error.message }; }
      }
      try { result.tracking_audit.ga4_events_30d = await ga4Events(token, String(cfg.ga4_property_id).replace(/\D/g, '')); }
      catch (error) { result.tracking_audit.ga4_events_30d = { error: error.message }; }
    } catch (error) { result.tracking_audit.oauth_error = error.message; }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}

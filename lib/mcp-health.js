import { MCP_NON_SECRET_DEFAULTS } from './mcp-oauth.js';

async function getGoogleAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN || '',
    grant_type: 'refresh_token',
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Google OAuth ${response.status}: ${data.error || 'token_error'} ${data.error_description || ''}`.trim());
  }
  return data.access_token;
}

async function testGoogleAds(accessToken, customerId, loginCustomerId) {
  const query = `SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1`;
  const response = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
      'login-customer-id': loginCustomerId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, pageSize: 1 }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || data?.error?.status || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const customer = data?.results?.[0]?.customer || {};
  return {
    ok: true,
    customer_id: customer.id || customerId,
    descriptive_name: customer.descriptiveName || null,
    currency_code: customer.currencyCode || null,
    time_zone: customer.timeZone || null,
  };
}

async function testGa4(accessToken, propertyId) {
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      limit: '1',
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || data?.error?.status || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return {
    ok: true,
    property_id: propertyId,
    row_count: Number(data?.rowCount || 0),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const nonSecretConfiguration = {
    google_client_id: process.env.GOOGLE_CLIENT_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_CLIENT_ID,
    google_ads_login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    google_ads_customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_CUSTOMER_ID,
    ga4_property_id: process.env.GA4_PROPERTY_ID || MCP_NON_SECRET_DEFAULTS.GA4_PROPERTY_ID,
    mcp_oauth_client_id: process.env.MCP_OAUTH_CLIENT_ID || MCP_NON_SECRET_DEFAULTS.MCP_OAUTH_CLIENT_ID,
  };

  const configured = {
    google_ads_developer_token: Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    google_client_id: Boolean(nonSecretConfiguration.google_client_id),
    google_client_secret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    google_refresh_token: Boolean(process.env.GOOGLE_REFRESH_TOKEN),
    google_ads_login_customer_id: Boolean(nonSecretConfiguration.google_ads_login_customer_id),
    google_ads_customer_id: Boolean(nonSecretConfiguration.google_ads_customer_id),
    ga4_property_id: Boolean(nonSecretConfiguration.ga4_property_id),
    mcp_oauth_client_id: Boolean(nonSecretConfiguration.mcp_oauth_client_id),
    mcp_oauth_client_secret: Boolean(process.env.MCP_OAUTH_CLIENT_SECRET),
    mcp_owner_password: Boolean(process.env.MCP_OWNER_PASSWORD),
    mcp_oauth_signing_secret: Boolean(process.env.MCP_OAUTH_SIGNING_SECRET),
  };

  const result = {
    ok: Object.values(configured).every(Boolean),
    service: 'Pure Majesty Google Ads + GA4 MCP',
    version: '1.3.2-live-selftest',
    google_ads_api_version: 'v25',
    mcp_endpoint: '/api/mcp',
    oauth_metadata: '/.well-known/oauth-authorization-server',
    configured,
    non_secret_configuration: nonSecretConfiguration,
  };

  if (String(req.query?.live || '') === '1') {
    result.live_test = { oauth: { ok: false }, google_ads: { ok: false }, ga4: { ok: false } };
    try {
      const accessToken = await getGoogleAccessToken();
      result.live_test.oauth = { ok: true };
      try {
        result.live_test.google_ads = await testGoogleAds(
          accessToken,
          nonSecretConfiguration.google_ads_customer_id,
          nonSecretConfiguration.google_ads_login_customer_id,
        );
      } catch (error) {
        result.live_test.google_ads = { ok: false, error: error.message };
      }
      try {
        result.live_test.ga4 = await testGa4(accessToken, nonSecretConfiguration.ga4_property_id);
      } catch (error) {
        result.live_test.ga4 = { ok: false, error: error.message };
      }
    } catch (error) {
      result.live_test.oauth = { ok: false, error: error.message };
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(result);
}

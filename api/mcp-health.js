export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const configured = {
    google_ads_developer_token: Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    google_client_id: Boolean(process.env.GOOGLE_CLIENT_ID),
    google_client_secret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    google_refresh_token: Boolean(process.env.GOOGLE_REFRESH_TOKEN),
    google_ads_login_customer_id: Boolean(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    google_ads_customer_id: Boolean(process.env.GOOGLE_ADS_CUSTOMER_ID),
    ga4_property_id: Boolean(process.env.GA4_PROPERTY_ID),
    mcp_oauth_client_id: Boolean(process.env.MCP_OAUTH_CLIENT_ID),
    mcp_oauth_client_secret: Boolean(process.env.MCP_OAUTH_CLIENT_SECRET),
    mcp_owner_password: Boolean(process.env.MCP_OWNER_PASSWORD),
    mcp_oauth_signing_secret: Boolean(process.env.MCP_OAUTH_SIGNING_SECRET),
  };
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: Object.values(configured).every(Boolean),
    service: 'Pure Majesty Google Ads + GA4 MCP',
    version: '1.2.0',
    google_ads_api_version: 'v25',
    google_analytics_data_api_version: 'v1beta',
    mcp_endpoint: '/api/mcp',
    oauth_metadata: '/.well-known/oauth-authorization-server',
    configured,
  });
}

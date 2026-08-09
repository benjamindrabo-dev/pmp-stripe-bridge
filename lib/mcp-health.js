import { MCP_NON_SECRET_DEFAULTS } from './mcp-oauth.js';

export default function handler(req, res) {
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

  const mcpEnvironmentKeys = Object.keys(process.env)
    .filter((key) => key.startsWith('MCP_'))
    .sort();

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: Object.values(configured).every(Boolean),
    service: 'Pure Majesty Google Ads + GA4 MCP',
    version: '1.3.1-diagnostic',
    google_ads_api_version: 'v25',
    mcp_endpoint: '/api/mcp',
    oauth_metadata: '/.well-known/oauth-authorization-server',
    configured,
    non_secret_configuration: nonSecretConfiguration,
    diagnostic_mcp_environment_keys: mcpEnvironmentKeys,
  });
}

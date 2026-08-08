from pathlib import Path
import re

GOOGLE_CLIENT_ID = "320852405325-nibnlp9dor8b4e6take8mbuga6829t58.apps.googleusercontent.com"
GOOGLE_ADS_LOGIN_CUSTOMER_ID = "5890800084"
GOOGLE_ADS_CUSTOMER_ID = "2096373623"
GA4_PROPERTY_ID = "526354130"
MCP_OAUTH_CLIENT_ID = "chatgpt-work-pmp"


def replace_or_verify(text: str, old: str, new: str, label: str) -> str:
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"Could not locate {label}.")


def patch_oauth_defaults() -> None:
    path = Path("lib/mcp-oauth.js")
    text = path.read_text()
    defaults_block = f"""export const MCP_NON_SECRET_DEFAULTS = Object.freeze({{
  GOOGLE_CLIENT_ID: '{GOOGLE_CLIENT_ID}',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '{GOOGLE_ADS_LOGIN_CUSTOMER_ID}',
  GOOGLE_ADS_CUSTOMER_ID: '{GOOGLE_ADS_CUSTOMER_ID}',
  GA4_PROPERTY_ID: '{GA4_PROPERTY_ID}',
  MCP_OAUTH_CLIENT_ID: '{MCP_OAUTH_CLIENT_ID}',
}});
"""

    if "export const MCP_NON_SECRET_DEFAULTS" in text:
        text, count = re.subn(
            r"export const MCP_NON_SECRET_DEFAULTS = Object\.freeze\(\{[\s\S]*?\}\);\n",
            defaults_block,
            text,
            count=1,
        )
        if count != 1:
            raise SystemExit("Could not refresh MCP_NON_SECRET_DEFAULTS.")
    else:
        marker = "]);\n\nexport function requiredEnv"
        if marker not in text:
            raise SystemExit("Could not locate the MCP scope block.")
        text = text.replace(
            marker,
            "]);\n\n" + defaults_block + "\nexport function requiredEnv",
            1,
        )

    text = replace_or_verify(
        text,
        "  const value = process.env[name];",
        "  const value = process.env[name] || MCP_NON_SECRET_DEFAULTS[name];",
        "requiredEnv default lookup",
    )
    path.write_text(text)


def patch_mcp() -> None:
    path = Path("api/mcp.js")
    text = path.read_text()

    text = replace_or_verify(
        text,
        "import { MCP_SCOPES, verifySignedToken } from '../lib/mcp-oauth.js';",
        "import { MCP_NON_SECRET_DEFAULTS, MCP_SCOPES, verifySignedToken } from '../lib/mcp-oauth.js';",
        "MCP OAuth import",
    )
    text = replace_or_verify(
        text,
        "const DEFAULT_CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '2096373623').replace(/\\D/g, '');",
        "const DEFAULT_CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_CUSTOMER_ID).replace(/\\D/g, '');",
        "Google Ads customer ID default",
    )
    text = replace_or_verify(
        text,
        "const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '5890800084').replace(/\\D/g, '');",
        "const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/\\D/g, '');",
        "Google Ads login customer ID default",
    )
    text = replace_or_verify(
        text,
        "const DEFAULT_GA4_PROPERTY_ID = (process.env.GA4_PROPERTY_ID || '526354130').replace(/\\D/g, '');",
        "const DEFAULT_GA4_PROPERTY_ID = (process.env.GA4_PROPERTY_ID || MCP_NON_SECRET_DEFAULTS.GA4_PROPERTY_ID).replace(/\\D/g, '');",
        "GA4 property ID default",
    )
    text = replace_or_verify(
        text,
        "    client_id: requiredEnv('GOOGLE_CLIENT_ID'),",
        "    client_id: process.env.GOOGLE_CLIENT_ID || MCP_NON_SECRET_DEFAULTS.GOOGLE_CLIENT_ID,",
        "Google OAuth client ID default",
    )
    if "{ name: 'Pure Majesty Google Ads + GA4', version: '1.0.0' }," in text:
        text = text.replace(
            "{ name: 'Pure Majesty Google Ads + GA4', version: '1.0.0' },",
            "{ name: 'Pure Majesty Google Ads + GA4', version: '1.3.0' },",
            1,
        )

    required_fragments = [
        "MCP_NON_SECRET_DEFAULTS.GOOGLE_CLIENT_ID",
        "MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_LOGIN_CUSTOMER_ID",
        "MCP_NON_SECRET_DEFAULTS.GOOGLE_ADS_CUSTOMER_ID",
        "MCP_NON_SECRET_DEFAULTS.GA4_PROPERTY_ID",
    ]
    missing = [fragment for fragment in required_fragments if fragment not in text]
    if missing:
        raise SystemExit(f"Missing expected MCP defaults: {missing}")

    path.write_text(text)


def rewrite_health() -> None:
    path = Path("lib/mcp-health.js")
    path.write_text(
        """import { MCP_NON_SECRET_DEFAULTS } from './mcp-oauth.js';

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

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: Object.values(configured).every(Boolean),
    service: 'Pure Majesty Google Ads + GA4 MCP',
    version: '1.3.0',
    google_ads_api_version: 'v25',
    mcp_endpoint: '/api/mcp',
    oauth_metadata: '/.well-known/oauth-authorization-server',
    configured,
    non_secret_configuration: nonSecretConfiguration,
  });
}
"""
    )


patch_oauth_defaults()
patch_mcp()
rewrite_health()
print("Known non-secret Google MCP configuration embedded successfully.")

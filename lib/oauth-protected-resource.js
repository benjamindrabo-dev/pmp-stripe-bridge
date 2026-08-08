import { MCP_SCOPES, originFromRequest } from '../lib/mcp-oauth.js';

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const origin = originFromRequest(req);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(200).json({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: `${origin}/api/mcp-health`,
  });
}

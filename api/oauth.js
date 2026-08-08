import protectedResourceHandler from '../lib/oauth-protected-resource.js';
import authorizationServerHandler from '../lib/oauth-authorization-server.js';
import authorizeHandler from '../lib/oauth-authorize.js';
import tokenHandler from '../lib/oauth-token.js';
import healthHandler from '../lib/mcp-health.js';

const handlers = Object.freeze({
  'protected-resource': protectedResourceHandler,
  'authorization-server': authorizationServerHandler,
  authorize: authorizeHandler,
  token: tokenHandler,
  health: healthHandler,
});

export default function handler(req, res) {
  const route = String(req.query?.route || '');
  const selected = handlers[route];
  if (!selected) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'oauth_route_not_found' });
  }
  return selected(req, res);
}

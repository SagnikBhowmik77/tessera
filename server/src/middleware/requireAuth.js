import { HttpError } from '../errors.js';
import { verifyToken } from '../services/auth.service.js';
import { TOKEN_PREFIX, userFromApiToken } from '../services/apitoken.service.js';

// Protects a route: needs "Authorization: Bearer <token>", either a login token or a personal API
// token (tsp_..., E13). Sets req.user (the User document) and req.auth (the token's claims).
// Read-only API tokens can only make GET requests.
export async function requireAuth(req, _res, next) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'auth_required', 'Please log in to continue');
  }
  const { user, claims } = token.startsWith(TOKEN_PREFIX) ? await userFromApiToken(token) : await verifyToken(token);
  if (claims.apiToken && claims.scope === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    throw new HttpError(403, 'read_only_token', 'This API token can only read. Make a read and write token to change things.');
  }
  req.user = user;
  req.auth = claims;
  next();
}

// Account security (password, 2FA, sessions, API tokens, deleting the account) needs a real login,
// never an API token: a leaked token must not be able to lock its owner out.
export function noApiToken(req, _res, next) {
  if (req.auth?.apiToken) throw new HttpError(403, 'login_required', 'Log in to Tessera to do this; API tokens cannot.');
  next();
}

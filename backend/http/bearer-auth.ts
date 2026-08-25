/**
 * Bearer-token authentication for the HTTP routes.
 *
 * The HTTP routes sit next to the WebSocket router rather than inside it, so
 * they cannot lean on `WSConnection` for identity. They all accept the same
 * `Authorization: Bearer <session-token>` the frontend already holds (issued
 * by `auth:login`, stored in `localStorage`), which this module resolves to a
 * user exactly once instead of once per route file.
 */

import { hashToken } from '../auth/tokens';
import { authQueries } from '../database/queries';

export interface AuthIdentity {
	userId: string;
	role: string;
}

/**
 * Resolve the caller from the request's bearer token.
 *
 * Throws an `Error` carrying a `status` property so a route can answer with
 * the right code without re-deriving it.
 */
export function authenticateRequest(request: Request): AuthIdentity {
	const header = request.headers.get('authorization') || request.headers.get('Authorization');
	if (!header || !header.toLowerCase().startsWith('bearer ')) {
		throw Object.assign(new Error('Authorization required'), { status: 401 });
	}
	const token = header.slice(7).trim();
	if (!token) {
		throw Object.assign(new Error('Authorization required'), { status: 401 });
	}
	const session = authQueries.getSessionByTokenHash(hashToken(token));
	if (!session) {
		throw Object.assign(new Error('Invalid session token'), { status: 401 });
	}
	if (new Date(session.expires_at) < new Date()) {
		throw Object.assign(new Error('Session expired'), { status: 401 });
	}
	const user = authQueries.getUserById(session.user_id);
	if (!user) {
		throw Object.assign(new Error('User not found'), { status: 401 });
	}
	authQueries.updateLastActive(session.id);
	return { userId: user.id, role: user.role };
}

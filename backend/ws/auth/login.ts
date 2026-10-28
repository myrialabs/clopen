import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import {
	createOwner,
	loginWithToken,
	logout,
	logoutAllSessions,
	regeneratePAT,
	updateUserName,
	createOrGetNoAuthOwner,
	needsSetup,
	markOnboardingPending
} from '$backend/auth/auth-service';
import { getAuthMode, writeSystemSettings } from '$backend/settings/system-settings';
import { auditLogQueries } from '$backend/database/queries';
import { getTokenType } from '$backend/auth/tokens';
import { authRateLimiter } from '$backend/auth/rate-limiter';
import { ws } from '$backend/utils/ws';
import { clientIpFromConnection } from '$backend/utils/client-ip';

const authUserSchema = t.Object({
	id: t.String(),
	name: t.String(),
	color: t.String(),
	avatar: t.String(),
	createdAt: t.String()
});

export const loginHandler = createRouter()
	// Setup — create the owner (only works before setup)
	.http('auth:setup', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			userAgent: t.Optional(t.String())
		}),
		response: t.Object({
			user: authUserSchema,
			sessionToken: t.String(),
			personalAccessToken: t.String(),
			expiresAt: t.String()
		})
	}, async ({ data, conn }) => {
		// Refuse before touching any state. This route is public, so without the
		// guard a stray call against a live instance would flip the onboarding
		// marker below and send the instance back through the wizard.
		if (!needsSetup()) {
			throw new Error('Setup already completed. The owner account exists.');
		}

		// Mark the wizard as in-progress BEFORE the owner exists, so a refresh
		// between here and "Finish" resumes setup instead of looking like a
		// completed install (which is how onboarding state is inferred).
		markOnboardingPending();

		const result = createOwner(data.name, { userAgent: data.userAgent, ipAddress: clientIpFromConnection(conn) });

		// Save authMode to system settings
		writeSystemSettings({ authMode: 'required' });

		auditLogQueries.logEvent({
			userId: result.user.id,
			actorUserId: result.user.id,
			eventType: 'auth:setup',
			eventDetails: `Owner account created: ${result.user.name}`,
			ipAddress: clientIpFromConnection(conn)
		});

		// Set auth on connection
		const tokenHash = (await import('$backend/auth/tokens')).hashToken(result.sessionToken);
		ws.setAuth(conn, result.user.id, tokenHash);

		return result;
	})

	// Setup no-auth mode — create the default owner, save authMode setting
	.http('auth:setup-no-auth', {
		data: t.Object({}),
		response: t.Object({
			user: authUserSchema,
			sessionToken: t.String(),
			expiresAt: t.String()
		})
	}, async ({ conn }) => {
		if (!needsSetup()) {
			throw new Error('Setup already completed.');
		}

		// Same ordering as auth:setup — record the in-progress wizard before the
		// owner exists.
		markOnboardingPending();

		// Save authMode to system settings
		writeSystemSettings({ authMode: 'none' });

		const result = createOrGetNoAuthOwner();

		auditLogQueries.logEvent({
			userId: result.user.id,
			actorUserId: result.user.id,
			eventType: 'auth:setup-no-auth',
			eventDetails: `No-auth mode enabled, owner: ${result.user.name}`,
			ipAddress: clientIpFromConnection(conn)
		});

		// Set auth on connection
		const tokenHash = (await import('$backend/auth/tokens')).hashToken(result.sessionToken);
		ws.setAuth(conn, result.user.id, tokenHash);

		return result;
	})

	// Auto-login for no-auth mode (returning visitors)
	.http('auth:auto-login-no-auth', {
		data: t.Object({}),
		response: t.Object({
			user: authUserSchema,
			sessionToken: t.String(),
			expiresAt: t.String()
		})
	}, async ({ conn }) => {
		if (getAuthMode() !== 'none') {
			throw new Error('Auto-login is only available in no-auth mode');
		}

		const result = createOrGetNoAuthOwner();

		auditLogQueries.logEvent({
			userId: result.user.id,
			actorUserId: result.user.id,
			eventType: 'auth:auto-login-no-auth',
			eventDetails: `Auto-login in no-auth mode: ${result.user.name}`,
			ipAddress: clientIpFromConnection(conn)
		});

		// Set auth on connection
		const tokenHash = (await import('$backend/auth/tokens')).hashToken(result.sessionToken);
		ws.setAuth(conn, result.user.id, tokenHash);

		return result;
	})

	// Login with token (PAT or session token)
	.http('auth:login', {
		data: t.Object({
			token: t.String({ minLength: 1 }),
			userAgent: t.Optional(t.String())
		}),
		response: t.Object({
			user: authUserSchema,
			sessionToken: t.String(),
			expiresAt: t.String()
		})
	}, async ({ data, conn }) => {
		const ip = ws.getRemoteAddress(conn);
		const tokenType = getTokenType(data.token);

		// Session tokens are re-authentication (reconnect) — skip rate limit entirely.
		// Only rate-limit PAT and unknown tokens (brute-force targets).
		const isRateLimited = tokenType !== 'session';

		if (isRateLimited) {
			const rateLimitError = authRateLimiter.check(ip, 'auth:login');
			if (rateLimitError) {
				throw new Error(rateLimitError);
			}
		}

		try {
			const result = loginWithToken(data.token, { userAgent: data.userAgent, ipAddress: clientIpFromConnection(conn) });

			// Success — clear any rate limit record for this IP
			if (isRateLimited) {
				authRateLimiter.recordSuccess(ip, 'auth:login');
			}

			auditLogQueries.logEvent({
				userId: result.user.id,
				actorUserId: result.user.id,
				eventType: 'auth:login',
				eventDetails: `User ${result.user.name} logged in via ${tokenType} token`,
				ipAddress: clientIpFromConnection(conn)
			});

			ws.setAuth(conn, result.user.id, result.tokenHash);

			return {
				user: result.user,
				sessionToken: result.sessionToken,
				expiresAt: result.expiresAt
			};
		} catch (err) {
			// Record failure for rate limiting (only non-session tokens)
			if (isRateLimited) {
				authRateLimiter.recordFailure(ip, 'auth:login');
			}
			throw err;
		}
	})

	// Logout — clear session
	.http('auth:logout', {
		data: t.Object({}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ conn }) => {
		const state = ws.getConnectionState(conn);
		const userId = state?.userId;
		if (state?.sessionTokenHash) logout(state.sessionTokenHash);
		ws.clearAuth(conn);
		if (userId) {
			auditLogQueries.logEvent({
				userId,
				actorUserId: userId,
				eventType: 'auth:logout',
				eventDetails: 'User logged out',
				ipAddress: clientIpFromConnection(conn)
			});
		}
		return { success: true };
	})

	// Regenerate Personal Access Token
	.http('auth:regenerate-pat', {
		data: t.Object({}),
		response: t.Object({
			personalAccessToken: t.String()
		})
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);
		const pat = regeneratePAT(userId);
		return { personalAccessToken: pat };
	})

	// Sign out every device (used when switching auth mode)
	.http('auth:logout-all', {
		data: t.Object({}),
		response: t.Object({ count: t.Number() })
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);
		const count = logoutAllSessions();
		ws.emit.global('auth:force-logout', { reason: 'Auth mode changed' });
		ws.clearAllAuth();
		auditLogQueries.logEvent({
			userId,
			actorUserId: userId,
			eventType: 'auth:logout-all',
			eventDetails: `Signed out every device (${count} sessions cleared)`,
			ipAddress: clientIpFromConnection(conn)
		});
		return { count };
	})

	// Update display name
	.http('auth:update-name', {
		data: t.Object({
			newName: t.String({ minLength: 1 })
		}),
		response: authUserSchema
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		return updateUserName(userId, data.newName);
	});

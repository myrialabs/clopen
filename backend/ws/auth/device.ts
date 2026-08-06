/**
 * Device-pairing WebSocket handlers (Remote Access → "Add a device").
 *
 * - auth:create-device-code — authenticated user mints a one-time code for a new
 *   device. The raw code is embedded in a share link; only its hash is stored.
 * - auth:claim-device-code — PUBLIC. The scanning device exchanges the code for
 *   a session as the owning user. Single-use + short TTL, so a leaked link dies
 *   after one use. Rate-limited like other credential endpoints.
 * - auth:list-sessions / auth:revoke-session — a user manages their own signed-in
 *   devices (sessions).
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import {
	createDeviceCode,
	claimDeviceCode,
	revokeDeviceCode,
	listUserSessions,
	listAllSessions,
	revokeUserSession,
	revokeAnySession,
	getRemoteAccessSummary
} from '$backend/auth/auth-service';
import { auditLogQueries } from '$backend/database/queries';
import { authRateLimiter } from '$backend/auth/rate-limiter';
import { ws } from '$backend/utils/ws';
import { clientIpFromConnection } from '$backend/utils/client-ip';

const authUserSchema = t.Object({
	id: t.String(),
	name: t.String(),
	role: t.Union([t.Literal('admin'), t.Literal('member')]),
	color: t.String(),
	avatar: t.String(),
	createdAt: t.String()
});

export const deviceHandler = createRouter()
	// Create a one-time device-pairing code for the current user
	.http('auth:create-device-code', {
		data: t.Object({
			label: t.Optional(t.String())
		}),
		response: t.Object({
			deviceCode: t.String(),
			expiresAt: t.String()
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const result = createDeviceCode(userId, data.label);

		auditLogQueries.logEvent({
			userId,
			actorUserId: userId,
			eventType: 'auth:create-device-code',
			eventDetails: 'Device-pairing code created',
			ipAddress: clientIpFromConnection(conn)
		});

		// Refresh the sharer's Remote Access views on their other devices.
		ws.emit.user(userId, 'remote-access:changed', { kind: 'device-created' });

		return result;
	})

	// Claim a device-pairing code — PUBLIC (the claiming device is not yet authed)
	.http('auth:claim-device-code', {
		data: t.Object({
			deviceCode: t.String({ minLength: 1 }),
			userAgent: t.Optional(t.String())
		}),
		response: t.Object({
			user: authUserSchema,
			sessionToken: t.String(),
			expiresAt: t.String()
		})
	}, async ({ data, conn }) => {
		const ip = ws.getRemoteAddress(conn);

		const rateLimitError = authRateLimiter.check(ip, 'auth:claim-device-code');
		if (rateLimitError) {
			throw new Error(rateLimitError);
		}

		try {
			const result = claimDeviceCode(data.deviceCode, {
				userAgent: data.userAgent,
				ipAddress: clientIpFromConnection(conn)
			});

			authRateLimiter.recordSuccess(ip);

			auditLogQueries.logEvent({
				userId: result.user.id,
				actorUserId: result.user.id,
				eventType: 'auth:claim-device-code',
				eventDetails: `User ${result.user.name} signed in a new device`,
				ipAddress: clientIpFromConnection(conn)
			});

			ws.setAuth(conn, result.user.id, result.user.role, result.tokenHash);

			// Notify the account's other devices: a device connected — refresh their
			// device list and close the now-consumed link/QR.
			ws.emit.user(result.user.id, 'remote-access:changed', { kind: 'device-claimed' });

			return {
				user: result.user,
				sessionToken: result.sessionToken,
				expiresAt: result.expiresAt
			};
		} catch (err) {
			authRateLimiter.recordFailure(ip, 'auth:claim-device-code');
			throw err;
		}
	})

	// Revoke an unclaimed device code (e.g. when regenerating a link)
	.http('auth:revoke-device-code', {
		data: t.Object({
			deviceCode: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const success = revokeDeviceCode(userId, data.deviceCode);
		if (success) {
			ws.emit.user(userId, 'remote-access:changed', { kind: 'device-revoked' });
		}
		return { success };
	})

	// List the current user's active sessions (devices)
	.http('auth:list-sessions', {
		data: t.Object({}),
		response: t.Array(t.Object({
			id: t.String(),
			createdAt: t.String(),
			lastActiveAt: t.String(),
			expiresAt: t.String(),
			current: t.Boolean(),
			online: t.Boolean(),
			userAgent: t.Union([t.String(), t.Null()]),
			ipAddress: t.Union([t.String(), t.Null()]),
			source: t.Union([t.String(), t.Null()])
		}))
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);
		return listUserSessions(userId, ws.getSessionTokenHash(conn) ?? undefined, ws.getOnlineSessionHashes());
	})

	// List every device signed in across the team (admin only) — the unified
	// "Connected devices" view with owner + provenance.
	.http('auth:list-all-sessions', {
		data: t.Object({}),
		response: t.Array(t.Object({
			id: t.String(),
			createdAt: t.String(),
			lastActiveAt: t.String(),
			expiresAt: t.String(),
			current: t.Boolean(),
			online: t.Boolean(),
			userAgent: t.Union([t.String(), t.Null()]),
			ipAddress: t.Union([t.String(), t.Null()]),
			source: t.Union([t.String(), t.Null()]),
			userId: t.String(),
			userName: t.String(),
			userColor: t.String(),
			userRole: t.Union([t.Literal('admin'), t.Literal('member')])
		}))
	}, async ({ conn }) => {
		return listAllSessions(ws.getSessionTokenHash(conn) ?? undefined, ws.getOnlineSessionHashes());
	})

	// Remote Access summary — backs the sidebar indicator/count (online devices)
	.http('remote-access:summary', {
		data: t.Object({}),
		response: t.Object({
			activeConnections: t.Number()
		})
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);
		const isAdmin = ws.getRole(conn) === 'admin';
		return getRemoteAccessSummary(userId, isAdmin, ws.getOnlineSessionHashes(), ws.getSessionTokenHash(conn) ?? undefined);
	})

	// Revoke one of the current user's own sessions (sign out a device)
	.http('auth:revoke-session', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const result = revokeUserSession(userId, data.id);
		if (result.success) {
			// Kick the live connection bound to that session immediately, so the
			// signed-out device loses access now instead of at its next reconnect.
			if (result.tokenHash) {
				ws.invalidateSessionByHash(result.tokenHash, 'This device was signed out');
			}
			auditLogQueries.logEvent({
				userId,
				actorUserId: userId,
				eventType: 'auth:revoke-session',
				eventDetails: `Session ${data.id} revoked`,
				ipAddress: clientIpFromConnection(conn)
			});
			ws.emit.user(userId, 'remote-access:changed', { kind: 'session-revoked' });
		}
		return { success: result.success };
	})

	// Revoke any user's session (admin only — sign out a device from the unified
	// "Connected devices" list).
	.http('auth:revoke-any-session', {
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({ success: t.Boolean() })
	}, async ({ data, conn }) => {
		const adminId = ws.getUserId(conn);
		const result = revokeAnySession(data.id);
		if (result.success) {
			if (result.tokenHash) {
				ws.invalidateSessionByHash(result.tokenHash, 'This device was signed out by an admin');
			}
			auditLogQueries.logEvent({
				userId: adminId,
				actorUserId: adminId,
				eventType: 'auth:revoke-any-session',
				eventDetails: `Admin revoked session ${data.id}`,
				ipAddress: clientIpFromConnection(conn)
			});
			ws.emit.global('remote-access:changed', { kind: 'session-revoked' });
		}
		return { success: result.success };
	});

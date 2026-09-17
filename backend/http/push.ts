/**
 * HTTP routes for Web Push subscriptions (mobile background notifications).
 *
 * A subscription is one (user, device) pair: the browser's PushManager mints
 * an endpoint + keys, the frontend POSTs them here, and the server fans chat
 * completions out to every registered device — including when Chrome is
 * closed, which the page-local notification path can never do.
 *
 * Auth: `Authorization: Bearer <session-token>` (same token as auth:login).
 * Every route resolves the user from the token; a user can only touch their
 * own subscriptions.
 */

import { Elysia } from 'elysia';

import { debug } from '$shared/utils/logger';
import { pushSubscriptionQueries } from '../database/queries/push-subscription-queries';
import { getVapidKeys } from '../push/vapid-keys';
import { isValidSubscriptionKeys, sendPushToUser } from '../push/sender';
import { uniquePushTag } from '../push/tags';
import { authenticateRequest, type AuthIdentity } from './bearer-auth';

function unauthorized(error: unknown): Response {
	const status = (error as { status?: number }).status ?? 401;
	const message = error instanceof Error ? error.message : 'Unauthorized';
	return new Response(message, { status });
}

export const pushRoute = new Elysia()
	.get('/api/push/vapid-public-key', async ({ request }) => {
		try {
			authenticateRequest(request);
		} catch (error) {
			return unauthorized(error);
		}

		try {
			const keys = await getVapidKeys();
			return Response.json({ publicKey: keys.publicKey });
		} catch (error) {
			debug.error('notification', 'Failed to resolve VAPID keys:', error);
			return new Response('Failed to resolve push identity', { status: 500 });
		}
	})
	.post('/api/push/subscriptions', async ({ request }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticateRequest(request);
		} catch (error) {
			return unauthorized(error);
		}

		let body: {
			endpoint?: unknown;
			keys?: { p256dh?: unknown; auth?: unknown };
			userAgent?: unknown;
		};
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return new Response('Invalid JSON body', { status: 400 });
		}

		const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
		const p256dh = body.keys?.p256dh;
		const auth = body.keys?.auth;
		if (!endpoint.startsWith('https://') || !isValidSubscriptionKeys(p256dh, auth)) {
			return new Response('Invalid subscription (endpoint must be https + valid p256dh/auth keys)', {
				status: 400
			});
		}

		try {
			const subscription = pushSubscriptionQueries.upsert({
				userId: identity.userId,
				endpoint,
				p256dh: p256dh as string,
				auth: auth as string,
				userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 300) : undefined
			});
			return Response.json({ id: subscription.id });
		} catch (error) {
			debug.error('notification', 'Failed to store subscription:', error);
			return new Response('Failed to store subscription', { status: 500 });
		}
	})
	.delete('/api/push/subscriptions', async ({ request }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticateRequest(request);
		} catch (error) {
			return unauthorized(error);
		}

		let body: { endpoint?: unknown; all?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			// A device that never registered has no endpoint to send; an empty
			// body is a valid "purge whatever I have" request.
			body = {};
		}

		// `all` is what the settings toggle sends. The push setting is one
		// per-user value, so switching it off on a laptop that holds no
		// subscription still has to silence the phone that does.
		const removeAll = body.all === true;
		const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
		if (!removeAll && !endpoint) {
			return new Response('Missing endpoint', { status: 400 });
		}

		try {
			const removed = removeAll
				? pushSubscriptionQueries.deleteAllByUser(identity.userId)
				: Number(pushSubscriptionQueries.deleteByEndpoint(identity.userId, endpoint));
			return Response.json({ removed });
		} catch (error) {
			debug.error('notification', 'Failed to remove subscription:', error);
			return new Response('Failed to remove subscription', { status: 500 });
		}
	})
	.post('/api/push/test', async ({ request }) => {
		let identity: AuthIdentity;
		try {
			identity = authenticateRequest(request);
		} catch (error) {
			return unauthorized(error);
		}

		let body: { tag?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			body = {};
		}
		const tag =
			typeof body.tag === 'string' && body.tag.length > 0 && body.tag.length <= 120
				? body.tag
				: uniquePushTag('test');

		// This goes through the real server→push-service→device path, so a
		// passing test proves background delivery — not just a local toast.
		const sent = await sendPushToUser(identity.userId, {
			title: 'Test Notification',
			body: 'Push notifications are working correctly',
			tag
		});
		return Response.json({ sent, tag });
	});

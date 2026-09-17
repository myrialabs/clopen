/**
 * Web Push fan-out.
 *
 * `sendPushToUser()` is the only entry point the chat layer needs: it loads
 * every subscription the user registered (one per mobile device), encrypts
 * the payload per subscription, and POSTs to each push service. It never
 * throws — a dead endpoint or a down push service must not fail a chat turn.
 *
 * Dead subscriptions prune themselves: push services answer 404/410 for an
 * expired endpoint, and those rows are deleted on sight.
 */

import { debug } from '$shared/utils/logger';
import { pushSubscriptionQueries, type PushSubscription } from '../database/queries/push-subscription-queries';
import {
	base64UrlDecode,
	createVapidAuthorizationHeader,
	encryptPushPayload
} from './webpush-crypto';
import { getVapidKeys, getVapidSubject } from './vapid-keys';

export interface PushPayload {
	title: string;
	body: string;
	/** Deterministic per event so a server copy replaces (not stacks with) the local one. */
	tag: string;
	/** Where tapping the notification lands. Defaults to `/`. */
	url?: string;
}

/**
 * How long a push service holds a notification for an offline device.
 *
 * One hour, not a day: every payload here is "your chat just finished" or
 * "something is waiting for input". Delivered the next morning that is not a
 * notification, it is a puzzle — the turn is long over and the state it
 * describes no longer exists. A phone that stays offline past the hour finds
 * the result in the app instead.
 */
const PUSH_TTL_SECONDS = 3600;

/**
 * Push services cap a record at 4096 bytes, and that budget covers the
 * ciphertext, not the JSON. Project names are user-supplied and unbounded, so
 * a long one would otherwise turn a chat completion into a 413 from the push
 * service. Clamping here keeps the failure impossible rather than rare.
 */
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 400;
const MAX_URL_CHARS = 512;

function clamp(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function encodePayload(payload: PushPayload): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			title: clamp(payload.title, MAX_TITLE_CHARS),
			body: clamp(payload.body, MAX_BODY_CHARS),
			tag: payload.tag,
			url: clamp(payload.url ?? '/', MAX_URL_CHARS)
		})
	);
}

/**
 * POST one encrypted push. Returns `'sent'`, `'stale'` (endpoint expired —
 * caller deletes the row), or `'failed'` (transient; keep the row).
 */
async function postPush(
	subscription: PushSubscription,
	payload: PushPayload
): Promise<'sent' | 'stale' | 'failed'> {
	let audience: string;
	try {
		audience = new URL(subscription.endpoint).origin;
	} catch {
		return 'stale';
	}

	let body: Uint8Array<ArrayBuffer>;
	try {
		({ body } = await encryptPushPayload(
			subscription.p256dh,
			subscription.auth,
			encodePayload(payload)
		));
	} catch (error) {
		debug.warn(
			'notification',
			`Dropping subscription with undecryptable keys for user ${subscription.user_id}:`,
			error
		);
		return 'stale';
	}

	let authorization: string;
	try {
		authorization = await createVapidAuthorizationHeader(
			audience,
			getVapidSubject(),
			await getVapidKeys()
		);
	} catch (error) {
		debug.warn('notification', 'Failed to sign VAPID JWT:', error);
		return 'failed';
	}

	let response: Response;
	try {
		response = await fetch(subscription.endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Encoding': 'aes128gcm',
				Authorization: authorization,
				TTL: String(PUSH_TTL_SECONDS),
				Urgency: 'normal'
			},
			body
		});
	} catch (error) {
		debug.warn('notification', `Push service unreachable for user ${subscription.user_id}:`, error);
		return 'failed';
	}

	if (response.status === 404 || response.status === 410) return 'stale';
	if (response.status === 413) {
		debug.warn('notification', `Push payload too large for user ${subscription.user_id}`);
		return 'failed';
	}
	if (!response.ok) {
		debug.warn('notification', `Push service answered ${response.status} for user ${subscription.user_id}`);
		return 'failed';
	}
	return 'sent';
}

/**
 * Notify every device a user registered. Resolves to how many pushes the
 * services accepted. Never rejects.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
	let subscriptions: PushSubscription[];
	try {
		subscriptions = pushSubscriptionQueries.listByUser(userId);
	} catch (error) {
		debug.warn('notification', `Failed to load subscriptions for user ${userId}:`, error);
		return 0;
	}
	if (subscriptions.length === 0) return 0;

	let sent = 0;
	for (const subscription of subscriptions) {
		try {
			const outcome = await postPush(subscription, payload);
			if (outcome === 'sent') {
				sent += 1;
			} else if (outcome === 'stale') {
				try {
					pushSubscriptionQueries.deleteStaleByEndpoint(subscription.endpoint);
				} catch (error) {
					debug.warn('notification', 'Failed to prune stale subscription:', error);
				}
			}
		} catch (error) {
			debug.warn('notification', 'Unexpected push failure:', error);
		}
	}
	return sent;
}

/** Validate the two key fields of an incoming subscription before storing. */
export function isValidSubscriptionKeys(p256dh: unknown, auth: unknown): boolean {
	if (typeof p256dh !== 'string' || typeof auth !== 'string') return false;
	try {
		return base64UrlDecode(p256dh).length === 65 && base64UrlDecode(auth).length >= 16;
	} catch {
		return false;
	}
}

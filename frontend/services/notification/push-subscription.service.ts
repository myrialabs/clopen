/**
 * Web Push subscription management (mobile background path).
 *
 * Desktop never touches this module: its notifications are raised locally by
 * the open tab. On mobile, enabling the push toggle additionally registers a
 * PushSubscription with the server, so chat completions fan out through the
 * push service and arrive even after Chrome is closed.
 *
 * Presence in the server table IS the opt-in: only subscribed devices ever
 * receive server pushes, so the send path needs no per-user setting lookup.
 * The toggle keeps that true in both directions — switching it off purges
 * every device this user registered, not just the one in front of them,
 * because `pushNotifications` is one setting shared across their devices.
 */

import { authStore } from '$frontend/stores/features/auth.svelte';

import { debug } from '$shared/utils/logger';
import {
	ensurePushServiceWorker,
	isMobileDevice,
	isPushSecureContext,
	isServiceWorkerSupported
} from './service-worker-notifications';

export type SubscriptionSyncResult = 'synced' | 'unavailable' | 'failed';
export type ServerTestResult = 'shown' | 'unconfirmed' | 'no-subscription' | 'failed';

/**
 * What the settings UI reports under the Test Push button.
 * - `insecure-context`: the app was opened over plain HTTP (a LAN address),
 *   where no browser exposes service workers. Fixed by the origin, not the
 *   browser — hence its own state rather than `unsupported`.
 * - `unsupported`: not a mobile browser, or no service worker / push manager.
 * - `permission-needed`: notifications not granted yet.
 * - `active`: this device holds a push subscription (background works).
 * - `inactive`: permission granted but no subscription (toggle it to register).
 */
export type DevicePushStatus =
	| 'insecure-context'
	| 'unsupported'
	| 'permission-needed'
	| 'active'
	| 'inactive';

/** Local device state only — never implies the server still holds the row. */
export async function getDevicePushStatus(): Promise<DevicePushStatus> {
	if (!isMobileDevice()) return 'unsupported';
	if (!isPushSecureContext()) return 'insecure-context';
	if (!isServiceWorkerSupported()) return 'unsupported';
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
		return 'permission-needed';
	}
	try {
		const registration = await ensurePushServiceWorker();
		const subscription = await registration?.pushManager.getSubscription();
		return subscription ? 'active' : 'inactive';
	} catch {
		return 'inactive';
	}
}

// How long Test Push polls the worker for the server-sent toast before
// calling it unconfirmed. Server push crosses the network (app → push
// service → device), so this budget is far larger than the local 2s window.
const SERVER_TEST_POLL_MS = 12_000;
const SERVER_TEST_POLL_INTERVAL_MS = 500;

function authJsonHeaders(): Record<string, string> | null {
	const token = authStore.sessionToken;
	if (!token) return null;
	return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
	const padded = base64.replace(/-/g, '+').replace(/_/g, '/');
	const padded2 = padded + '='.repeat((4 - (padded.length % 4)) % 4);
	const binary = atob(padded2);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/**
 * Subscribe this device and register the subscription server-side.
 * Idempotent: an existing subscription is re-synced, never duplicated.
 */
export async function ensurePushSubscription(): Promise<SubscriptionSyncResult> {
	if (!isMobileDevice() || !isPushSecureContext() || !isServiceWorkerSupported()) {
		return 'unavailable';
	}
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
		return 'failed';
	}

	const registration = await ensurePushServiceWorker();
	if (!registration || !('pushManager' in registration)) return 'failed';

	const headers = authJsonHeaders();
	if (!headers) return 'failed';

	let vapidPublicKey: string;
	try {
		const keyRes = await fetch('/api/push/vapid-public-key', { headers });
		if (!keyRes.ok) return 'failed';
		vapidPublicKey = ((await keyRes.json()) as { publicKey?: string }).publicKey ?? '';
		if (!vapidPublicKey) return 'failed';
	} catch (error) {
		debug.warn('notification', 'Failed to fetch VAPID public key:', error);
		return 'failed';
	}

	try {
		let subscription = await registration.pushManager.getSubscription();
		subscription ??= await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource
		});

		const json = subscription.toJSON();
		const res = await fetch('/api/push/subscriptions', {
			method: 'POST',
			headers,
			body: JSON.stringify({
				endpoint: subscription.endpoint,
				keys: json.keys,
				userAgent: window.navigator.userAgent
			})
		});
		return res.ok ? 'synced' : 'failed';
	} catch (error) {
		// subscribe() rejects outside an installed PWA on iOS, when the user
		// dismisses the permission prompt, or when the push service errs.
		debug.warn('notification', 'Push subscription failed:', error);
		return 'failed';
	}
}

/**
 * Turn background push off for this user, everywhere.
 *
 * `pushNotifications` is a single per-user setting synced across devices, so
 * switching it off on a laptop has to silence the phone too — otherwise the
 * phone keeps buzzing while every settings screen reads "off". The server
 * purge therefore runs unconditionally, including from desktops that never
 * registered a subscription of their own; the local `unsubscribe()` below is
 * the extra step only a registered device can take.
 *
 * Best-effort throughout: a failure here must never trap the toggle in the
 * on position.
 */
export async function removePushSubscription(): Promise<void> {
	const headers = authJsonHeaders();
	if (headers) {
		await fetch('/api/push/subscriptions', {
			method: 'DELETE',
			headers,
			body: JSON.stringify({ all: true })
		}).catch((error) => {
			debug.warn('notification', 'Failed to purge push subscriptions:', error);
		});
	}

	try {
		if (!isServiceWorkerSupported()) return;
		const registration = await ensurePushServiceWorker();
		const subscription = await registration?.pushManager.getSubscription();
		await subscription?.unsubscribe().catch(() => false);
	} catch (error) {
		debug.warn('notification', 'Push unsubscription failed:', error);
	}
}

/**
 * Test Push through the real server→push-service→device path.
 *
 * The server sends to this user's subscriptions with the given tag; the
 * service worker raises the toast on the `push` event. Polling the worker's
 * displayed notifications proves background delivery end to end.
 */
export async function sendTestPushViaServer(tag: string): Promise<ServerTestResult> {
	const headers = authJsonHeaders();
	if (!headers) return 'failed';

	const registration = await ensurePushServiceWorker();
	if (!registration) return 'failed';

	let sent = 0;
	try {
		const res = await fetch('/api/push/test', {
			method: 'POST',
			headers,
			body: JSON.stringify({ tag })
		});
		if (!res.ok) return 'failed';
		sent = ((await res.json()) as { sent?: number }).sent ?? 0;
	} catch (error) {
		debug.warn('notification', 'Server test push failed:', error);
		return 'failed';
	}

	if (sent === 0) return 'no-subscription';

	const deadline = Date.now() + SERVER_TEST_POLL_MS;
	while (Date.now() < deadline) {
		try {
			const shown = await registration.getNotifications({ tag });
			if (shown.length > 0) return 'shown';
		} catch {
			// getNotifications is not universal; keep polling until timeout.
		}
		await new Promise((resolve) => setTimeout(resolve, SERVER_TEST_POLL_INTERVAL_MS));
	}
	return 'unconfirmed';
}

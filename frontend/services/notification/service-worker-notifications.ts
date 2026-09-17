/**
 * Service-worker notification route (mobile).
 *
 * Chrome on Android throws on `new Notification()` — service workers are the
 * only route there — and iOS only displays web notifications for an installed
 * web app via its service worker. Desktop never uses this module: it keeps
 * going through `new Notification()` in `push.service.ts`, which is
 * synchronous, preserves the OS `show` event, and is already proven.
 *
 * Notifications raised here are owned by the worker, not the page, so they
 * survive in the notification shade when the tab is backgrounded. Tapping
 * one focuses or opens the app (see `static/sw.js`).
 */

import { debug } from '$shared/utils/logger';

/** Pure UA check, kept separate so it can be pinned by tests. */
export function isMobileUserAgent(ua: string): boolean {
	return /android|iphone|ipad|ipod|windows phone|mobile/i.test(ua);
}

/**
 * Whether this looks like a phone or tablet. UA-based on purpose: a coarse
 * pointer alone would also match Windows touch laptops, which must stay on
 * the desktop path.
 */
export function isMobileDevice(): boolean {
	if (typeof window === 'undefined' || typeof window.navigator === 'undefined') return false;
	return isMobileUserAgent(window.navigator.userAgent || '');
}

export function isServiceWorkerSupported(): boolean {
	if (typeof window === 'undefined') return false;
	return 'serviceWorker' in window.navigator;
}

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Register `/sw.js` once and reuse the registration. Best-effort: any
 * failure (insecure context, unsupported browser, failed fetch) resolves to
 * null so callers can fall through to the desktop path or report why.
 */
export function ensurePushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
	if (!isServiceWorkerSupported()) return Promise.resolve(null);

	registrationPromise ??= (async () => {
		try {
			const registration = await window.navigator.serviceWorker.register('/sw.js', {
				scope: '/'
			});
			// Do not await `ready` here: `register()` already resolves with a
			// usable registration, and waiting would stall Test Push behind
			// worker activation on a cold start.
			return registration;
		} catch (error) {
			debug.warn('notification', 'Service worker registration failed:', error);
			registrationPromise = null;
			return null;
		}
	})();

	return registrationPromise;
}

/** Register ahead of the first notification; callers do not wait on this. */
export function warmPushServiceWorker(): void {
	void ensurePushServiceWorker();
}

/**
 * Show a notification owned by the service worker.
 *
 * `showNotification()` resolving without throwing is the acceptance signal —
 * unlike `new Notification()` it returns void, so there is no `show` event
 * to wait for. When a tag is given the registration is additionally asked
 * what it has displayed; finding our tag is positive confirmation, while not
 * finding it still counts as shown (some platforms report asynchronously).
 */
export async function showServiceWorkerNotification(
	title: string,
	options: NotificationOptions & { tag: string }
): Promise<'shown' | 'failed'> {
	const registration = await ensurePushServiceWorker();
	if (!registration || typeof registration.showNotification !== 'function') {
		return 'failed';
	}

	try {
		await registration.showNotification(title, {
			icon: '/favicon.svg',
			badge: '/favicon.svg',
			...options,
			data: { url: '/', ...((options.data as Record<string, unknown> | undefined) ?? {}) }
		});
	} catch (error) {
		debug.warn('notification', 'Service worker showNotification failed:', error);
		return 'failed';
	}

	try {
		const shown = await registration.getNotifications({ tag: options.tag });
		if (shown.length > 0) return 'shown';
	} catch {
		// `getNotifications` is not universal; the resolved
		// `showNotification()` above is evidence enough.
	}

	return 'shown';
}

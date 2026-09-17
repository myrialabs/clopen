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
import { notificationIcon } from './notification-icon';

/**
 * Where the page leaves a rasterised notification icon for the worker.
 *
 * `static/sw.js` cannot rasterise `/favicon.svg` itself — it has no DOM and
 * Chromium's notification pipeline has no SVG decoder, so a server-sent push
 * would show with no icon at all on Android, which is the platform this
 * whole path exists for (see `notification-icon.ts` for the desktop half of
 * the same bug). The page therefore writes the PNG data URL into the Cache
 * API, which survives the worker being torn down between push events, and
 * the worker reads the text back out. Nothing else is cached, and no `fetch`
 * handler is involved: the cached body is a data URL string, used directly
 * as the notification's `icon`.
 */
const ICON_CACHE = 'clopen-notification-icon';
const ICON_CACHE_KEY = '/__clopen/notification-icon';

/**
 * Pure UA check, kept separate so it can be pinned by tests.
 *
 * `maxTouchPoints` is not decoration: iPadOS 13+ Safari requests desktop
 * sites by default and sends a UA byte-identical to macOS Safari — no
 * `iPad`, no `Mobile`. A UA-only check therefore routes every modern iPad to
 * the desktop path, where `new Notification()` does not exist on iOS/iPadOS
 * at all, so the notification is silently lost. Touch points separate the
 * two: a Mac reports 0, an iPad reports 5. Windows touch laptops are not
 * caught by this branch because it is gated on a Macintosh UA.
 */
export function isMobileUserAgent(ua: string, maxTouchPoints = 0): boolean {
	if (/android|iphone|ipad|ipod|windows phone|mobile/i.test(ua)) return true;
	return /macintosh/i.test(ua) && maxTouchPoints > 1;
}

/**
 * Whether this looks like a phone or tablet. UA-based on purpose: a coarse
 * pointer alone would also match Windows touch laptops, which must stay on
 * the desktop path.
 */
export function isMobileDevice(): boolean {
	if (typeof window === 'undefined' || typeof window.navigator === 'undefined') return false;
	return isMobileUserAgent(window.navigator.userAgent || '', window.navigator.maxTouchPoints ?? 0);
}

export function isServiceWorkerSupported(): boolean {
	if (typeof window === 'undefined') return false;
	return 'serviceWorker' in window.navigator;
}

/**
 * Whether this browser can receive a server-sent push.
 *
 * Deliberately not the same question as `isMobileDevice()`. That one asks
 * how a notification the PAGE raises should be displayed, and the answer is
 * device-specific because `new Notification()` throws on Android. Background
 * delivery asks something else entirely — whether a push service can wake a
 * worker here — and every modern desktop browser can, so the two must not
 * share a gate. Requires a secure context, which is checked by the caller so
 * a plain-HTTP origin can be reported as its own cause.
 */
export function isBackgroundPushSupported(): boolean {
	if (typeof window === 'undefined') return false;
	return isServiceWorkerSupported() && 'PushManager' in window && isPushSecureContext();
}

/**
 * Service workers, and therefore Web Push, only exist in a secure context —
 * HTTPS or `localhost`. Clopen is routinely opened over plain HTTP on a LAN
 * address (`http://192.168.1.5:9141`), where `navigator.serviceWorker` is
 * simply absent. That is an origin problem, not a browser problem, so it is
 * reported separately: the fix is to reach the app over HTTPS (the
 * Cloudflare tunnel from Remote Access does this), not to switch browsers.
 */
export function isPushSecureContext(): boolean {
	if (typeof window === 'undefined') return false;
	return window.isSecureContext === true;
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

/**
 * Hand the rasterised icon to the worker. Best-effort: on failure the worker
 * falls back to `/favicon.svg`, which is exactly today's behaviour.
 */
async function publishNotificationIconForWorker(): Promise<void> {
	if (typeof caches === 'undefined') return;
	try {
		const icon = await notificationIcon();
		if (!icon.startsWith('data:')) return;
		const cache = await caches.open(ICON_CACHE);
		await cache.put(ICON_CACHE_KEY, new Response(icon, { headers: { 'Content-Type': 'text/plain' } }));
	} catch (error) {
		debug.warn('notification', 'Failed to publish the notification icon to the worker:', error);
	}
}

/** Register ahead of the first notification; callers do not wait on this. */
export function warmPushServiceWorker(): void {
	void ensurePushServiceWorker().then((registration) => {
		if (registration) void publishNotificationIconForWorker();
	});
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

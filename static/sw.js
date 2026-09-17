/**
 * Clopen service worker.
 *
 * Exists for one reason: mobile notifications. Chrome on Android does not
 * support `new Notification()` from a page — construction throws — and only
 * a service worker's `registration.showNotification()` can raise a native
 * toast there. iOS (16.4+) likewise only displays web notifications for an
 * installed web app via its service worker. Desktop keeps using
 * `new Notification()` directly and never touches this file.
 *
 * This worker has no fetch handler and caches nothing of its own. It only:
 * - raises a toast for a server-sent `push` (the one path that works with
 *   the tab closed) and for explicit `showNotification()` calls from the page,
 * - focuses or opens the app when a notification is tapped,
 * - dismisses cleanly on swipe.
 */

self.addEventListener('notificationclick', (event) => {
	event.notification.close();

	const url = (event.notification.data && event.notification.data.url) || '/';

	event.waitUntil(
		(async () => {
			const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of allClients) {
				// Reuse the open tab instead of spawning a duplicate.
				if ('focus' in client) {
					try {
						await client.focus();
					} catch {
						// A closed or detached client — try the next one.
						continue;
					}
					if ('navigate' in client && client.url !== url) {
						try {
							await client.navigate(url);
						} catch {
							// Navigation is best-effort; the focused tab is enough.
						}
					}
					return;
				}
			}
			if (self.clients.openWindow) {
				await self.clients.openWindow(url);
			}
		})()
	);
});

self.addEventListener('notificationclose', () => {
	// No bookkeeping to do — present so a dismissed toast settles quietly.
});

/**
 * The notification icon, as a PNG data URL the page rasterised and left in
 * the Cache API.
 *
 * `/favicon.svg` cannot be used directly: Chromium decodes notification
 * images with its raster decoders, which have no SVG support, so an Android
 * push would arrive with no icon — the same gap `notification-icon.ts`
 * already closes for desktop. Reading it here (rather than holding it in a
 * variable) is deliberate: the worker is torn down between push events, so
 * in-memory state would never survive to the one delivery that matters.
 */
async function notificationIconUrl() {
	try {
		const cached = await caches.match('/__clopen/notification-icon');
		if (!cached) return '/favicon.svg';
		const dataUrl = await cached.text();
		return dataUrl.startsWith('data:') ? dataUrl : '/favicon.svg';
	} catch {
		return '/favicon.svg';
	}
}

self.addEventListener('push', (event) => {
	// Server-sent push (chat completions, waiting-for-input, test pushes).
	// This is what wakes the device when Chrome is closed: the page is gone,
	// but the worker still runs and raises the native toast. A malformed
	// payload must never crash the worker.
	let data = null;
	try {
		data = event.data ? event.data.json() : null;
	} catch {
		return;
	}
	if (!data || typeof data.title !== 'string' || !data.title) return;

	// The tag is identity: it matches the local toast the open tab shows for
	// the same event, so the two collapse into one instead of stacking.
	const tag =
		typeof data.tag === 'string' && data.tag ? data.tag : `push-${Date.now()}`;

	event.waitUntil(
		(async () => {
			const icon = await notificationIconUrl();
			await self.registration.showNotification(data.title, {
				body: typeof data.body === 'string' ? data.body : '',
				tag,
				icon,
				badge: icon,
				// Buzz on Android; silently ignored where unsupported (iOS/desktop).
				vibrate: [100, 50, 100],
				renotify: false,
				requireInteraction: false,
				data: { url: typeof data.url === 'string' && data.url ? data.url : '/' }
			});
		})()
	);
});

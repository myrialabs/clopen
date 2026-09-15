/**
 * Native Push Notification Service
 * 
 * Handles native browser push notifications for chat responses
 */

import { settings } from '$frontend/stores/features/settings.svelte';
import { isWindows } from '$frontend/utils/platform';

import { debug } from '$shared/utils/logger';
// Check if browser supports notifications
function isSupported(): boolean {
	return typeof window !== 'undefined' && 'Notification' in window;
}

// Get current permission status
function getPermissionStatus(): NotificationPermission | null {
	if (!isSupported()) return null;
	return Notification.permission;
}

// Request notification permission
async function requestPermission(): Promise<NotificationPermission> {
	if (!isSupported()) {
		throw new Error('Notifications not supported');
	}
	
	const permission = await Notification.requestPermission();
	return permission;
}

// Check if the current context allows notifications (secure context required).
// Additive helper for better error messaging — does not change existing behavior.
function isContextValid(): boolean {
	if (typeof window !== 'undefined' && 'isSecureContext' in window) {
		return window.isSecureContext;
	}
	return true;
}

// How long Test Push waits for the OS to confirm display via `onshow`
// before reporting failure instead of a false-success (1.5–2s range).
// This only affects the failure path — success resolves on the event.
const TEST_SHOW_TIMEOUT_MS = 1800;

// Monotonic counter so every Test Push gets a unique tag. The tag must stay
// unique per click: reusing a tag makes the new notification replace the
// previous one (same-tag coalescing), which breaks the 1:1 contract of
// N clicks → N banners. Combined with Date.now() it stays unique across reloads.
let testNotificationCounter = 0;

// Preload the notification icon at module load so Chrome doesn't pay a
// fetch on click time — the native banner can hand off to Windows sooner.
// No visual or behavior change anywhere (same URL, cached by the browser).
if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
	try {
		const preload = new Image();
		preload.src = '/favicon.svg';
	} catch {
		// Preload is best-effort only; the notification path is unaffected.
	}
}

// Send native push notification
// Returns true when a native notification object was created, false when blocked.
async function sendNotification(
	title: string,
	options: NotificationOptions = {},
	isTesting: boolean = false
): Promise<boolean> {
	// Check if push notifications are enabled in settings
	if (!isTesting && !settings.pushNotifications) {
		return false;
	}

	// Check browser support
	if (!isSupported()) {
		debug.warn('notification', 'Native notifications not supported');
		return false;
	}

	// Check permission
	const permission = getPermissionStatus();
	if (permission !== 'granted') {
		debug.warn('notification', 'Notification permission not granted:', permission);
		return false;
	}
	
	try {
		const notification = new Notification(title, {
			icon: '/favicon.svg',
			badge: '/favicon.svg',
			...options
		});
		
		// Auto-close notification after 5 seconds
		setTimeout(() => {
			notification.close();
		}, 5000);

		return true;
	} catch (error) {
		debug.warn('notification', 'Failed to send notification:', error);
		return false;
	}
}

// Public API
export const pushNotification = {
	/**
	 * Check if notifications are supported
	 */
	isSupported,
	
	/**
	 * Get current permission status
	 */
	getPermissionStatus,
	
	/**
	 * Request notification permission from user
	 */
	requestPermission,
	
	/**
	 * Send notification for chat response completion
	 */
	async sendChatComplete(message?: string): Promise<void> {
		await sendNotification('Claude Response Complete', {
			body: message || 'Your chat response is ready',
			tag: 'chat-complete'
		});
	},
	
	/**
	 * Send notification for chat error
	 */
	async sendChatError(error?: string): Promise<void> {
		await sendNotification('Claude Response Error', {
			body: error || 'There was an error with your chat response',
			tag: 'chat-error'
		});
	},
	
	/**
	 * Test notification (for settings only).
	 *
	 * 1:1 contract: every call fires its own independent Notification event
	 * with a unique tag and never touches any other notification — no close,
	 * no shared slot, no queue, no artificial waits. N rapid clicks therefore
	 * produce N native banners (all alive simultaneously, all listed in the
	 * Windows Action Center) plus N in-app toasts instead of collapsing to
	 * one. Pacing of simultaneous banners is left to the OS.
	 *
	 * Readability contract (Windows): the banner persists until dismissed
	 * (requireInteraction, no auto-close), so even banners shown later in a
	 * burst get a full readable lifetime instead of being cut by a timer
	 * that started at creation time.
	 *
	 * Unlike the chat path (sendNotification), this waits for the OS to
	 * confirm display via `onshow` before resolving true, so the in-app
	 * success toast can only appear after the native toast is confirmed.
	 * If `onshow` never fires within the timeout (e.g. Windows swallowed
	 * the toast at OS level), resolves false instead of a false-success.
	 * Chat methods (sendChatComplete/sendChatError) are intentionally
	 * untouched and still resolve on creation.
	 */
	async testNotification(): Promise<boolean> {
		try {
			if (!isSupported()) {
				debug.warn('notification', 'Native notifications not supported');
				return false;
			}

			const permission = getPermissionStatus();
			if (permission !== 'granted') {
				debug.warn('notification', 'Notification permission not granted:', permission);
				return false;
			}

			const notification = new Notification('Test Notification', {
				icon: '/favicon.svg',
				badge: '/favicon.svg',
				body: 'Push notifications are working correctly',
				tag: `test-${Date.now()}-${++testNotificationCounter}`,
				// Windows-only: keep the banner on screen until the user dismisses
				// it, so every banner in a rapid burst stays readable for as long
				// as needed instead of vanishing on a timer. Other platforms get
				// byte-identical options (macOS behavior untouched; Safari ignores
				// this flag anyway).
				...(isWindows() ? { requireInteraction: true } : {})
			});

			const shown = await new Promise<boolean>((resolve) => {
				let settled = false;
				const timer = setTimeout(() => {
					if (!settled) {
						settled = true;
						resolve(false);
					}
				}, TEST_SHOW_TIMEOUT_MS);
				notification.onshow = () => {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						resolve(true);
					}
				};
				notification.onerror = () => {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						resolve(false);
					}
				};
			});

			if (!shown) {
				debug.warn('notification', 'Test notification not confirmed by OS (onshow timeout)');
				try {
					notification.close();
				} catch {
					// Ignore close errors for an unshown notification.
				}
				return false;
			}

			// Lifetime management is per-notification and never touches others.
			// Windows: no auto-close — with requireInteraction the banner stays
			// until the user dismisses it, so a queued banner can never be cut
			// off by a timer that started at creation time. The user clears
			// test entries via Dismiss / Clear all in the Action Center.
			// Other platforms: keep the existing 5s auto-dismiss (unchanged).
			if (!isWindows()) {
				setTimeout(() => {
					try {
						notification.close();
					} catch {
						// Ignore close errors on auto-dismiss.
					}
				}, 5000);
			}

			return true;
		} catch (error) {
			debug.error('notification', 'Test notification failed:', error);
			return false;
		}
	},

	/**
	 * Whether the current browsing context allows the Notification API.
	 * False for insecure contexts (e.g. plain http://<LAN-IP>), which
	 * commonly affects Windows users opening the app via IP/hostname.
	 */
	isContextValid,
	
	/**
	 * Initialize and request permissions if needed
	 */
	async initialize(): Promise<boolean> {
		if (!isSupported()) {
			return false;
		}

		const currentPermission = getPermissionStatus();

		if (currentPermission === 'default') {
			try {
				const permission = await requestPermission();
				return permission === 'granted';
			} catch (error) {
				debug.warn('notification', 'Failed to request notification permission:', error);
				return false;
			}
		}

		return currentPermission === 'granted';
	}
};

export default pushNotification;
/**
 * Native Push Notification Service
 *
 * Handles native browser push notifications for chat responses.
 *
 * Every notification — chat and test alike — goes through `createNotification`
 * so that Test Push exercises the exact path a finished chat takes. A test
 * that runs its own code proves nothing about the thing it is testing.
 */

import { settings } from '$frontend/stores/features/settings.svelte';

import { debug } from '$shared/utils/logger';
import { notificationIcon } from './notification-icon';
import { uniqueNotificationTag, waitForNotificationShown } from './native-notification';

/**
 * Why a notification never reached the OS. Reported back to callers instead
 * of being swallowed, so the UI can say which switch the user has to flip.
 */
export type NotificationBlockReason =
	| 'insecure-context'
	| 'unsupported'
	| 'permission-denied'
	| 'permission-default'
	| 'creation-failed';

export type TestNotificationResult =
	| { outcome: 'shown' }
	| { outcome: 'unconfirmed' }
	| { outcome: 'blocked'; reason: NotificationBlockReason };

// How long Test Push waits for the OS `show` event before reporting the
// result as unconfirmed. Long enough for a cold notification daemon on Linux
// or a busy Action Center on Windows, short enough that the button does not
// feel stuck.
const TEST_SHOW_TIMEOUT_MS = 2000;

// Check if browser supports notifications
function isSupported(): boolean {
	return typeof window !== 'undefined' && 'Notification' in window;
}

// Whether the page may use the Notification API at all. Browsers gate it
// behind a secure context, so reaching the app over plain http://<LAN-IP> —
// the normal way to open Clopen from another machine — disables
// notifications regardless of the permission state.
function isContextValid(): boolean {
	if (typeof window === 'undefined') return false;
	if (!('isSecureContext' in window)) return true;
	return window.isSecureContext;
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

/** Why the current environment cannot show a notification, or null if it can. */
function blockReason(): NotificationBlockReason | null {
	// Ordered before the support check on purpose: an insecure origin is why
	// `Notification` is undefined, and "unsupported browser" would send the
	// user looking in entirely the wrong place.
	if (!isContextValid()) return 'insecure-context';
	if (!isSupported()) return 'unsupported';

	const permission = getPermissionStatus();
	if (permission === 'denied') return 'permission-denied';
	if (permission !== 'granted') return 'permission-default';

	return null;
}

type CreateResult =
	| { notification: Notification; reason?: undefined }
	| { notification?: undefined; reason: NotificationBlockReason };

/**
 * The single path to a native notification.
 *
 * Deliberately never calls `close()`. The previous auto-close after five
 * seconds also removed the notification from the Windows Action Center,
 * which is the only place a user who stepped away from the machine would
 * ever have found it — a notification you must be watching to receive is
 * not a notification.
 */
async function createNotification(
	title: string,
	options: NotificationOptions
): Promise<CreateResult> {
	const reason = blockReason();
	if (reason) {
		debug.warn('notification', 'Notification suppressed:', reason);
		return { reason };
	}

	const icon = await notificationIcon();

	try {
		return {
			notification: new Notification(title, {
				icon,
				badge: icon,
				...options
			})
		};
	} catch (error) {
		// Chrome on Android throws here: plain construction is unsupported
		// and service workers are the only route.
		debug.warn('notification', 'Failed to create notification:', error);
		return { reason: 'creation-failed' };
	}
}

/** Send a chat notification, honouring the user's push setting. */
async function sendChatNotification(title: string, body: string, tagPrefix: string): Promise<void> {
	if (!settings.pushNotifications) return;

	await createNotification(title, {
		body,
		// A fresh tag per notification. Reusing one replaces the live
		// notification instead of raising a new one, silently on Chrome, so
		// several finished chats collapsed into a single toast.
		tag: uniqueNotificationTag(tagPrefix)
	});
}

// Public API
export const pushNotification = {
	/**
	 * Check if notifications are supported
	 */
	isSupported,

	/**
	 * Whether the browsing context permits notifications (secure context).
	 */
	isContextValid,

	/**
	 * Get current permission status
	 */
	getPermissionStatus,

	/**
	 * Request notification permission from user
	 */
	requestPermission,

	/**
	 * Why the current environment cannot show a notification, or null if it
	 * can. Lets callers explain the failure instead of guessing at it.
	 */
	blockReason,

	/**
	 * Send notification for chat response completion
	 */
	async sendChatComplete(message?: string): Promise<void> {
		await sendChatNotification(
			'Claude Response Complete',
			message || 'Your chat response is ready',
			'chat-complete'
		);
	},

	/**
	 * Send notification for chat error
	 */
	async sendChatError(error?: string): Promise<void> {
		await sendChatNotification(
			'Claude Response Error',
			error || 'There was an error with your chat response',
			'chat-error'
		);
	},

	/**
	 * Test notification (for settings).
	 *
	 * Identical to a chat notification apart from the wording and the fact
	 * that it waits for the OS `show` event, so a passing test is evidence
	 * about the real path rather than about itself. `unconfirmed` means the
	 * OS never acknowledged the toast — distinct from `blocked`, because a
	 * few platforms display notifications without emitting `show`.
	 */
	async testNotification(): Promise<TestNotificationResult> {
		const { notification, reason } = await createNotification('Test Notification', {
			body: 'Push notifications are working correctly',
			tag: uniqueNotificationTag('test')
		});

		if (!notification) return { outcome: 'blocked', reason };

		const result = await waitForNotificationShown(notification, TEST_SHOW_TIMEOUT_MS);
		if (result === 'shown') return { outcome: 'shown' };
		if (result === 'blocked') return { outcome: 'blocked', reason: 'creation-failed' };

		// The notification is left alone when unconfirmed rather than closed:
		// it may well be on screen, and closing it would destroy the evidence
		// the user is being asked to look for.
		return { outcome: 'unconfirmed' };
	},

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
				// Firefox rejects the request outside a user gesture, and in
				// private windows.
				debug.warn('notification', 'Permission request failed:', error);
				return false;
			}
		}

		return currentPermission === 'granted';
	}
};

export default pushNotification;

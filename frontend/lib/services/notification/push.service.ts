/**
 * Native Push Notification Service
 * 
 * Handles native browser push notifications for chat responses
 */

import { settings } from '$frontend/lib/stores/features/settings.svelte';

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

// Send native push notification
async function sendNotification(
	title: string,
	options: NotificationOptions = {},
	isTesting: boolean = false
): Promise<void> {
	// Check if push notifications are enabled in settings
	if (!isTesting && !settings.pushNotifications) {
		return;
	}
	
	// Check browser support
	if (!isSupported()) {
		debug.warn('notification', 'Native notifications not supported');
		return;
	}
	
	// Check permission
	const permission = getPermissionStatus();
	if (permission !== 'granted') {
		debug.warn('notification', 'Notification permission not granted:', permission);
		return;
	}
	
	try {
		const notification = new Notification(title, {
			icon: '/favicon.ico',
			badge: '/favicon.ico',
			...options
		});
		
		// Auto-close notification after 5 seconds
		setTimeout(() => {
			notification.close();
		}, 5000);
		
	} catch (error) {
		debug.warn('notification', 'Failed to send notification:', error);
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
	 * Test notification (for settings)
	 */
	async testNotification(): Promise<boolean> {
		try {
			await sendNotification('Test Notification', {
				body: 'Push notifications are working correctly',
				tag: 'test'
			}, true);
			return true;
		} catch (error) {
			debug.error('notification', 'Test notification failed:', error);
			return false;
		}
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
			const permission = await requestPermission();
			return permission === 'granted';
		}
		
		return currentPermission === 'granted';
	}
};

export default pushNotification;
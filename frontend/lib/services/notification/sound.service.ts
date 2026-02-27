/**
 * Sound Notification Service
 * 
 * Handles single audio notification for chat responses using local notification.ogg file
 */

import { settings } from '$frontend/lib/stores/features/settings.svelte';

import { debug } from '$shared/utils/logger';
// Cache for audio element
let audioElement: HTMLAudioElement | null = null;

// Local notification sound file path
const NOTIFICATION_SOUND_URL = '/audio/notification.ogg';

// Initialize audio element
function initAudioElement(): HTMLAudioElement {
	if (!audioElement) {
		audioElement = new Audio();
		audioElement.preload = 'auto';
		audioElement.volume = 1;

		// Set the notification sound URL
		audioElement.src = NOTIFICATION_SOUND_URL;

		// Load the audio to check if it works
		audioElement.load();

		// Handle loading errors
		audioElement.onerror = (error) => {
			debug.warn('notification', 'Failed to load notification sound from:', NOTIFICATION_SOUND_URL, error);
		};

		// Log when audio is ready
		audioElement.oncanplaythrough = () => {
			debug.log('notification', 'Notification sound loaded successfully');
		};
	}
	return audioElement;
}

// Play notification sound
function playNotificationSound(isTesting: boolean = false): Promise<void> {
	return new Promise((resolve) => {
		try {
			// Check if sound notifications are enabled
			if (!isTesting && !settings.soundNotifications) {
				resolve();
				return;
			}

			// Check if browser supports HTML5 Audio
			if (typeof window === 'undefined' || !window.Audio) {
				resolve(); // Silently fail on unsupported browsers
				return;
			}

			const audio = initAudioElement();
			
			// Reset audio to beginning
			audio.currentTime = 0;
			
			// Play audio
			const playPromise = audio.play();
			
			if (playPromise !== undefined) {
				playPromise
					.then(() => {
						// Audio played successfully
						audio.onended = () => resolve();
					})
					.catch((error) => {
						debug.warn('notification', 'Failed to play notification sound:', error);
						resolve(); // Don't reject, just silently fail
					});
			} else {
				// Older browser support
				audio.onended = () => resolve();
				setTimeout(() => resolve(), 1000); // Fallback timeout
			}
		} catch (error) {
			debug.warn('notification', 'Failed to play notification sound:', error);
			resolve(); // Don't reject, just silently fail
		}
	});
}

// Public API
export const soundNotification = {
	/**
	 * Play notification sound (single sound for all notifications)
	 */
	play(): Promise<void> {
		return playNotificationSound();
	},

	/**
	 * Test sound notification (for settings)
	 */
	async testSound(): Promise<boolean> {
		try {
			await playNotificationSound(true);
			return true;
		} catch (error) {
			debug.error('notification', 'Sound test failed:', error);
			return false;
		}
	},

	/**
	 * Check if sound notifications are supported
	 */
	isSupported(): boolean {
		return typeof window !== 'undefined' && !!window.Audio;
	},

	/**
	 * Initialize audio element (call on user interaction)
	 */
	initialize(): void {
		if (this.isSupported()) {
			initAudioElement();
		}
	}
};

export default soundNotification;
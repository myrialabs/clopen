/**
 * Sound Notification Service
 *
 * Plays a notification sound when a chat response completes. Source can be:
 * - a bundled preset (served from `/audio/<id>.ogg`)
 * - the user's uploaded custom sound (fetched via `/api/audio/custom` with bearer token)
 *
 * Audio elements are cached per resolved source URL so repeat plays are instant.
 * Volume is applied from `settings.notificationVolume` on every play.
 */

import { settings } from '$frontend/stores/features/settings.svelte';
import { authStore } from '$frontend/stores/features/auth.svelte';
import { NOTIFICATION_SOUND_CUSTOM } from '$shared/constants/notification-sounds';

import { debug } from '$shared/utils/logger';

const elementCache = new Map<string, HTMLAudioElement>();
let customBlobUrl: string | null = null;
let customBlobFetchedAt = 0;
const CUSTOM_BLOB_TTL_MS = 60_000;

function presetUrl(id: string): string {
	return `/audio/${id}.ogg`;
}

async function loadCustomBlobUrl(force: boolean): Promise<string | null> {
	const now = Date.now();
	if (!force && customBlobUrl && now - customBlobFetchedAt < CUSTOM_BLOB_TTL_MS) {
		return customBlobUrl;
	}
	const token = authStore.sessionToken;
	if (!token) return null;
	try {
		const res = await fetch('/api/audio/custom', {
			headers: { Authorization: `Bearer ${token}` }
		});
		if (!res.ok) {
			if (customBlobUrl) {
				URL.revokeObjectURL(customBlobUrl);
				customBlobUrl = null;
			}
			return null;
		}
		const blob = await res.blob();
		if (customBlobUrl) URL.revokeObjectURL(customBlobUrl);
		customBlobUrl = URL.createObjectURL(blob);
		customBlobFetchedAt = now;
		return customBlobUrl;
	} catch (error) {
		debug.warn('notification', 'Failed to fetch custom notification sound:', error);
		return null;
	}
}

async function resolveSourceUrl(): Promise<string> {
	const id = settings.notificationSound || 'message';
	if (id === NOTIFICATION_SOUND_CUSTOM) {
		const url = await loadCustomBlobUrl(false);
		// Fallback to a preset if custom is unavailable.
		return url ?? presetUrl('message');
	}
	return presetUrl(id);
}

function getOrCreateElement(src: string): HTMLAudioElement {
	let el = elementCache.get(src);
	if (!el) {
		el = new Audio();
		el.preload = 'auto';
		el.src = src;
		el.load();
		el.onerror = () => {
			debug.warn('notification', 'Failed to load notification sound:', src);
		};
		elementCache.set(src, el);
	}
	return el;
}

async function playNotificationSound(isTesting: boolean): Promise<void> {
	try {
		if (!isTesting && !settings.soundNotifications) return;
		if (typeof window === 'undefined' || !window.Audio) return;

		const src = await resolveSourceUrl();
		const audio = getOrCreateElement(src);
		const volume = settings.notificationVolume;
		audio.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
		audio.currentTime = 0;

		const playPromise = audio.play();
		if (playPromise !== undefined) {
			await playPromise.catch((error) => {
				debug.warn('notification', 'Failed to play notification sound:', error);
			});
		}
	} catch (error) {
		debug.warn('notification', 'Failed to play notification sound:', error);
	}
}

export const soundNotification = {
	/** Play notification sound using the currently-selected source and volume. */
	play(): Promise<void> {
		return playNotificationSound(false);
	},

	/** Test sound — plays regardless of the on/off toggle. */
	async testSound(): Promise<boolean> {
		try {
			await playNotificationSound(true);
			return true;
		} catch (error) {
			debug.error('notification', 'Sound test failed:', error);
			return false;
		}
	},

	/** Play a specific preset directly (used for per-option preview buttons). */
	async previewPreset(id: string): Promise<void> {
		try {
			const audio = getOrCreateElement(presetUrl(id));
			audio.volume = Math.max(0, Math.min(1, settings.notificationVolume ?? 1));
			audio.currentTime = 0;
			await audio.play().catch(() => {});
		} catch (error) {
			debug.warn('notification', 'Preset preview failed:', error);
		}
	},

	/** Play the current custom upload directly (used for the custom preview button). */
	async previewCustom(): Promise<boolean> {
		try {
			const url = await loadCustomBlobUrl(true);
			if (!url) return false;
			const audio = getOrCreateElement(url);
			audio.volume = Math.max(0, Math.min(1, settings.notificationVolume ?? 1));
			audio.currentTime = 0;
			await audio.play().catch(() => {});
			return true;
		} catch (error) {
			debug.warn('notification', 'Custom preview failed:', error);
			return false;
		}
	},

	/** Invalidate the cached custom blob URL — call after upload/delete. */
	invalidateCustomCache(): void {
		if (customBlobUrl) {
			URL.revokeObjectURL(customBlobUrl);
			customBlobUrl = null;
		}
		customBlobFetchedAt = 0;
		// Drop any cached element keyed by the previous blob URL.
		for (const key of [...elementCache.keys()]) {
			if (key.startsWith('blob:')) elementCache.delete(key);
		}
	},

	isSupported(): boolean {
		return typeof window !== 'undefined' && !!window.Audio;
	},

	/** No-op kept for backwards-compatible callers; elements are lazy-created. */
	initialize(): void {
		// Audio elements are created on demand in resolveSourceUrl / getOrCreateElement.
	}
};

export default soundNotification;

/** Notification sound presets bundled with the app (served from /audio/<id>.ogg). */
export const NOTIFICATION_SOUND_PRESETS = [
	{ id: 'message', label: 'Message' },
	{ id: 'chime', label: 'Chime' },
	{ id: 'alert', label: 'Alert' },
	{ id: 'chirp', label: 'Chirp' },
	{ id: 'blip', label: 'Blip' },
	{ id: 'tap', label: 'Tap' },
	{ id: 'cloud', label: 'Cloud' },
	{ id: 'subtle', label: 'Subtle' },
	{ id: 'sparkle', label: 'Sparkle' },
	{ id: 'glass', label: 'Glass' },
	{ id: 'bell', label: 'Bell' },
	{ id: 'woodblock', label: 'Woodblock' }
] as const;

export type NotificationSoundPresetId = (typeof NOTIFICATION_SOUND_PRESETS)[number]['id'];

/** Sentinel value for the user's uploaded custom sound. */
export const NOTIFICATION_SOUND_CUSTOM = 'custom';

/** Accepted upload extensions for custom notification sounds. */
export const NOTIFICATION_SOUND_ALLOWED_EXTS = ['mp3', 'ogg', 'wav', 'm4a'] as const;
export type NotificationSoundExt = (typeof NOTIFICATION_SOUND_ALLOWED_EXTS)[number];

/** Max custom sound size in bytes (500 KB). */
export const NOTIFICATION_SOUND_MAX_BYTES = 500 * 1024;

export function isValidNotificationSoundExt(ext: string): ext is NotificationSoundExt {
	return (NOTIFICATION_SOUND_ALLOWED_EXTS as readonly string[]).includes(ext);
}

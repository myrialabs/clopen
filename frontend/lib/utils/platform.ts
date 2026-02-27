/**
 * Cross-platform keyboard shortcut and platform detection utilities
 */

export type Platform = 'mac' | 'windows' | 'linux' | 'unknown';

/**
 * Detect the current platform
 */
export function detectPlatform(): Platform {
	if (typeof window === 'undefined') {
		// Server-side fallback
		return 'unknown';
	}

	const userAgent = window.navigator.userAgent.toLowerCase();
	const platform = window.navigator.platform.toLowerCase();

	if (platform.includes('mac') || userAgent.includes('mac')) {
		return 'mac';
	}
	
	if (platform.includes('win') || userAgent.includes('win')) {
		return 'windows';
	}
	
	if (platform.includes('linux') || userAgent.includes('linux')) {
		return 'linux';
	}

	return 'unknown';
}

/**
 * Check if the given keyboard event matches the cancel command (Ctrl+C or Cmd+C)
 */
export function isCancelKeyCombo(event: KeyboardEvent): boolean {
	const platform = detectPlatform();
	
	// Check for 'c' key
	if (event.key.toLowerCase() !== 'c') {
		return false;
	}

	// Mac uses Cmd+C, others use Ctrl+C
	if (platform === 'mac') {
		return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
	} else {
		return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
	}
}

/**
 * Check if the given keyboard event matches the clear command (Ctrl+L or Cmd+L)
 */
export function isClearKeyCombo(event: KeyboardEvent): boolean {
	const platform = detectPlatform();
	
	// Check for 'l' key
	if (event.key.toLowerCase() !== 'l') {
		return false;
	}

	// Mac uses Cmd+L, others use Ctrl+L
	if (platform === 'mac') {
		return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
	} else {
		return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
	}
}

/**
 * Get the display name for keyboard shortcuts based on platform
 */
export function getShortcutLabels() {
	const platform = detectPlatform();
	const modifier = platform === 'mac' ? '⌘' : 'Ctrl';
	
	return {
		cancel: `${modifier}+C`,
		clear: `${modifier}+L`,
		modifier: modifier
	};
}

/**
 * Get platform-specific modifier key display
 */
export function getModifierKey(): string {
	const platform = detectPlatform();
	return platform === 'mac' ? '⌘' : 'Ctrl';
}

/**
 * Check if we're on macOS
 */
export function isMac(): boolean {
	return detectPlatform() === 'mac';
}

/**
 * Check if we're on Windows
 */
export function isWindows(): boolean {
	return detectPlatform() === 'windows';
}

/**
 * Check if we're on Linux
 */
export function isLinux(): boolean {
	return detectPlatform() === 'linux';
}
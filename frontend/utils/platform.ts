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
 * Explorer shortcut labels matching the native file manager of each OS:
 * Windows/Linux use Ctrl+C/X/V/A + Delete (File Explorer / Files),
 * macOS uses ⌘C/X/V/A + Delete/Backspace (Finder).
 * Used for tooltips and notification hints so the displayed shortcut always
 * matches what the keyboard handler actually listens for on this OS.
 */
export function getExplorerShortcutLabels() {
	const platform = detectPlatform();
	const modifier = platform === 'mac' ? '⌘' : 'Ctrl';

	return {
		modifier,
		copy: `${modifier}+C`,
		cut: `${modifier}+X`,
		paste: `${modifier}+V`,
		selectAll: `${modifier}+A`,
		deleteKey: platform === 'mac' ? 'Delete/Backspace' : 'Delete'
	};
}

/**
 * True when the event carries the Explorer modifier for this OS:
 * Command (and not Ctrl) on macOS, Ctrl (and not Command) on Windows/Linux.
 * Alt/Shift variants (e.g. Ctrl+Shift+V) are intentionally rejected.
 */
export function isExplorerMod(event: KeyboardEvent): boolean {
	if (event.altKey || event.shiftKey) return false;
	if (detectPlatform() === 'mac') {
		return event.metaKey && !event.ctrlKey;
	}
	return event.ctrlKey && !event.metaKey;
}

/**
 * Native file manager name for this OS (Finder / File Explorer / Files).
 * Used in clipboard guidance so messages match the user's environment.
 */
export function nativeFileManagerName(): string {
	const platform = detectPlatform();
	if (platform === 'mac') return 'Finder';
	if (platform === 'windows') return 'File Explorer';
	if (platform === 'linux') return 'file manager';
	return 'system file manager';
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

/**
 * Check if the app is accessed from the same machine (localhost or 127.0.0.1).
 * Operations like spawning a file manager only make sense locally.
 */
export function isLocalConnection(): boolean {
	if (typeof window === 'undefined') return false;
	const hostname = window.location.hostname;
	return hostname === 'localhost' || hostname === '127.0.0.1';
}
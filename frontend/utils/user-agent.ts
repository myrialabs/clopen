/**
 * Lightweight user-agent parsing for the "Your Devices" / Remote Access session
 * lists. Not exhaustive — just enough to turn a raw UA string into a friendly
 * "Chrome on macOS" label and a matching icon. No dependency.
 */

import type { IconName } from '$shared/types/ui/icons';

export interface ParsedUserAgent {
	browser: string;
	os: string;
	/** "Chrome on macOS" style summary. */
	label: string;
	/** lucide icon name approximating the device form factor. */
	icon: IconName;
	isMobile: boolean;
}

function detectOS(ua: string): string {
	if (/windows nt/i.test(ua)) return 'Windows';
	if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
	if (/android/i.test(ua)) return 'Android';
	if (/mac os x|macintosh/i.test(ua)) return 'macOS';
	if (/cros/i.test(ua)) return 'ChromeOS';
	if (/linux/i.test(ua)) return 'Linux';
	return 'Unknown OS';
}

function detectBrowser(ua: string): string {
	// Order matters — many browsers spoof "Chrome"/"Safari" in their UA.
	if (/edg\//i.test(ua)) return 'Edge';
	if (/opr\/|opera/i.test(ua)) return 'Opera';
	if (/firefox|fxios/i.test(ua)) return 'Firefox';
	if (/chrome|crios/i.test(ua)) return 'Chrome';
	if (/safari/i.test(ua)) return 'Safari';
	return 'Browser';
}

/** Friendly label for how a session was created (provenance badge). */
export function sessionSourceLabel(source: string | null | undefined): string | null {
	switch (source) {
		case 'invite': return 'Joined via invite';
		case 'device-link': return 'Paired device';
		case 'login': return 'Signed in with token';
		case 'pat': return 'Access token';
		case 'setup': return 'Owner';
		case 'no-auth': return 'No-login mode';
		default: return null;
	}
}

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
	if (!ua) {
		return { browser: 'Unknown', os: 'device', label: 'Unknown device', icon: 'lucide:monitor-smartphone', isMobile: false };
	}

	const os = detectOS(ua);
	const browser = detectBrowser(ua);
	const isMobile = /mobile|iphone|ipod|android(?!.*tablet)/i.test(ua);
	const isTablet = /ipad|tablet/i.test(ua);

	const icon: IconName = isMobile ? 'lucide:smartphone' : isTablet ? 'lucide:tablet-smartphone' : 'lucide:monitor';

	return {
		browser,
		os,
		label: `${browser} on ${os}`,
		icon,
		isMobile
	};
}

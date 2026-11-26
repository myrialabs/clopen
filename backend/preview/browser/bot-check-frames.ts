/**
 * Frames that belong to a bot check, and keeping Clopen's scripts out of them.
 *
 * The preview injects scripts into every frame on each new document: the host
 * bridge (device APIs answered by the viewer) and the audio tap. A challenge
 * widget — Cloudflare's "Verify you are human", hCaptcha, reCAPTCHA — runs in
 * its own iframe and inspects that frame's APIs. Finding them replaced, it
 * fails the check, and on a challenge page the user ticks the box only to land
 * back on the same page, forever. Nobody needs a camera or an audio tap inside
 * a captcha, so those frames are simply left alone.
 *
 * A frame counts when it, or any frame above it, is served from one of these
 * hosts: challenge widgets nest `about:blank` frames of their own, which take
 * the widget's origin as an ancestor rather than as their own.
 */

interface BotCheckFrame {
	host: string;
	/** Only frames under this path, for hosts that serve more than the check. */
	path?: string;
}

const BOT_CHECK_FRAMES: BotCheckFrame[] = [
	{ host: 'challenges.cloudflare.com' },
	{ host: 'hcaptcha.com' },
	{ host: 'www.google.com', path: '/recaptcha/' },
	{ host: 'www.recaptcha.net', path: '/recaptcha/' },
	{ host: 'arkoselabs.com' },
	{ host: 'captcha-delivery.com' }
];

/** Runs in the page, so it carries everything it needs. */
function insideBotCheck(frames: BotCheckFrame[]): boolean {
	const matches = (host: string, path: string | null) =>
		frames.some((frame) => {
			const hostMatches = host === frame.host || host.endsWith(`.${frame.host}`);
			if (!hostMatches) return false;
			// An ancestor only gives its origin; a path-scoped host counts for the frame itself only.
			return !frame.path || (path !== null && path.startsWith(frame.path));
		});

	if (matches(location.hostname, location.pathname)) return true;

	const ancestors = Array.from(location.ancestorOrigins ?? []);
	return ancestors.some((origin) => {
		try {
			return matches(new URL(origin).hostname, null);
		} catch {
			return false;
		}
	});
}

/**
 * Source for `evaluateOnNewDocument` that runs `script(...args)` in every frame
 * except those of a bot check.
 */
export function outsideBotChecks<Args extends unknown[]>(
	script: (...args: Args) => unknown,
	...args: Args
): string {
	const serializedArgs = args.map((arg) => JSON.stringify(arg) ?? 'undefined').join(', ');
	return `if (!(${insideBotCheck.toString()})(${JSON.stringify(BOT_CHECK_FRAMES)})) {
	(${script.toString()})(${serializedArgs});
}`;
}

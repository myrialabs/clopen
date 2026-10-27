/**
 * Links back into the web UI.
 *
 * Only an address another device can open is worth sending. The default looks
 * for one without side effects (configured URL or a running tunnel); a surface
 * that knows better — the chat-app runtime remembers the last real domain a
 * browser used — registers its own resolver.
 */

import { findPublicOrigin, isLocalHostname } from '$backend/tunnel/public-origin';

let resolver: () => string | null = () => {
	const found = findPublicOrigin();
	if (!found) return null;
	try {
		const url = new URL(found.origin);
		return url.protocol === 'https:' && !isLocalHostname(url.hostname) ? found.origin : null;
	} catch {
		return null;
	}
};

export function setPublicOriginResolver(next: () => string | null): void {
	resolver = next;
}

export function publicOrigin(): string | null {
	return resolver();
}

/** The `#session/<project>/<session>` deep link, or null when nothing outside can open it. */
export function sessionLink(projectId: string, sessionId: string): string | null {
	const origin = publicOrigin();
	return origin ? `${origin}/#session/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}` : null;
}

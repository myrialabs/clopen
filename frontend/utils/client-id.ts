/**
 * Per-tab client id.
 *
 * Collaborative `chat:*-sync` broadcasts go to everyone in the session room,
 * the sender included. Filtering the echo by user id breaks the moment the
 * same user has two tabs or two devices open — each one ignores the other's
 * picks. This id identifies the tab itself, so only a tab's own echo is
 * dropped.
 *
 * Kept in sessionStorage so it survives a reload of the same tab. Note that a
 * browser "Duplicate tab" copies sessionStorage, so a duplicated tab starts
 * with the same id as its source; opening the session in a new tab or on
 * another device always gets a fresh one.
 */

const STORAGE_KEY = 'clopen.clientId';

function randomId(): string {
	// `crypto.randomUUID` only exists in secure contexts — remote access over
	// plain http on a LAN IP is not one, so keep a fallback.
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function acquireClientId(): string {
	try {
		const stored = sessionStorage.getItem(STORAGE_KEY);
		if (stored) return stored;
		const id = randomId();
		sessionStorage.setItem(STORAGE_KEY, id);
		return id;
	} catch {
		// Private mode / storage disabled — a per-page-load id still works.
		return randomId();
	}
}

/** Stable id for this browser tab. */
export const CLIENT_ID: string = acquireClientId();

/**
 * Token Generation & Hashing Utilities
 *
 * Token types:
 * - clp_ses_* — Session tokens (login sessions, 30 day expiry)
 * - clp_pat_* — Personal Access Tokens (cross-device login, permanent)
 * - clp_inv_* — Invite tokens (for inviting new users)
 * - clp_dev_* — Device-pairing codes (one-time, short TTL; Remote Access "Add a device")
 */

const SESSION_PREFIX = 'clp_ses_';
const PAT_PREFIX = 'clp_pat_';
const INVITE_PREFIX = 'clp_inv_';
const DEVICE_PREFIX = 'clp_dev_';

function randomHex(bytes: number): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** All token types use the same random length for consistency */
const TOKEN_BYTES = 24; // 48 hex chars

export function generateSessionToken(): string {
	return SESSION_PREFIX + randomHex(TOKEN_BYTES);
}

export function generatePAT(): string {
	return PAT_PREFIX + randomHex(TOKEN_BYTES);
}

export function generateInviteToken(): string {
	return INVITE_PREFIX + randomHex(TOKEN_BYTES);
}

export function generateDeviceCode(): string {
	return DEVICE_PREFIX + randomHex(TOKEN_BYTES);
}

/**
 * SHA-256 hash a token string.
 * Uses Bun native CryptoHasher for performance.
 */
export function hashToken(token: string): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(token);
	return hasher.digest('hex');
}

/**
 * Determine token type from prefix
 */
export function getTokenType(token: string): 'session' | 'pat' | 'invite' | 'device' | 'unknown' {
	if (token.startsWith(SESSION_PREFIX)) return 'session';
	if (token.startsWith(PAT_PREFIX)) return 'pat';
	if (token.startsWith(INVITE_PREFIX)) return 'invite';
	if (token.startsWith(DEVICE_PREFIX)) return 'device';
	return 'unknown';
}

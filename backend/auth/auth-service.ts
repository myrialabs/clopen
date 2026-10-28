/**
 * Auth Service
 *
 * Core authentication logic. Clopen has exactly one account — the owner — who
 * signs in from any number of devices; every device is an auth session.
 */

import { authQueries } from '$backend/database/queries';
import { readSystemSettings, writeSystemSettings } from '$backend/settings/system-settings';
import { generateSessionToken, generatePAT, generateDeviceCode, hashToken, getTokenType } from './tokens';
import { generateColorFromString, getInitials } from '$backend/utils/user-helpers';
import { debug } from '$shared/utils/logger';

/** Default session lifetime in days */
const DEFAULT_SESSION_DAYS = 30;

/** How long a device-pairing code stays claimable before it expires (minutes). */
const DEVICE_CODE_TTL_MINUTES = 5;

export interface AuthUser {
	id: string;
	name: string;
	color: string;
	avatar: string;
	createdAt: string;
}

export interface AuthResult {
	user: AuthUser;
	sessionToken: string;
	expiresAt: string;
}

export interface SetupResult extends AuthResult {
	personalAccessToken: string;
}

function toAuthUser(dbUser: { id: string; name: string; color: string; avatar: string; created_at: string }): AuthUser {
	return {
		id: dbUser.id,
		name: dbUser.name,
		color: dbUser.color,
		avatar: dbUser.avatar,
		createdAt: dbUser.created_at
	};
}

/** Optional device metadata captured when a session is created (UA client-sent, IP server-side). */
export interface SessionMeta {
	userAgent?: string;
	ipAddress?: string;
}

/** How a session was created — surfaced in the "Your devices" list. */
export type SessionSource = 'setup' | 'device-link' | 'login' | 'pat' | 'no-auth';

function createSessionForUser(userId: string, source: SessionSource, meta?: SessionMeta, sessionDays?: number): { sessionToken: string; expiresAt: string; tokenHash: string } {
	const days = sessionDays ?? DEFAULT_SESSION_DAYS;
	const sessionToken = generateSessionToken();
	const tokenHash = hashToken(sessionToken);
	const now = new Date().toISOString();
	const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

	authQueries.createSession({
		id: `session-${crypto.randomUUID()}`,
		user_id: userId,
		token_hash: tokenHash,
		expires_at: expiresAt,
		created_at: now,
		last_active_at: now,
		user_agent: meta?.userAgent?.slice(0, 512) ?? null,
		ip_address: meta?.ipAddress ?? null,
		source
	});

	return { sessionToken, expiresAt, tokenHash };
}

/**
 * Check if the system needs initial setup (the owner does not exist yet)
 */
export function needsSetup(): boolean {
	return authQueries.countUsers() === 0;
}

/**
 * Onboarding (setup wizard) state.
 *
 * `pending` is only ever reported when we positively know the wizard is
 * unfinished — a fresh install, or a run that recorded the marker and has not
 * completed yet. Everything else resolves to `complete`, because sending a
 * working instance back through the wizard is destructive: it re-asks for the
 * auth mode and lets the user overwrite live settings.
 *
 * `getOnboardingState()` deliberately does NOT catch read failures. A database
 * error must surface to the caller instead of being reported as "never
 * onboarded" — that silent downgrade is what used to drop users into the wizard
 * at random.
 */
export type OnboardingState = 'pending' | 'complete';

export function getOnboardingState(): OnboardingState {
	const stored = readSystemSettings();

	// `onboarding` is the current marker; `onboardingComplete` is the legacy
	// boolean, still read (and written) so a downgrade keeps working.
	if (stored.onboarding === 'complete' || stored.onboardingComplete === true) return 'complete';
	if (stored.onboarding === 'pending') return 'pending';

	// No marker at all. An install that already has an owner has, by
	// definition, been through setup — the wizard is what created it. Record that so a
	// single missing key can never flap the whole instance back to setup.
	if (!needsSetup()) {
		markOnboardingComplete();
		debug.log('auth', 'Onboarding marker missing but the owner exists — recorded as complete');
		return 'complete';
	}

	return 'pending';
}

/** True when the setup wizard has been completed. */
export function isOnboardingComplete(): boolean {
	return getOnboardingState() === 'complete';
}

/**
 * Record that a fresh install has entered the wizard, so a refresh mid-setup
 * resumes it instead of being mistaken for a completed install.
 */
export function markOnboardingPending(): void {
	writeSystemSettings({ onboarding: 'pending', onboardingComplete: false });
}

/** Record that the wizard finished. Writes both the current and legacy markers. */
export function markOnboardingComplete(): void {
	writeSystemSettings({ onboarding: 'complete', onboardingComplete: true });
}

/**
 * Sign in for no-auth mode: reuse the owner, creating a default one on a fresh
 * install. Does not generate a PAT (not needed for no-auth).
 */
export function createOrGetNoAuthOwner(): AuthResult {
	const existing = authQueries.getOwner();
	if (existing) {
		const { sessionToken, expiresAt } = createSessionForUser(existing.id, 'no-auth');
		debug.log('auth', `No-auth mode: reusing owner: ${existing.name} (${existing.id})`);
		return {
			user: toAuthUser(existing),
			sessionToken,
			expiresAt
		};
	}

	const userId = `user-${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	const defaultName = 'Owner';

	const dbUser = authQueries.createUser({
		id: userId,
		name: defaultName,
		color: generateColorFromString(defaultName),
		avatar: getInitials(defaultName),
		personal_access_token_hash: '', // No PAT for no-auth mode
		created_at: now
	});

	const { sessionToken, expiresAt } = createSessionForUser(userId, 'no-auth');

	debug.log('auth', `No-auth mode: created default owner: ${defaultName} (${userId})`);

	return {
		user: toAuthUser(dbUser),
		sessionToken,
		expiresAt
	};
}

/**
 * Create the owner account (setup flow). Only works before setup.
 */
export function createOwner(name: string, meta?: SessionMeta): SetupResult {
	if (!needsSetup()) {
		throw new Error('Setup already completed. The owner account exists.');
	}

	const trimmedName = name.trim();
	if (trimmedName.length === 0) {
		throw new Error('Name cannot be empty');
	}

	const userId = `user-${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	const pat = generatePAT();
	const patHash = hashToken(pat);

	const dbUser = authQueries.createUser({
		id: userId,
		name: trimmedName,
		color: generateColorFromString(trimmedName),
		avatar: getInitials(trimmedName),
		personal_access_token_hash: patHash,
		created_at: now
	});

	const { sessionToken, expiresAt } = createSessionForUser(userId, 'setup', meta);

	debug.log('auth', `Owner account created: ${trimmedName} (${userId})`);

	return {
		user: toAuthUser(dbUser),
		sessionToken,
		expiresAt,
		personalAccessToken: pat
	};
}

/**
 * Login with a token (PAT or session token)
 */
export function loginWithToken(token: string, meta?: SessionMeta): AuthResult & { tokenHash: string } {
	const tokenType = getTokenType(token);
	const tokenHash = hashToken(token);

	if (tokenType === 'pat') {
		// PAT login — find user by PAT hash, create new session
		const user = authQueries.getUserByPatHash(tokenHash);
		if (!user) {
			throw new Error('Invalid access token');
		}

		const session = createSessionForUser(user.id, 'pat', meta);
		debug.log('auth', `PAT login: ${user.name} (${user.id})`);

		return {
			user: toAuthUser(user),
			sessionToken: session.sessionToken,
			expiresAt: session.expiresAt,
			tokenHash: session.tokenHash
		};
	}

	if (tokenType === 'session') {
		// Session token login — validate existing session
		const session = authQueries.getSessionByTokenHash(tokenHash);
		if (!session) {
			throw new Error('Invalid session token');
		}

		// Check expiry
		if (new Date(session.expires_at) < new Date()) {
			authQueries.deleteSession(session.id);
			throw new Error('Session expired');
		}

		// Update last active
		authQueries.updateLastActive(session.id);

		const user = authQueries.getUserById(session.user_id);
		if (!user) {
			authQueries.deleteSession(session.id);
			throw new Error('User not found');
		}

		debug.log('auth', `Session login: ${user.name} (${user.id})`);

		return {
			user: toAuthUser(user),
			sessionToken: token,
			expiresAt: session.expires_at,
			tokenHash
		};
	}

	throw new Error('Invalid token format');
}

/**
 * Logout — delete session by token hash
 */
export function logout(tokenHash: string): void {
	authQueries.deleteSessionByTokenHash(tokenHash);
	debug.log('auth', 'Session deleted');
}

/**
 * Get user by ID
 */
export function getUserById(id: string): AuthUser | null {
	const user = authQueries.getUserById(id);
	return user ? toAuthUser(user) : null;
}

/**
 * The owner account, or null before setup.
 */
export function getOwner(): AuthUser | null {
	const user = authQueries.getOwner();
	return user ? toAuthUser(user) : null;
}

/**
 * Regenerate Personal Access Token for a user
 */
export function regeneratePAT(userId: string): string {
	const user = authQueries.getUserById(userId);
	if (!user) {
		throw new Error('User not found');
	}

	const pat = generatePAT();
	const patHash = hashToken(pat);

	authQueries.updateUser(userId, { personal_access_token_hash: patHash });

	debug.log('auth', `PAT regenerated for user: ${userId}`);

	return pat;
}

/**
 * Create a one-time device-pairing code for the given user. The code is a
 * random `clp_dev_*` token; only its hash is stored. Embed the raw code in a
 * Remote Access share link so another device can claim it and sign in as this
 * user without transferring a persistent credential.
 */
export function createDeviceCode(userId: string, label?: string): { deviceCode: string; expiresAt: string } {
	const user = authQueries.getUserById(userId);
	if (!user) {
		throw new Error('User not found');
	}

	const rawCode = generateDeviceCode();
	const codeHash = hashToken(rawCode);
	const now = new Date().toISOString();
	const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MINUTES * 60 * 1000).toISOString();

	authQueries.createDeviceCode({
		id: `device-${crypto.randomUUID()}`,
		code_hash: codeHash,
		user_id: userId,
		label: label?.trim() || null,
		expires_at: expiresAt,
		claimed_at: null,
		created_at: now
	});

	debug.log('auth', `Device code created for user: ${user.name} (${userId})`);

	return { deviceCode: rawCode, expiresAt };
}

/**
 * Claim a device-pairing code — single-use. Validates the code is unexpired and
 * unclaimed, burns it, and issues a fresh auth session for the owning user.
 */
export function claimDeviceCode(rawCode: string, meta?: SessionMeta): AuthResult & { tokenHash: string } {
	if (getTokenType(rawCode) !== 'device') {
		throw new Error('Invalid device code');
	}

	const codeHash = hashToken(rawCode);
	const record = authQueries.getDeviceCodeByHash(codeHash);

	if (!record) {
		throw new Error('Invalid device code');
	}

	if (record.claimed_at) {
		throw new Error('This device code has already been used');
	}

	if (new Date(record.expires_at) < new Date()) {
		authQueries.deleteDeviceCode(record.id);
		throw new Error('This device code has expired');
	}

	// Burn the code atomically — if another claim won the race, changes === 0.
	const claimed = authQueries.markDeviceCodeClaimed(record.id, new Date().toISOString());
	if (claimed === 0) {
		throw new Error('This device code has already been used');
	}

	const user = authQueries.getUserById(record.user_id);
	if (!user) {
		authQueries.deleteDeviceCode(record.id);
		throw new Error('Invalid device code');
	}

	const session = createSessionForUser(user.id, 'device-link', meta);
	debug.log('auth', `Device code claimed: ${user.name} (${user.id})`);

	return {
		user: toAuthUser(user),
		sessionToken: session.sessionToken,
		expiresAt: session.expiresAt,
		tokenHash: session.tokenHash
	};
}

/**
 * Revoke an unclaimed device code (owner-scoped). Used when a new link replaces
 * an old one so the previous QR/code stops working immediately.
 */
export function revokeDeviceCode(userId: string, rawCode: string): boolean {
	const hash = hashToken(rawCode);
	const record = authQueries.getDeviceCodeByHash(hash);
	if (!record || record.user_id !== userId) {
		return false;
	}
	authQueries.deleteDeviceCode(record.id);
	debug.log('auth', `Device code revoked (user ${userId})`);
	return true;
}

/**
 * Update user display name
 */
export function updateUserName(userId: string, newName: string): AuthUser {
	const trimmedName = newName.trim();
	if (trimmedName.length === 0) {
		throw new Error('Name cannot be empty');
	}

	authQueries.updateUser(userId, {
		name: trimmedName,
		color: generateColorFromString(trimmedName),
		avatar: getInitials(trimmedName)
	});

	const updated = authQueries.getUserById(userId);
	if (!updated) {
		throw new Error('User not found after update');
	}

	return toAuthUser(updated);
}

/**
 * Sign out every device
 */
export function logoutAllSessions(): number {
	const count = authQueries.deleteAllSessions();
	debug.log('auth', `All sessions deleted: ${count}`);
	return count;
}

/**
 * A signed-in device. `current` marks the session matching the given token
 * hash so the caller can flag "this device".
 */
export interface AuthSessionInfo {
	id: string;
	createdAt: string;
	lastActiveAt: string;
	expiresAt: string;
	current: boolean;
	/** True when a live WS connection is currently bound to this session. */
	online: boolean;
	userAgent: string | null;
	ipAddress: string | null;
	source: string | null;
}

export function listSessions(currentTokenHash?: string, onlineHashes?: Set<string>): AuthSessionInfo[] {
	return authQueries.getAllSessions().map((s) => ({
		id: s.id,
		createdAt: s.created_at,
		lastActiveAt: s.last_active_at,
		expiresAt: s.expires_at,
		current: currentTokenHash !== undefined && s.token_hash === currentTokenHash,
		online: onlineHashes?.has(s.token_hash) ?? false,
		userAgent: s.user_agent,
		ipAddress: s.ip_address,
		source: s.source
	}));
}

/**
 * Sign out one device. Returns the deleted session's token hash so the caller
 * can kick any live WS connection bound to it.
 */
export function revokeSession(sessionId: string): { success: boolean; tokenHash?: string } {
	const session = authQueries.getSessionById(sessionId);
	if (!session) {
		return { success: false };
	}
	authQueries.deleteSession(sessionId);
	debug.log('auth', `Session revoked: ${sessionId}`);
	return { success: true, tokenHash: session.token_hash };
}

/**
 * Remote Access sidebar indicator: the number of *other* devices currently
 * online. "Active" means a live WS connection is bound to the session right now
 * — not merely a session row in the DB — so this mirrors Public Tunnel's live
 * connection count and the "Your devices" list. The viewer's current device is
 * excluded so the badge reads "N remote devices connected".
 */
export function getRemoteAccessSummary(
	onlineHashes: Set<string>,
	currentTokenHash?: string
): { activeConnections: number } {
	let activeConnections = 0;
	for (const s of authQueries.getAllSessions()) {
		if (!onlineHashes.has(s.token_hash)) continue;
		if (currentTokenHash && s.token_hash === currentTokenHash) continue;
		activeConnections++;
	}
	return { activeConnections };
}

/**
 * Cleanup expired sessions
 */
export function cleanupExpiredSessions(): number {
	const count = authQueries.deleteExpiredSessions();
	if (count > 0) {
		debug.log('auth', `Cleaned up ${count} expired sessions`);
	}
	// Also sweep expired / already-claimed device codes.
	const staleCodes = authQueries.deleteStaleDeviceCodes();
	if (staleCodes > 0) {
		debug.log('auth', `Cleaned up ${staleCodes} stale device code(s)`);
	}
	return count;
}

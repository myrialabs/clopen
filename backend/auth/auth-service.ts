/**
 * Auth Service
 *
 * Core authentication logic: user creation, session management, invite handling.
 */

import { authQueries, projectQueries, settingsQueries } from '$backend/database/queries';
import type { Project } from '$shared/types/database/schema';
import { generateSessionToken, generatePAT, generateInviteToken, hashToken, getTokenType } from './tokens';
import { generateColorFromString, getInitials } from '$backend/utils/user-helpers';
import { debug } from '$shared/utils/logger';

/** Default session lifetime in days */
const DEFAULT_SESSION_DAYS = 30;

export interface AuthUser {
	id: string;
	name: string;
	color: string;
	avatar: string;
	role: 'admin' | 'member';
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

function toAuthUser(dbUser: { id: string; name: string; color: string; avatar: string; role: 'admin' | 'member'; created_at: string }): AuthUser {
	return {
		id: dbUser.id,
		name: dbUser.name,
		color: dbUser.color,
		avatar: dbUser.avatar,
		role: dbUser.role,
		createdAt: dbUser.created_at
	};
}

function createSessionForUser(userId: string, sessionDays?: number): { sessionToken: string; expiresAt: string; tokenHash: string } {
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
		last_active_at: now
	});

	return { sessionToken, expiresAt, tokenHash };
}

/**
 * Check if the system needs initial setup (no users exist)
 */
export function needsSetup(): boolean {
	return authQueries.countUsers() === 0;
}

/**
 * Get parsed system settings from DB (cached per call).
 */
function getSystemSettingsParsed(): Record<string, unknown> {
	try {
		const setting = settingsQueries.get('system:settings');
		if (setting?.value) {
			return typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
		}
	} catch {
		// Settings may not exist yet
	}
	return {};
}

/**
 * Get the current auth mode from system settings.
 * Returns 'required' by default (before setup is complete).
 */
export function getAuthMode(): 'none' | 'required' {
	const parsed = getSystemSettingsParsed();
	if (parsed.authMode === 'none' || parsed.authMode === 'required') {
		return parsed.authMode as 'none' | 'required';
	}
	return 'required';
}

/**
 * Check if the initial onboarding wizard has been completed.
 */
export function isOnboardingComplete(): boolean {
	const parsed = getSystemSettingsParsed();
	return parsed.onboardingComplete === true;
}

/**
 * Create a default admin user for no-auth mode.
 * Does not generate a PAT (not needed for no-auth).
 * If users already exist, returns the first admin.
 */
export function createOrGetNoAuthAdmin(): AuthResult {
	// If users already exist, return the first admin
	const existingUsers = authQueries.getAllUsers();
	const existingAdmin = existingUsers.find(u => u.role === 'admin');
	if (existingAdmin) {
		const { sessionToken, expiresAt } = createSessionForUser(existingAdmin.id);
		debug.log('auth', `No-auth mode: reusing existing admin: ${existingAdmin.name} (${existingAdmin.id})`);
		return {
			user: toAuthUser(existingAdmin),
			sessionToken,
			expiresAt
		};
	}

	// Create default admin
	const userId = `user-${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	const defaultName = 'Admin';

	const dbUser = authQueries.createUser({
		id: userId,
		name: defaultName,
		color: generateColorFromString(defaultName),
		avatar: getInitials(defaultName),
		role: 'admin',
		personal_access_token_hash: '', // No PAT for no-auth mode
		created_at: now
	});

	const { sessionToken, expiresAt } = createSessionForUser(userId);

	debug.log('auth', `No-auth mode: created default admin: ${defaultName} (${userId})`);

	return {
		user: toAuthUser(dbUser),
		sessionToken,
		expiresAt
	};
}

/**
 * Create the first admin user (setup flow)
 * Only works when no users exist.
 */
export function createAdmin(name: string): SetupResult {
	if (!needsSetup()) {
		throw new Error('Setup already completed. Admin account exists.');
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
		role: 'admin',
		personal_access_token_hash: patHash,
		created_at: now
	});

	const { sessionToken, expiresAt } = createSessionForUser(userId);

	debug.log('auth', `Admin account created: ${trimmedName} (${userId})`);

	return {
		user: toAuthUser(dbUser),
		sessionToken,
		expiresAt,
		personalAccessToken: pat
	};
}

/**
 * Create a user from an invite token
 */
export function createUserFromInvite(rawInviteToken: string, name: string): SetupResult {
	const trimmedName = name.trim();
	if (trimmedName.length === 0) {
		throw new Error('Name cannot be empty');
	}

	const inviteHash = hashToken(rawInviteToken);
	const invite = authQueries.getInviteByTokenHash(inviteHash);

	if (!invite) {
		throw new Error('Invalid invite token');
	}

	// Check expiry
	if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
		throw new Error('Invite token has expired');
	}

	// Check max uses
	if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) {
		throw new Error('Invite token has reached maximum uses');
	}

	// Only allow creating member role from invite (single admin policy)
	const role: 'admin' | 'member' = 'member';

	const userId = `user-${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	const pat = generatePAT();
	const patHash = hashToken(pat);

	const dbUser = authQueries.createUser({
		id: userId,
		name: trimmedName,
		color: generateColorFromString(trimmedName),
		avatar: getInitials(trimmedName),
		role,
		personal_access_token_hash: patHash,
		created_at: now
	});

	// Increment invite use count
	authQueries.incrementUseCount(invite.id);

	const { sessionToken, expiresAt } = createSessionForUser(userId);

	debug.log('auth', `User created from invite: ${trimmedName} (${userId}), role: ${role}`);

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
export function loginWithToken(token: string): AuthResult & { tokenHash: string } {
	const tokenType = getTokenType(token);
	const tokenHash = hashToken(token);

	if (tokenType === 'pat') {
		// PAT login — find user by PAT hash, create new session
		const user = authQueries.getUserByPatHash(tokenHash);
		if (!user) {
			throw new Error('Invalid access token');
		}

		const session = createSessionForUser(user.id);
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
 * List all users
 */
export function listUsers(): AuthUser[] {
	return authQueries.getAllUsers().map(toAuthUser);
}

/**
 * Remove a user (prevents removing the last admin)
 */
export function removeUser(userId: string): void {
	const user = authQueries.getUserById(userId);
	if (!user) {
		throw new Error('User not found');
	}

	if (user.role === 'admin' && authQueries.countAdmins() <= 1) {
		throw new Error('Cannot remove the last admin');
	}

	// Delete all sessions for this user
	authQueries.deleteSessionsByUserId(userId);
	// Delete the user (cascade will handle invite_tokens.created_by)
	authQueries.deleteUser(userId);

	debug.log('auth', `User removed: ${user.name} (${userId})`);
}

/**
 * Create an invite token
 */
export function createInvite(
	createdBy: string,
	options: { label?: string; maxUses?: number; expiresInMinutes?: number }
): { inviteToken: string; invite: ReturnType<typeof authQueries.getInviteByTokenHash> } {
	const rawToken = generateInviteToken();
	const tokenHash = hashToken(rawToken);
	const now = new Date().toISOString();

	const expiresAt = options.expiresInMinutes
		? new Date(Date.now() + options.expiresInMinutes * 60 * 1000).toISOString()
		: null;

	const invite = authQueries.createInvite({
		id: `invite-${crypto.randomUUID()}`,
		token_hash: tokenHash,
		role: 'member',
		label: options.label ?? null,
		created_by: createdBy,
		max_uses: options.maxUses ?? 1,
		use_count: 0,
		expires_at: expiresAt,
		created_at: now
	});

	debug.log('auth', `Invite created by ${createdBy}: ${invite.id}`);

	return { inviteToken: rawToken, invite };
}

/**
 * Validate an invite token (without using it)
 */
export function validateInviteToken(rawToken: string): { valid: boolean; role?: string; error?: string } {
	const tokenHash = hashToken(rawToken);
	const invite = authQueries.getInviteByTokenHash(tokenHash);

	if (!invite) {
		return { valid: false, error: 'Invalid invite token' };
	}

	if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
		return { valid: false, error: 'Invite has expired' };
	}

	if (invite.max_uses > 0 && invite.use_count >= invite.max_uses) {
		return { valid: false, error: 'Invite has reached maximum uses' };
	}

	return { valid: true, role: invite.role };
}

/**
 * List all invites
 */
export function listInvites() {
	return authQueries.getAllInvites();
}

/**
 * Revoke an invite
 */
export function revokeInvite(id: string): void {
	authQueries.revokeInvite(id);
	debug.log('auth', `Invite revoked: ${id}`);
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
 * Logout all sessions (all users)
 */
export function logoutAllSessions(): number {
	const count = authQueries.deleteAllSessions();
	debug.log('auth', `All sessions deleted: ${count}`);
	return count;
}

/**
 * List projects assigned to a specific user (admin view)
 */
export function listUserProjects(userId: string): Project[] {
	const user = authQueries.getUserById(userId);
	if (!user) {
		throw new Error('User not found');
	}
	return projectQueries.getAllForUser(userId);
}

/**
 * Assign a project to a user. Admins are implicitly assigned to all projects
 * they create, but this is used to grant a member access to a project.
 * Returns true if a new assignment was added, false if user already had access.
 */
export function assignProjectToUser(userId: string, projectId: string): boolean {
	const user = authQueries.getUserById(userId);
	if (!user) {
		throw new Error('User not found');
	}
	const project = projectQueries.getById(projectId);
	if (!project) {
		throw new Error('Project not found');
	}
	if (projectQueries.userHasProject(userId, projectId)) {
		return false;
	}
	projectQueries.addUserProject(userId, projectId);
	debug.log('auth', `Project ${projectId} assigned to user ${userId}`);
	return true;
}

/**
 * Revoke a user's access to a project. Refuses to remove the last admin
 * association to avoid orphaning the project.
 */
export function unassignProjectFromUser(userId: string, projectId: string): boolean {
	const user = authQueries.getUserById(userId);
	if (!user) {
		throw new Error('User not found');
	}
	const project = projectQueries.getById(projectId);
	if (!project) {
		throw new Error('Project not found');
	}
	if (!projectQueries.userHasProject(userId, projectId)) {
		return false;
	}
	projectQueries.removeUserProject(userId, projectId);
	debug.log('auth', `Project ${projectId} unassigned from user ${userId}`);
	return true;
}

/**
 * Cleanup expired sessions
 */
export function cleanupExpiredSessions(): number {
	const count = authQueries.deleteExpiredSessions();
	if (count > 0) {
		debug.log('auth', `Cleaned up ${count} expired sessions`);
	}
	return count;
}

/**
 * User CRUD Operations
 *
 * HTTP endpoints for user management:
 * - Generate anonymous user
 * - Update user name
 * - Restore user state (server-side state management)
 * - Save user state
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { generateAnonymousUser, generateColorFromString, getInitials } from '../../lib/user/helpers';
import type { AnonymousUser } from '../../lib/user/helpers';
import { ws } from '$backend/lib/utils/ws';
import { settingsQueries } from '$backend/lib/database/queries';
import { debug } from '$shared/utils/logger';

/**
 * User state keys stored in the settings table.
 * Format: `user:{userId}:{key}`
 */
function userKey(userId: string, key: string): string {
	return `user:${userId}:${key}`;
}

/**
 * Read a user state value from the settings table.
 * Returns parsed JSON or null if not found.
 */
function getUserState(userId: string, key: string): any {
	const setting = settingsQueries.get(userKey(userId, key));
	if (!setting) return null;
	try {
		return JSON.parse(setting.value);
	} catch {
		return setting.value;
	}
}

/**
 * Write a user state value to the settings table.
 * Values are JSON-stringified before storage.
 */
function setUserState(userId: string, key: string, value: any): void {
	const serialized = typeof value === 'string' ? value : JSON.stringify(value);
	settingsQueries.set(userKey(userId, key), serialized);
}

export const crudHandler = createRouter()
	// Generate anonymous user
	.http('user:anonymous', {
		data: t.Object({}),
		response: t.Object({
			id: t.String(),
			name: t.String(),
			color: t.String(),
			avatar: t.String(),
			createdAt: t.String()
		})
	}, async () => {
		const newUser = generateAnonymousUser();

		debug.log('user', '✅ Generated new anonymous user:', newUser.name);

		return newUser;
	})

	// Update user name
	.http('user:update', {
		data: t.Object({
			newName: t.String({ minLength: 1 })
		}),
		response: t.Object({
			id: t.String(),
			name: t.String(),
			color: t.String(),
			avatar: t.String(),
			createdAt: t.String()
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		const { newName } = data;

		const trimmedName = newName.trim();

		if (trimmedName.length === 0) {
			throw new Error('Name cannot be empty');
		}

		// Create updated user object
		const updatedUser: AnonymousUser = {
			id: userId,
			name: trimmedName,
			avatar: getInitials(trimmedName),
			color: generateColorFromString(trimmedName),
			createdAt: new Date().toISOString()
		};

		debug.log('user', '✅ Updated user name:', { userId, newName: trimmedName });

		return updatedUser;
	})

	// Restore user state - returns all server-side user state at once
	.http('user:restore-state', {
		data: t.Object({}),
		response: t.Object({
			currentProjectId: t.Union([t.String(), t.Null()]),
			lastView: t.Union([t.String(), t.Null()]),
			settings: t.Union([t.Any(), t.Null()])
		})
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);

		const currentProjectId = getUserState(userId, 'currentProjectId') as string | null;
		const lastView = getUserState(userId, 'lastView') as string | null;
		const userSettings = getUserState(userId, 'settings');

		debug.log('user', `Restored state for ${userId}:`, {
			currentProjectId,
			lastView,
			hasSettings: !!userSettings
		});

		return {
			currentProjectId: currentProjectId ?? null,
			lastView: lastView ?? null,
			settings: userSettings ?? null
		};
	})

	// Save user state - saves a single key-value pair
	.http('user:save-state', {
		data: t.Object({
			key: t.String({ minLength: 1 }),
			value: t.Any()
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const userId = ws.getUserId(conn);

		// Validate allowed keys to prevent arbitrary data storage
		const allowedKeys = ['currentProjectId', 'lastView', 'settings'];
		if (!allowedKeys.includes(data.key)) {
			throw new Error(`Invalid state key: ${data.key}. Allowed: ${allowedKeys.join(', ')}`);
		}

		setUserState(userId, data.key, data.value);

		debug.log('user', `Saved state for ${userId}: ${data.key}`);

		return { success: true };
	});

/**
 * User CRUD Operations
 *
 * HTTP endpoints for the owner's saved UI state:
 * - Restore user state (server-side state management)
 * - Save user state
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { settingsQueries } from '$backend/database/queries';
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
	// Restore user state - returns all server-side user state at once
	.http('user:restore-state', {
		data: t.Object({}),
		response: t.Object({
			currentProjectId: t.Union([t.String(), t.Null()]),
			lastView: t.Union([t.String(), t.Null()]),
			settings: t.Union([t.Any(), t.Null()]),
			unreadSessions: t.Union([t.Any(), t.Null()]),
			todoPanelState: t.Union([t.Any(), t.Null()]),
			projectOrder: t.Union([t.Array(t.String()), t.Null()]),
			pinnedProjectIds: t.Union([t.Array(t.String()), t.Null()]),
			archivedProjectIds: t.Union([t.Array(t.String()), t.Null()]),
			commandUsage: t.Union([t.Any(), t.Null()]),
			fileShareDefaults: t.Union([t.Any(), t.Null()])
		})
	}, async ({ conn }) => {
		const userId = ws.getUserId(conn);

		const currentProjectId = getUserState(userId, 'currentProjectId') as string | null;
		const lastView = getUserState(userId, 'lastView') as string | null;
		const userSettings = getUserState(userId, 'settings');
		const unreadSessions = getUserState(userId, 'unreadSessions');
		const todoPanelState = getUserState(userId, 'todoPanelState');
		const projectOrder = getUserState(userId, 'projectOrder');
		const pinnedProjectIds = getUserState(userId, 'pinnedProjectIds');
		const archivedProjectIds = getUserState(userId, 'archivedProjectIds');
		const commandUsage = getUserState(userId, 'commandUsage');
		const fileShareDefaults = getUserState(userId, 'fileShareDefaults');

		debug.log('user', `Restored state for ${userId}:`, {
			currentProjectId,
			lastView,
			hasSettings: !!userSettings,
			unreadSessionsCount: unreadSessions ? Object.keys(unreadSessions).length : 0,
			projectOrderCount: Array.isArray(projectOrder) ? projectOrder.length : 0
		});

		return {
			currentProjectId: currentProjectId ?? null,
			lastView: lastView ?? null,
			settings: userSettings ?? null,
			unreadSessions: unreadSessions ?? null,
			todoPanelState: todoPanelState ?? null,
			projectOrder: Array.isArray(projectOrder) ? projectOrder : null,
			pinnedProjectIds: Array.isArray(pinnedProjectIds) ? pinnedProjectIds : null,
			archivedProjectIds: Array.isArray(archivedProjectIds) ? archivedProjectIds : null,
			commandUsage: commandUsage ?? null,
			fileShareDefaults: fileShareDefaults ?? null
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
		const allowedKeys = ['currentProjectId', 'lastView', 'settings', 'unreadSessions', 'todoPanelState', 'projectOrder', 'pinnedProjectIds', 'archivedProjectIds', 'commandUsage', 'fileShareDefaults'];
		if (!allowedKeys.includes(data.key)) {
			throw new Error(`Invalid state key: ${data.key}. Allowed: ${allowedKeys.join(', ')}`);
		}

		setUserState(userId, data.key, data.value);

		debug.log('user', `Saved state for ${userId}: ${data.key}`);

		return { success: true };
	});

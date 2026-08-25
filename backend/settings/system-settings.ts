/**
 * System Settings — single source of truth for the `system:settings` row.
 *
 * Every reader and writer of that blob goes through here. Two rules keep the
 * "wizard came back / settings reset themselves" class of bug from returning:
 *
 * 1. A failed read is never flattened into "the setting is unset".
 *    `readSystemSettings()` throws when the database is unavailable or the blob
 *    is unparseable, so each caller has to pick its fallback deliberately. The
 *    old copy-pasted readers swallowed every error and returned `{}`, which told
 *    a perfectly healthy install that it had never been onboarded.
 * 2. Writes always merge into the stored blob, never replace it, so a caller
 *    holding a stale copy of the settings cannot drop sibling fields.
 */

import { settingsQueries } from '$backend/database/queries';
import type { AuthMode, SystemSettings } from '$shared/types/stores/settings';
import { debug } from '$shared/utils/logger';

/** The settings-table key the whole system-settings blob lives under. */
export const SYSTEM_SETTINGS_KEY = 'system:settings';

/**
 * Stored shape: the typed fields, plus anything a newer or older build wrote.
 * Unknown keys are preserved by every write so a downgrade never loses data.
 */
export type StoredSystemSettings = Partial<SystemSettings> & Record<string, unknown>;

/**
 * Read and parse the system settings blob.
 *
 * Returns `{}` only when the row genuinely does not exist yet (fresh install).
 * THROWS when the database is unreachable or the stored value is not valid
 * JSON — those are failures, not "no settings", and callers must not treat them
 * the same way.
 */
export function readSystemSettings(): StoredSystemSettings {
	const row = settingsQueries.get(SYSTEM_SETTINGS_KEY);
	if (!row?.value) return {};

	const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${SYSTEM_SETTINGS_KEY} holds a non-object value`);
	}
	return parsed as StoredSystemSettings;
}

/**
 * Read a single field with an explicit fallback, tolerating an unreadable blob.
 *
 * Use this for settings where continuing with the default is genuinely correct
 * (a size limit, a public URL). Do NOT use it for state that decides whether the
 * user has already completed something — see `auth-service`'s onboarding state.
 */
export function readSystemSetting<T>(pick: (settings: StoredSystemSettings) => T | undefined, fallback: T): T {
	try {
		const value = pick(readSystemSettings());
		return value === undefined ? fallback : value;
	} catch (error) {
		debug.warn('settings', 'System settings unreadable, using default for one field:', error);
		return fallback;
	}
}

/**
 * Merge a patch into the stored blob — the only writer of this row.
 *
 * Returns the merged result so callers can confirm what was persisted.
 */
export function writeSystemSettings(patch: StoredSystemSettings): StoredSystemSettings {
	let current: StoredSystemSettings = {};
	try {
		current = readSystemSettings();
	} catch (error) {
		// The blob is unreadable, so rebuilding from the patch is the only way
		// forward — but it is also the moment sibling settings are lost, so it is
		// logged as an error rather than quietly absorbed.
		debug.error('settings', 'System settings unreadable, rebuilding from patch:', error);
	}

	const merged = { ...current, ...patch };
	settingsQueries.set(SYSTEM_SETTINGS_KEY, JSON.stringify(merged));
	return merged;
}

/**
 * Current auth mode.
 *
 * Fail-secure: an unreadable blob resolves to 'required' (login enforced), and
 * this runs inside the WebSocket auth gate, so it must never throw.
 */
export function getAuthMode(): AuthMode {
	return readSystemSetting(
		(s) => (s.authMode === 'none' || s.authMode === 'required' ? s.authMode : undefined),
		'required'
	);
}

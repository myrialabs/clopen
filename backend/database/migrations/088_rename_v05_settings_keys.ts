import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';

export const description = 'Rename stored settings keys to the v0.5 vocabulary (Artifacts → Library)';

/**
 * v0.5 renamed the terms Clopen invented — Artifacts became Library — down to
 * the keys settings are stored under. A key that is renamed in code but not in
 * the stored blob is a preference the user silently loses, so every blob that
 * carries an old key is rewritten here.
 *
 * Each rename moves the value only when the new key is absent, so running this
 * against a blob a newer build already wrote never overwrites it.
 */
const USER_SETTINGS_RENAMES: Array<[from: string, to: string]> = [['artifactGenerator', 'libraryGenerator']];

function rewrite(db: DatabaseConnection, renames: Array<[string, string]>, direction: 'up' | 'down'): number {
	const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'user:%:settings'`).all() as Array<{ key: string; value: string }>;
	let changed = 0;
	for (const row of rows) {
		let blob: Record<string, unknown>;
		try {
			blob = JSON.parse(row.value);
		} catch {
			continue;
		}
		if (!blob || typeof blob !== 'object' || Array.isArray(blob)) continue;
		let touched = false;
		for (const [oldKey, newKey] of renames) {
			const [from, to] = direction === 'up' ? [oldKey, newKey] : [newKey, oldKey];
			if (from in blob) {
				if (!(to in blob)) blob[to] = blob[from];
				delete blob[from];
				touched = true;
			}
		}
		if (touched) {
			db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(blob), row.key);
			changed++;
		}
	}
	return changed;
}

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Renaming stored settings keys to the v0.5 vocabulary...');
	const changed = rewrite(db, USER_SETTINGS_RENAMES, 'up');
	debug.log('migration', `✅ ${changed} settings blob(s) updated`);
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Restoring pre-v0.5 settings keys...');
	const changed = rewrite(db, USER_SETTINGS_RENAMES, 'down');
	debug.log('migration', `✅ ${changed} settings blob(s) restored`);
};

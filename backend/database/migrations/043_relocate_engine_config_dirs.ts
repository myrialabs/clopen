import fs from 'node:fs';
import { join } from 'node:path';
import type { DatabaseConnection } from '$shared/types/database/connection';
import { getClopenDir } from '../../utils/paths';
import { debug } from '$shared/utils/logger';

export const description = 'Relocate per-engine config dirs from {clopenDir}/{engine}/user to {clopenDir}/engine/{engine}/user';

/**
 * Earlier builds isolated each engine at `{clopenDir}/{engine}/user/`; the
 * layout has since moved under an `engine/` parent: `{clopenDir}/engine/{engine}/user/`
 * (see `getEngineUserConfigDir`). This migration relocates any directory the
 * previous build already created so existing sessions/credentials carry over.
 *
 * Safe by construction: it only ever touches `{clopenDir}/{engine}/user/`,
 * which is a path **Clopen itself created** — never the engine's global home
 * (`~/.codex`, `~/.copilot`, …). A user's standalone CLI usage is untouched.
 *
 * Filesystem-only + idempotent: if the new dir already exists (current build
 * ran first) the old one is left in place rather than clobbering live data.
 */

const ENGINES = ['claude', 'codex', 'copilot', 'qwen', 'opencode'] as const;

export const up = (db: DatabaseConnection): void => {
	const clopenDir = getClopenDir();
	const engineParent = join(clopenDir, 'engine');

	for (const engine of ENGINES) {
		const oldUserDir = join(clopenDir, engine, 'user'); // {clopenDir}/{engine}/user
		const newUserDir = join(engineParent, engine, 'user'); // {clopenDir}/engine/{engine}/user

		try {
			if (!fs.existsSync(oldUserDir)) continue;

			if (fs.existsSync(newUserDir)) {
				debug.warn('migration', `engine-dir: ${newUserDir} already exists — leaving ${oldUserDir} in place (no clobber)`);
				continue;
			}

			fs.mkdirSync(join(engineParent, engine), { recursive: true });
			fs.renameSync(oldUserDir, newUserDir);
			debug.log('migration', `engine-dir: moved ${oldUserDir} → ${newUserDir}`);

			// Remove the now-empty {clopenDir}/{engine} parent left behind.
			try {
				const oldParent = join(clopenDir, engine);
				if (fs.readdirSync(oldParent).length === 0) fs.rmdirSync(oldParent);
			} catch {
				// Parent not empty or already gone — leave it.
			}
		} catch (err) {
			// Non-fatal: the engine just starts fresh at the new dir on next use.
			debug.warn('migration', `engine-dir: failed to move ${oldUserDir} → ${newUserDir}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Drop any persisted OpenCode server pointer: a cached URL/datadir from the
	// pre-move location would otherwise be reuse-checked against the new dir.
	// Clearing it forces a clean re-spawn into the relocated data dir.
	try {
		db.exec(`DELETE FROM settings WHERE key IN ('opencode.server.url', 'opencode.server.datadir')`);
	} catch (err) {
		debug.warn('migration', `engine-dir: failed to clear opencode server settings: ${err instanceof Error ? err.message : String(err)}`);
	}
};

export const down = (): void => {
	// No-op. Directory relocation is forward-only and data-preserving; reversing
	// it would re-fragment state across the old/new layouts for no benefit.
};

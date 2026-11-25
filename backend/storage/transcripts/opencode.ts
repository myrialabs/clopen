/**
 * Open Code sessions: rows in `pool/<scope>/opencode/opencode.db`, one database
 * per Profile scope.
 *
 * Read with a read-only connection. Removed only through Open Code's own API
 * (`DELETE /session/{id}`), never by writing to its database: the schema is Open
 * Code's, it migrates it, and a running server holds it open. A session's bytes
 * are not apportioned — that would mean grouping every row of a gigabyte table
 * on the server's thread — so the store reports its database size as a whole and
 * sessions by count. The database does not shrink when rows go; Open Code reuses
 * the space.
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import type { TranscriptEntry, TranscriptRemoval, TranscriptStore } from './types';

const poolRoot = () => join(getEngineUserConfigDir('opencode'), 'pool');
/** Base64url of `DEFAULT_SCOPE_KEY` in the Open Code adapter. */
const DEFAULT_SCOPE_DIR = Buffer.from('mcp:*|agents:*').toString('base64url');

export async function openCodeDatabases(): Promise<{ scopeDir: string; file: string }[]> {
	try {
		const scopes = await fs.readdir(poolRoot());
		const found: { scopeDir: string; file: string }[] = [];
		for (const scope of scopes) {
			const file = join(poolRoot(), scope, 'opencode', 'opencode.db');
			try {
				await fs.access(file);
				found.push({ scopeDir: scope, file });
			} catch { /* scope without a database yet */ }
		}
		return found;
	} catch {
		return [];
	}
}

function readSessions(file: string): { id: string; parent_id: string | null; directory: string | null; time_updated: number | null }[] {
	let db: Database | null = null;
	try {
		db = new Database(file, { readonly: true });
		return db.prepare('SELECT id, parent_id, directory, time_updated FROM session').all() as {
			id: string; parent_id: string | null; directory: string | null; time_updated: number | null;
		}[];
	} catch (error) {
		debug.warn('storage', `Could not read Open Code sessions from ${file}:`, error);
		return [];
	} finally {
		db?.close();
	}
}

export const openCodeTranscripts: TranscriptStore = {
	engine: 'opencode',
	roots: () => [poolRoot()],

	async list() {
		const entries: TranscriptEntry[] = [];
		for (const { scopeDir, file } of await openCodeDatabases()) {
			for (const row of readSessions(file)) {
				entries.push({
					engine: 'opencode',
					id: row.id,
					paths: [],
					bytes: 0,
					mtimeMs: row.time_updated ?? 0,
					projectKey: scopeDir,
					projectPath: row.directory,
					parentId: row.parent_id
				});
			}
		}
		return entries;
	},

	async exists(id) {
		for (const { file } of await openCodeDatabases()) {
			if (readSessions(file).some(row => row.id === id)) return true;
		}
		return false;
	},

	async remove(entries) {
		const result: TranscriptRemoval = { freedBytes: 0, removed: 0, errors: [] };
		const removable = entries.filter(entry => entry.projectKey === DEFAULT_SCOPE_DIR);
		if (removable.length === 0) return result;

		try {
			const { ensureClient } = await import('$backend/engine/adapters/opencode/server');
			const client = await ensureClient();
			// Children first, so a parent is never deleted while a child that is
			// being removed in the same pass still points at it.
			const ids = new Set(removable.map(entry => entry.id));
			const depth = (entry: TranscriptEntry): number => {
				let d = 0;
				let parent = entry.parentId;
				while (parent && ids.has(parent) && d < 64) {
					d++;
					parent = removable.find(e => e.id === parent)?.parentId ?? null;
				}
				return d;
			};
			const ordered = [...removable].sort((a, b) => depth(b) - depth(a));
			for (const entry of ordered) {
				try {
					await client.session.delete({
						path: { id: entry.id },
						...(entry.projectPath && { query: { directory: entry.projectPath } })
					});
					result.removed++;
				} catch (error) {
					result.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} catch (error) {
			result.errors.push(`Open Code is unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
		return result;
	}
};

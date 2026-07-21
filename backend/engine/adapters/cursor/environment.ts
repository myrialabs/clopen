/**
 * Cursor session-store isolation.
 *
 * Cursor local agents persist to disk. The SDK's default backend is on-disk
 * SQLite under `getDefaultSdkStateRoot()` (which needs the native `sqlite3`
 * addon), and it would write under the user's own state root. We sidestep both
 * concerns by pointing every agent at a portable `JsonlLocalAgentStore` rooted in
 * Clopen's ISOLATED engine dir (`{clopenDir}/engine/cursor/user/agents/`), never
 * `~/.cursor` (README §10.19).
 *
 * The store is keyed per project so concurrent projects never collide, and a
 * resume/fork within a project reuses the same store instance directory.
 */

import { join } from 'node:path';
import { JsonlLocalAgentStore } from '@cursor/sdk';
import { getEngineUserConfigDir } from '$backend/utils/paths';

/** Root dir holding every project's isolated Cursor agent store. */
export function getCursorStoreRoot(): string {
	return join(getEngineUserConfigDir('cursor'), 'agents');
}

/** Per-project isolated store directory. */
function getCursorStoreDir(projectPath: string): string {
	return join(getCursorStoreRoot(), projectPath.replace(/[^a-zA-Z0-9]/g, '-') || 'default');
}

/** A per-project `JsonlLocalAgentStore` for a stream (create + resume + fork). */
export function getCursorStore(projectPath: string): JsonlLocalAgentStore {
	return new JsonlLocalAgentStore(getCursorStoreDir(projectPath));
}

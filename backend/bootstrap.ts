/**
 * Post-database-init bootstrap
 *
 * Re-establishes code-defined built-ins that live OUTSIDE the migration/seeder
 * pipeline — internal MCP servers (e.g. Browser Automation) synced from code,
 * and the default engine install. These are normally set up once at server
 * startup, right after `initializeDatabase()`.
 *
 * "Clear All Data" wipes the whole ~/.clopen directory and re-runs only
 * migrations + seeders on the SAME live process, so anything established here
 * would silently vanish until the next restart. Sharing this function between
 * startup and the clear-data handler keeps built-ins alive across a data reset
 * without a restart — and means any future startup-synced built-in is covered
 * automatically.
 */

import { syncInternalServers } from './mcp';
import { ensureDefaultEngineInstalled } from './engine/bootstrap-default-engine';
import { bootstrapMemoryGraph } from './memory/bootstrap';
import { ensureMemoryModel } from './memory/model';
import { debug } from '$shared/utils/logger';

/**
 * Rebuild DB-derived built-ins after the database is (re)initialized.
 *
 * Idempotent and safe to call on an already-running process. Intentionally does
 * NOT start long-lived schedulers — those are launched once from `startServer()`
 * and would double-run if invoked again on the live process during clear-data.
 */
export function bootstrapAfterDbInit(): void {
	// Mirror code-defined internal MCP servers into the mcp_servers table and
	// refresh the enabled cache. Without this, a post-startup DB wipe leaves
	// Settings → MCP empty until the next restart.
	syncInternalServers();

	// Fresh/emptied install: (re)install a usable engine in the background.
	// No-ops once any engine is already present. Fire-and-forget.
	//
	// Memory's extraction model is picked from that engine's catalog, so it is
	// chosen again once the install settles. `bootstrapMemoryGraph` already tries
	// on its own, but on a fresh or just-cleared install the engine is usually not
	// ready yet and the catalog comes back empty — which left memory with no model
	// until someone found the settings page, and is the state a data wipe used to
	// land in. `ensureMemoryModel` is idempotent and never overwrites an explicit
	// choice, so running it twice costs nothing.
	void ensureDefaultEngineInstalled()
		.then(() => ensureMemoryModel())
		.catch(error => debug.warn('server', 'Default engine / memory model bootstrap failed', error));

	// Fetch the embedding artifact and backfill memory vectors in the background.
	// Recall is gated on the artifact, but recording is not, so nothing here
	// blocks startup.
	bootstrapMemoryGraph();

	debug.log('server', '✅ Post-DB bootstrap complete');
}

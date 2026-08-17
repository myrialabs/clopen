/**
 * Memory Graph startup.
 *
 * Fetching the embedding artifact and backfilling vectors both happen in the
 * background. The artifact is REQUIRED for recall (see `readiness.ts`), but
 * blocking startup on a 44 MB download would hold the whole app hostage to one
 * feature — and it is unnecessary, because the half that must not miss anything
 * is RECORDING, which needs no artifact. Turns are captured from the first
 * second; the indexer backfills their vectors when the download lands.
 *
 * Called from `bootstrapAfterDbInit`, which also runs after "Clear All Data"
 * wipes `~/.clopen` on the live process — so the artifact is re-fetched then too,
 * rather than staying missing until the next restart.
 */

import { memoryQueueQueries } from '$backend/database/queries/memory-queue-queries';
import { debug } from '$shared/utils/logger';
import { ensureEmbeddingArtifact, onEmbeddingInstallChange, vectorCache } from './embedding';
import { notifyMemoryReadiness } from './notify';
import { resetGraphEmptiness } from './context';
import { reconcileVectorIndex } from './indexer';
import { startMemoryMaintenance } from './maintenance';
import { resetGraphLayoutState, scheduleGraphLayout } from './layout';
import { ensureMemoryModel } from './model';
import { startExtractionRunner } from './extract';

/**
 * Ensure the embedding artifact is present, then reconcile the vector index.
 * Fire-and-forget; a failed download schedules its own retry.
 *
 * IDEMPOTENT, WITH NO LATCH, and that is load-bearing. A `started` flag here made
 * the whole function a no-op on its second call — which is exactly the call that
 * matters, because "Clear All Data" re-runs this on the LIVE process after wiping
 * the settings table. The result was a workspace that came back with no
 * extraction model and no way to get one but choosing it by hand, while a fresh
 * install configured itself. Everything below either guards itself
 * (`startMemoryMaintenance`, `startExtractionRunner`, `ensureMemoryModel`) or is
 * something a wipe genuinely requires re-running.
 */
export function bootstrapMemoryGraph(): void {
	// "Clear All Data" wipes the database under a live process, so anything the
	// cache is still holding describes rows that no longer exist.
	vectorCache.reset();
	resetGraphEmptiness();

	// Same reason as the caches above: "Clear All Data" wipes the database under a
	// live process, so what the last pass laid out describes rows that no longer
	// exist. Scheduling one here is also what places an EXISTING graph the first
	// time the upgrade runs — until it lands the view falls back to the flat
	// listing it always used, so nothing is missing meanwhile.
	resetGraphLayoutState();
	scheduleGraphLayout();

	// Duplicate collapse and retention are pure SQL and are worth running whether
	// or not the artifact ever lands, so maintenance starts independently of the
	// download. Its own first tick is minutes away, well clear of startup.
	startMemoryMaintenance();

	// Entries whose session is gone can never succeed and would be retried
	// forever, showing in the status counts as outstanding work. Sessions are
	// deleted through several paths and only some of them cancel their extraction
	// — a project being removed takes its sessions with it without this queue ever
	// hearing about it.
	try {
		const orphans = memoryQueueQueries.pruneOrphans();
		if (orphans > 0) debug.log('memory', `Dropped ${orphans} extraction entr(ies) for deleted sessions`);
	} catch (error) {
		debug.warn('memory', 'Failed to prune the extraction queue', error);
	}

	// Pick up anything the previous process left queued, and put entries that had
	// exhausted their attempts back in line — a restart usually means whatever was
	// broken (a missing model, an expired account, an engine that was down) has
	// just been changed.
	startExtractionRunner();

	// Any change to install progress is a change to what the setup banner says.
	// Wired here rather than inside the installer so that module stays free of
	// transport concerns and remains testable without a WebSocket.
	onEmbeddingInstallChange(notifyMemoryReadiness);

	// Choose an extraction model if none has been set, so a fresh install records
	// from its very first turn instead of waiting for someone to find the settings
	// page. Best-effort here — the engine catalog is often not loaded this early,
	// which is why extraction asks again before its first run (see `model.ts`).
	void ensureMemoryModel()
		.then(model => {
			if (model) notifyMemoryReadiness();
		})
		.catch(error => {
			debug.warn('memory', 'Could not pick a default memory model at startup', error);
		});

	void (async () => {
		try {
			// Recall is GATED on this, not merely improved by it (see `readiness.ts`),
			// so a failure schedules its own retry rather than settling for lexical
			// search. Startup is still not blocked: recording runs regardless, and the
			// indexer backfills vectors for everything written meanwhile.
			const ready = await ensureEmbeddingArtifact();
			if (!ready) {
				debug.log('memory', 'Embedding artifact unavailable — recall stays off until it installs');
				return;
			}
			await reconcileVectorIndex();
		} catch (error) {
			debug.warn('memory', 'Memory graph bootstrap failed (non-fatal)', error);
		}
	})();
}

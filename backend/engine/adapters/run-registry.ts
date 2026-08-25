/**
 * The runs an engine instance is currently serving.
 *
 * One instance is shared by every chat session of a project (see
 * `getProjectEngine`), so at any moment it can be streaming several chats at
 * once. Everything a single stream owns — its abort controller, its SDK query
 * or session, its pooled server, its parked questions — therefore belongs to a
 * RUN and not to the instance. An instance field holds only the most recently
 * started stream, which is how "Stop this chat" came to abort a different chat
 * of the same project.
 *
 * A run is identified by the AbortController its caller passed to
 * `streamQuery`. That is the same object `StreamState.abortController` holds,
 * so it is the one handle the stream-manager and the adapter already agree on —
 * no ids to mint, no bookkeeping to keep in sync.
 *
 * Adapters own the SHAPE of a run (each SDK exposes different handles) and this
 * class owns the BOOKKEEPING, so the targeting rules live in one place instead
 * of eight.
 */

/** The one field every adapter's run state must expose: its own controller. */
export interface EngineRun {
	controller: AbortController;
}

export class EngineRuns<T extends EngineRun> {
	private byController = new Map<AbortController, T>();

	/** True while at least ONE run is in flight — the answer `AIEngine.isActive` owes its callers. */
	get isActive(): boolean {
		return this.byController.size > 0;
	}

	/** Register a run for the duration of one `streamQuery` call. */
	add(run: T): T {
		this.byController.set(run.controller, run);
		return run;
	}

	/** Unregister a finished run. Idempotent — cancel and the stream's own `finally` both call it. */
	remove(run: T): void {
		this.byController.delete(run.controller);
	}

	/**
	 * The run a targeted `cancel` / `interrupt` applies to.
	 *
	 * An owner that has already finished selects NOTHING. Falling back to "the
	 * runs that are left" is what made Stop in one chat kill another chat of the
	 * same project: the caller named a stream that had ended, and the engine
	 * helpfully tore down whichever one it still had.
	 */
	select(owner: AbortController): T[] {
		const run = this.byController.get(owner);
		return run ? [run] : [];
	}

	/** Every run — for `dispose()` and shutdown, the only places that may stop them all. */
	all(): T[] {
		return [...this.byController.values()];
	}
}

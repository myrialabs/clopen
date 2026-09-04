/**
 * Applying engine config changes without anyone pressing anything.
 *
 * This is the piece that replaced the "Restart Server" button. The button asked
 * the user to understand something they should never have had to: that Open Code
 * runs as a process which froze its configuration at boot, and that their edit
 * would quietly do nothing until they told the server to start again. Worse, the
 * button's only implementation was destructive — it aborted every running chat,
 * which is why it had to ask for confirmation, which is why new users learned to
 * be afraid of it.
 *
 * What happens instead, driven entirely by the config revision:
 *
 *   nothing is streaming → a replacement server is spawned and health-checked
 *                          NOW, and only once it is up does the old one go. The
 *                          user's next message costs nothing.
 *
 *   something is streaming → nothing is touched. The running turn finishes under
 *                            the config it started with; the next stream resolves
 *                            the new config on its own and binds to a new server,
 *                            and the old one is reaped when its last stream lets
 *                            go of it.
 *
 * Both cases are the same mechanism — the pool keys servers by a hash of the
 * config they were spawned with — so this module only decides WHEN to pay the
 * spawn cost, never whether the right config is used. That part cannot be got
 * wrong by anything here.
 */

import { streamManager } from '../chat';
import { onEngineConfigChanged } from './config-revision';
import { retireAllEngines } from './index';
import {
	acquireServer,
	pooledScopeKeys,
	reconcileServerHolders,
	revalidatePool,
	setLiveStreamSource,
	DEFAULT_SCOPE_KEY,
} from './adapters/opencode/server';
import { debug } from '$shared/utils/logger';

let started = false;

/**
 * Re-warm the Open Code pool for the scopes that are actually in use.
 *
 * Only the default (no-Profile) scope can be warmed blind: a Profile scope's
 * spec is built from that Profile's connector and subagent set at stream start,
 * and reconstructing it here would duplicate that resolution. Profile servers
 * therefore respawn lazily on their next stream, which is the correct trade —
 * they are the rarer case, and the cost is one spawn on a turn that was going to
 * talk to a server anyway.
 */
async function warmDefaultScope(): Promise<void> {
	try {
		await acquireServer({});
		debug.log('engine', 'Open Code default server re-warmed for the new config');
	} catch (error) {
		// Deliberately silent to the user. A config that cannot start is a real
		// problem, but the honest place to report it is the turn that needs it —
		// where the error is actionable and in context — not a background toast
		// about a server the user was never told about.
		debug.warn('engine', 'Open Code warm-up failed; keeping the current server until a turn needs the new config', error);
	}
}

/**
 * Start reacting to engine config changes. Idempotent.
 */
export function startEngineHotReload(): void {
	if (started) return;
	started = true;

	// The pool sweeps itself on a timer; this is where it learns which holds are
	// still backed by a running stream.
	setLiveStreamSource(() => new Set(streamManager.getActiveStreams().map(s => s.streamId)));

	onEngineConfigChanged(revision => {
		// Holder bookkeeping is reconciled against the live stream set first, so
		// "is anything running" and "is this server still needed" are answered from
		// the same source of truth rather than from two drifting counters.
		const liveStreams = streamManager.getActiveStreams();
		reconcileServerHolders(new Set(liveStreams.map(s => s.streamId)));

		// Engines other than Open Code hold no baked config, but they DO cache
		// credentialed clients. Retiring evicts those without touching a stream
		// that is mid-answer.
		retireAllEngines();

		// Read BEFORE revalidating: revalidation is what makes the outgoing default
		// server reapable, so asking afterwards would report the scope as unused
		// and skip the warm-up on exactly the change that needs it.
		const defaultScopeInUse = pooledScopeKeys().includes(DEFAULT_SCOPE_KEY);

		// Re-resolve every pooled scope's key, not just the default one. A Profile
		// server is otherwise still its own scope's current key, so it is neither
		// superseded nor idle and goes on serving the config — and the credentials —
		// that were just replaced. Held servers are unaffected: they are pinned.
		void revalidatePool().then(() => {
			if (liveStreams.length > 0) {
				debug.log(
					'engine',
					`Engine config now at revision ${revision}; ${liveStreams.length} stream(s) in flight — ` +
					'applying it to the next turn and draining the old server behind them'
				);
				return;
			}
			if (defaultScopeInUse) return warmDefaultScope();
		});
	});

	debug.log('engine', 'Engine hot-reload active');
}

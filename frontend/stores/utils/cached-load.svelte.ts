/**
 * Reactive wrapper around the load-once cache policy.
 *
 * The policy itself — and the reasoning behind it — lives in `./cached-load.ts`,
 * which is rune-free so it can be tested directly. All this adds is the `$state`
 * mirror components read, kept in step through the core's `publish` callback.
 */

import { createCachedLoadCore, type CachedLoad } from './cached-load';

export type { CachedLoad };

/**
 * @param label Used only in the log line when a load fails.
 */
export function createCachedLoad(label: string): CachedLoad {
	let loadedState = $state(false);

	const core = createCachedLoadCore(label, (next) => {
		loadedState = next;
	});

	return {
		// Read from the reactive mirror rather than the core, so components that
		// render on `loaded` actually re-render when it flips.
		get loaded() {
			return loadedState;
		},
		ensure: core.ensure,
		refresh: core.refresh,
		markLoaded: core.markLoaded,
		reset: core.reset
	};
}

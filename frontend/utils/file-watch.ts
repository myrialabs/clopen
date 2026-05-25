/**
 * Client-side reference counting for the project file watcher.
 *
 * Multiple panels (the Files dock and the Git dock) independently want the
 * active project watched, but the backend ref-counts viewers per *connection* —
 * it cannot tell two panels on the same connection apart. So the client must
 * coordinate: emit exactly one `files:watch` per project path and `files:unwatch`
 * only when the last consumer releases. This keeps watch/unwatch symmetric no
 * matter which panels are open or in what order they mount/unmount.
 */

import ws, { onWsReconnect } from '$frontend/utils/ws';

const counts = new Map<string, number>();

// Re-arm every active watch after a reconnect. The backend drops all viewer
// state when the socket closes, so without this the watcher would stay dead
// until the next project switch or window focus, silently going stale.
onWsReconnect(() => {
	for (const projectPath of counts.keys()) {
		ws.emit('files:watch', { projectPath });
	}
});

/**
 * Register interest in watching `projectPath`. Returns a release function that
 * must be called (e.g. from an effect cleanup) when the consumer no longer
 * needs the watch. The path is captured here, so callers can release correctly
 * even after their reactive project reference has advanced.
 */
export function acquireFileWatch(projectPath: string): () => void {
	if (!projectPath) return () => {};

	const next = (counts.get(projectPath) ?? 0) + 1;
	counts.set(projectPath, next);
	if (next === 1) {
		ws.emit('files:watch', { projectPath });
	}

	let released = false;
	return () => {
		if (released) return;
		released = true;
		const current = counts.get(projectPath) ?? 0;
		if (current <= 1) {
			counts.delete(projectPath);
			ws.emit('files:unwatch', { projectPath });
		} else {
			counts.set(projectPath, current - 1);
		}
	};
}

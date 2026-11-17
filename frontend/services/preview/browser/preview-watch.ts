/**
 * Tell the server this browser tab has a Preview open.
 *
 * The server sends a Preview's live detail — page console lines, the agent's
 * cursor steps — only to connections that say so (backend/ws/preview/watchers.ts).
 * Counted, because more than one Preview can be mounted at once; the server
 * forgets on disconnect, so the claim is repeated after every reconnect.
 */

import ws, { onWsReconnect } from '$frontend/utils/ws';

let mounted = 0;
let stopReclaiming: (() => void) | null = null;

export function watchPreview(): () => void {
	mounted++;
	if (mounted === 1) {
		ws.emit('preview:watch', { watching: true });
		stopReclaiming = onWsReconnect(() => ws.emit('preview:watch', { watching: true }));
	}

	let released = false;
	return () => {
		if (released) return;
		released = true;
		mounted--;
		if (mounted === 0) {
			stopReclaiming?.();
			stopReclaiming = null;
			ws.emit('preview:watch', { watching: false });
		}
	};
}

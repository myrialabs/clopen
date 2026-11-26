import { getContext, onDestroy, setContext } from 'svelte';
import { isFileDrag } from '$frontend/utils/file-drop';

/**
 * The whole chat panel takes dropped files, not just the message box.
 *
 * The box used to be the only drop target: it shrinks as attachments pile up
 * above it, so a drop on the attachment list, the conversation or the panel's
 * edge went nowhere (or opened the file in the tab). The panel provides the
 * zone and its overlay; the composer on screen registers what to do with the
 * files.
 */

const KEY = Symbol('chat-drop-zone');

type DropHandler = (files: File[]) => void;

interface ChatDropZoneContext {
	register: (handler: DropHandler) => () => void;
}

/** A drag that stopped sending dragover (Esc, left the window) is over. */
const STALE_DRAG_MS = 1000;

export function provideChatDropZone() {
	let handler = $state<DropHandler | null>(null);
	let isDragging = $state(false);
	// dragenter/dragleave fire for every child crossed; the drag is over the
	// zone while more have been entered than left.
	let depth = 0;
	let staleTimer: ReturnType<typeof setTimeout> | null = null;

	function end() {
		depth = 0;
		isDragging = false;
		if (staleTimer) {
			clearTimeout(staleTimer);
			staleTimer = null;
		}
	}

	function keepAlive() {
		if (staleTimer) clearTimeout(staleTimer);
		staleTimer = setTimeout(end, STALE_DRAG_MS);
	}

	setContext<ChatDropZoneContext>(KEY, {
		register(next) {
			handler = next;
			return () => {
				if (handler === next) handler = null;
				end();
			};
		}
	});

	function ondragenter(event: DragEvent) {
		if (!handler || !isFileDrag(event)) return;
		event.preventDefault();
		depth++;
		isDragging = true;
		keepAlive();
	}

	function ondragover(event: DragEvent) {
		if (!handler || !isFileDrag(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
		isDragging = true;
		keepAlive();
	}

	function ondragleave(event: DragEvent) {
		if (!handler || !isFileDrag(event)) return;
		depth = Math.max(0, depth - 1);
		if (depth === 0) end();
	}

	function ondrop(event: DragEvent) {
		if (!handler || !isFileDrag(event)) return;
		event.preventDefault();
		const files = Array.from(event.dataTransfer?.files ?? []);
		end();
		if (files.length > 0) handler(files);
	}

	onDestroy(end);

	return {
		get isDragging() {
			return isDragging;
		},
		ondragenter,
		ondragover,
		ondragleave,
		ondrop
	};
}

/** Take the files dropped on the surrounding chat panel, while mounted. */
export function useChatDropTarget(handler: DropHandler) {
	const zone = getContext<ChatDropZoneContext | undefined>(KEY);
	if (!zone) return;
	const unregister = zone.register(handler);
	onDestroy(unregister);
}

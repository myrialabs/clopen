/**
 * Dragging files from the desktop into the app.
 *
 * A file let go anywhere that doesn't take it makes the browser open it in
 * place of the app — losing whatever was on screen, a half-written message
 * included. The guard turns such a drop into a no-op and shows the "not
 * allowed" cursor over places that don't take files. Drop zones are unaffected:
 * they handle the event first, and the guard leaves alone what they handled.
 */

/** Whether a drag carries files (not text, a link or an element of the page). */
export function isFileDrag(event: DragEvent): boolean {
	const types = event.dataTransfer?.types;
	if (!types) return false;
	for (let i = 0; i < types.length; i++) {
		if (types[i] === 'Files') return true;
	}
	return false;
}

let installed = false;

export function installFileDropGuard(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;

	window.addEventListener('dragover', (event) => {
		if (event.defaultPrevented || !isFileDrag(event)) return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
	});

	window.addEventListener('drop', (event) => {
		if (event.defaultPrevented || !isFileDrag(event)) return;
		event.preventDefault();
	});
}

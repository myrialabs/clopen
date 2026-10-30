/**
 * Preview clipboard sync (device side)
 *
 * Keeps the user's device clipboard and the workspace clipboard on the server
 * in step, in both directions.
 *
 * **Workspace → device.** Whatever a preview page copies (its "Copy" button,
 * Ctrl/⌘+C), whatever an agent sets, and whatever the context menu copies
 * arrives here as `preview:browser-clipboard-sync` and is written to the
 * device. Browsers only accept a clipboard write from a focused document, so a
 * write that arrives while Clopen is in the background is held and applied the
 * moment the window is focused again — newest wins.
 *
 * **Device → workspace.** What the user copies anywhere has to be pasteable in
 * the preview, by them and by an agent. The device clipboard is read when the
 * window regains focus (they may have copied in another app) and after every
 * copy or cut inside Clopen itself. Reading needs the browser's clipboard-read
 * permission; it is requested once, from a click inside the preview — a user
 * gesture, which is what browsers require before they will show the prompt.
 * Without the permission, the device side still reaches the workspace through
 * every paste the user makes in the preview.
 */

import ws from '$frontend/utils/ws';
import { copyText } from '$frontend/utils/clipboard';
import { currentScopeKey } from '$frontend/stores/features/worktrees.svelte';
import { getActiveWorkspaceProjectId } from '$frontend/stores/ui/project-workspace.svelte';
import { debug } from '$shared/utils/logger';

let initialized = false;

/** A write that arrived while the window was in the background. */
let pendingWrite: string | null = null;

/** Last text known to be on both sides — never re-sent, never re-written. */
let lastSynced: string | null = null;

/** Whether this device has already been asked for clipboard-read permission. */
let permissionAsked = false;

function activeScope(): string | null {
	return currentScopeKey() || getActiveWorkspaceProjectId() || null;
}

async function readPermission(): Promise<PermissionState | 'unsupported'> {
	try {
		const status = await navigator.permissions.query({ name: 'clipboard-read' as PermissionName });
		return status.state;
	} catch {
		return 'unsupported';
	}
}

/** Send the device clipboard to the workspace, if it changed. */
async function pushDeviceClipboard(): Promise<void> {
	if (!navigator.clipboard?.readText || !document.hasFocus()) return;
	if (!activeScope()) return;

	try {
		const text = await navigator.clipboard.readText();
		if (!text || text === lastSynced) return;
		lastSynced = text;
		ws.emit('preview:browser-clipboard-set', { text });
	} catch {
		// Denied, or the document lost focus mid-read — the next focus retries.
	}
}

/** Apply a workspace copy to the device clipboard. */
async function applyWrite(text: string): Promise<void> {
	if (!document.hasFocus()) {
		pendingWrite = text;
		return;
	}

	pendingWrite = null;
	lastSynced = text;
	const ok = await copyText(text);
	if (!ok) {
		// Refused despite focus (a browser that wants a gesture): retry on the
		// next focus rather than dropping the copy.
		pendingWrite = text;
		debug.warn('preview', 'Device clipboard refused the preview copy; will retry on focus');
	}
}

async function onFocus(): Promise<void> {
	if (pendingWrite !== null) {
		await applyWrite(pendingWrite);
		return;
	}
	if ((await readPermission()) === 'granted') await pushDeviceClipboard();
}

/** Register the always-on listeners. Idempotent. */
export function initPreviewClipboardSync(): void {
	if (initialized) return;
	initialized = true;

	ws.on('preview:browser-clipboard-sync', (data) => {
		const scope = activeScope();
		if (scope && data.projectId !== scope) return;
		if (data.text === lastSynced) return;
		void applyWrite(data.text);
	});

	window.addEventListener('focus', () => void onFocus());
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void onFocus();
	});

	// A copy inside Clopen itself (chat, editor, a terminal). The clipboard is
	// only written once the event has finished, so it is read a tick later.
	const afterCopy = () => {
		setTimeout(async () => {
			if ((await readPermission()) === 'granted') await pushDeviceClipboard();
		}, 50);
	};
	document.addEventListener('copy', afterCopy);
	document.addEventListener('cut', afterCopy);
}

/**
 * Ask for clipboard-read permission, once, from inside a user gesture.
 *
 * Called on a press inside the preview: that is the moment the user is
 * interacting with the thing the permission is for, and browsers will only
 * show the prompt from a gesture.
 */
export function primeClipboardRead(): void {
	if (permissionAsked || !navigator.clipboard?.readText) return;
	permissionAsked = true;

	void readPermission().then((state) => {
		if (state === 'denied') return;
		// `readText` itself raises the prompt when the state is still "prompt";
		// a granted read doubles as the first sync.
		void pushDeviceClipboard();
	});
}

/**
 * The user copied out of the preview themselves (Ctrl/⌘+C on the canvas).
 * The device already has it; the workspace has to learn it too.
 */
export function noteDeviceCopy(text: string): void {
	if (!text || text === lastSynced) return;
	lastSynced = text;
	ws.emit('preview:browser-clipboard-set', { text });
}

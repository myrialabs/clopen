/**
 * Notes Store — notes grouped into collections, scoped per project or globally.
 *
 * The server is the source of truth. Scope lives on the collection, never on
 * the note, so there is one answer to "who may read this" per note.
 *
 * Editing autosaves: there is no Save button, so every keystroke is debounced
 * into one `notes:update`. Writes are last-write-wins by design — two people in
 * the same note will overwrite each other rather than merge.
 *
 * Images are fetched with the session token in an `Authorization` header and
 * held as object URLs. They are deliberately *not* addressed as
 * `/api/notes/images/<id>?token=<session-token>`: a `<img src>` URL lands in
 * the browser history, in every reverse proxy's access log, and — for an
 * instance published through a tunnel — in that provider's edge logs. A session
 * token is a bearer credential for the whole account, so it never goes in a URL.
 */

import ws from '$frontend/utils/ws';
import { authStore } from '$frontend/stores/features/auth.svelte';
import { registerDock, beginPanelLoad } from '$frontend/stores/ui/project-workspace.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { debug } from '$shared/utils/logger';
import type {
	NoteCollection,
	NoteImage,
	NoteScope,
	NoteWithImages
} from '$shared/types/database/schema';

/** How long typing has to stop before the note is written back. */
const AUTOSAVE_DELAY_MS = 700;
/** Collapse a burst of remote edits into one refetch. */
const REMOTE_RELOAD_DELAY_MS = 400;

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

interface NotesState {
	scope: NoteScope;
	collections: NoteCollection[];
	notes: NoteWithImages[];
	currentNoteId: string | null;
	/** Collection a new note lands in; null means the scope's default. */
	activeCollectionId: string | null;
	collapsed: Record<string, boolean>;
	search: string;
	isLoading: boolean;
	saveStatus: SaveStatus;
	error: string | null;
}

export const notesState = $state<NotesState>({
	scope: 'project',
	collections: [],
	notes: [],
	currentNoteId: null,
	activeCollectionId: null,
	collapsed: {},
	search: '',
	isLoading: false,
	saveStatus: 'idle',
	error: null
});

export const currentNote = {
	get value(): NoteWithImages | null {
		if (!notesState.currentNoteId) return null;
		return notesState.notes.find((n) => n.id === notesState.currentNoteId) ?? null;
	}
};

function currentProjectId(): string | null {
	return projectState.currentProject?.id ?? null;
}

// ============================================
// LOADING
// ============================================

export async function loadNotes(): Promise<void> {
	const scope = notesState.scope;
	const projectId = currentProjectId();
	if (scope === 'project' && !projectId) {
		notesState.collections = [];
		notesState.notes = [];
		notesState.currentNoteId = null;
		return;
	}

	const releasePanel = beginPanelLoad('notes');
	notesState.isLoading = true;
	notesState.error = null;
	try {
		const res = await ws.http('notes:list', { scope, projectId });
		notesState.collections = res.collections as NoteCollection[];
		notesState.notes = res.notes as NoteWithImages[];
		if (notesState.currentNoteId && !notesState.notes.some((n) => n.id === notesState.currentNoteId)) {
			notesState.currentNoteId = null;
		}
		if (
			notesState.activeCollectionId &&
			!notesState.collections.some((c) => c.id === notesState.activeCollectionId)
		) {
			notesState.activeCollectionId = null;
		}
	} catch (error) {
		notesState.error = error instanceof Error ? error.message : String(error);
		debug.error('notes', 'Failed to load notes:', error);
	} finally {
		notesState.isLoading = false;
		releasePanel();
	}
}

/** Switch between this project's notes and the instance-wide ones. */
export async function setScope(scope: NoteScope): Promise<void> {
	if (notesState.scope === scope) return;
	// Anything still queued belongs to the collection we are leaving.
	await flushNoteSave();
	notesState.scope = scope;
	notesState.collections = [];
	notesState.notes = [];
	notesState.currentNoteId = null;
	notesState.activeCollectionId = null;
	await loadNotes();
}

// ============================================
// COLLECTIONS
// ============================================

export async function createCollection(name: string): Promise<NoteCollection | null> {
	const res = await ws.http('notes:create-collection', {
		name,
		scope: notesState.scope,
		projectId: notesState.scope === 'project' ? currentProjectId() : null
	});
	const collection = res.collection as NoteCollection;
	notesState.collections = [...notesState.collections, collection].sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	notesState.activeCollectionId = collection.id;
	return collection;
}

export async function renameCollection(id: string, name: string): Promise<void> {
	const res = await ws.http('notes:rename-collection', { id, name });
	const collection = res.collection as NoteCollection | null;
	if (!collection) return;
	notesState.collections = notesState.collections
		.map((c) => (c.id === id ? collection : c))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteCollection(id: string): Promise<void> {
	const doomed = notesState.notes.filter((n) => n.collection_id === id);
	await ws.http('notes:delete-collection', { id });
	for (const note of doomed) {
		for (const image of note.images) releaseNoteImageUrl(image.id);
	}
	notesState.collections = notesState.collections.filter((c) => c.id !== id);
	notesState.notes = notesState.notes.filter((n) => n.collection_id !== id);
	if (notesState.activeCollectionId === id) notesState.activeCollectionId = null;
	if (doomed.some((n) => n.id === notesState.currentNoteId)) notesState.currentNoteId = null;
}

export function toggleCollection(id: string): void {
	notesState.collapsed[id] = !notesState.collapsed[id];
}

// ============================================
// NOTES
// ============================================

export async function createNote(collectionId?: string | null): Promise<NoteWithImages | null> {
	await flushNoteSave();
	const target = collectionId ?? notesState.activeCollectionId;
	const res = await ws.http('notes:create', {
		...(target ? { collectionId: target } : {}),
		scope: notesState.scope,
		projectId: notesState.scope === 'project' ? currentProjectId() : null,
		title: 'Untitled',
		content: ''
	});
	const note = res.note as NoteWithImages;
	// The default collection may have been created by this call.
	if (!notesState.collections.some((c) => c.id === note.collection_id)) await loadNotes();
	else notesState.notes = [note, ...notesState.notes];
	notesState.currentNoteId = note.id;
	notesState.activeCollectionId = note.collection_id;
	return note;
}

async function updateNote(
	id: string,
	patch: { title?: string | null; content?: string; collectionId?: string }
): Promise<NoteWithImages | null> {
	const res = await ws.http('notes:update', { id, ...patch });
	const note = res.note as NoteWithImages | null;
	if (note) notesState.notes = notesState.notes.map((n) => (n.id === id ? note : n));
	return note;
}

export async function moveNote(id: string, collectionId: string): Promise<void> {
	await flushNoteSave();
	await updateNote(id, { collectionId });
}

export async function deleteNote(id: string): Promise<void> {
	// Drop any queued write first, or it would recreate the content moments later.
	if (queued?.id === id) queued = null;
	const note = notesState.notes.find((n) => n.id === id);
	await ws.http('notes:delete', { id });
	for (const image of note?.images ?? []) releaseNoteImageUrl(image.id);
	notesState.notes = notesState.notes.filter((n) => n.id !== id);
	if (notesState.currentNoteId === id) notesState.currentNoteId = null;
}

export function selectNote(id: string | null): void {
	if (id === notesState.currentNoteId) return;
	// The queued write belongs to the note being left, so it has to land before
	// the editor swaps its contents out from under it.
	void flushNoteSave();
	notesState.currentNoteId = id;
	if (id) {
		const note = notesState.notes.find((n) => n.id === id);
		if (note) notesState.activeCollectionId = note.collection_id;
	}
}

export function clearNotes(): void {
	queued = null;
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	notesState.collections = [];
	notesState.notes = [];
	notesState.currentNoteId = null;
	notesState.activeCollectionId = null;
	notesState.search = '';
	notesState.isLoading = false;
	notesState.saveStatus = 'idle';
	notesState.error = null;
	releaseAllNoteImageUrls();
}

// ============================================
// AUTOSAVE
// ============================================

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let queued: { id: string; title: string | null; content: string } | null = null;
let inFlight = 0;

/** Whether this client is mid-write, so a broadcast is probably its own echo. */
function hasOwnWritePending(): boolean {
	return queued !== null || inFlight > 0;
}

/** Debounce an edit into a single write. Replaces any pending edit for the note. */
export function queueNoteSave(id: string, patch: { title: string | null; content: string }): void {
	// A queued edit for a *different* note must land before this one replaces it,
	// otherwise switching notes mid-debounce silently drops the earlier edit.
	if (queued && queued.id !== id) void flushNoteSave();
	queued = { id, ...patch };
	notesState.saveStatus = 'pending';
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => void flushNoteSave(), AUTOSAVE_DELAY_MS);
}

/** Write the queued edit now. Safe to call when nothing is queued. */
export async function flushNoteSave(): Promise<void> {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	const pending = queued;
	if (!pending) return;
	queued = null;
	inFlight++;
	notesState.saveStatus = 'saving';
	let failed = false;
	try {
		await updateNote(pending.id, { title: pending.title, content: pending.content });
	} catch (error) {
		debug.error('notes', 'Autosave failed:', error);
		failed = true;
	} finally {
		inFlight--;
	}
	// Settled *after* the counter drops: asking `hasOwnWritePending()` while this
	// write is still counted would never report anything but "saving".
	if (failed) notesState.saveStatus = 'error';
	else if (!hasOwnWritePending()) notesState.saveStatus = 'saved';
}

// ============================================
// IMAGES
// ============================================

/**
 * Object URLs keyed by image id. Attachments are immutable — a new id is minted
 * per upload — so one fetch per image per session is enough, and the editor can
 * re-render the same note without re-downloading it.
 */
const imageUrls = new Map<string, string>();
const imageRequests = new Map<string, Promise<string | null>>();

function authToken(): string {
	return authStore.sessionToken ?? '';
}

/** Fetch an attachment and return a displayable object URL (null on failure). */
export async function resolveNoteImageUrl(imageId: string): Promise<string | null> {
	const cached = imageUrls.get(imageId);
	if (cached) return cached;
	const inflight = imageRequests.get(imageId);
	if (inflight) return inflight;

	const request = (async () => {
		try {
			const res = await fetch(`/api/notes/images/${encodeURIComponent(imageId)}`, {
				headers: { Authorization: `Bearer ${authToken()}` }
			});
			if (!res.ok) {
				debug.error('notes', `Failed to load image ${imageId}: ${res.status}`);
				return null;
			}
			const url = URL.createObjectURL(await res.blob());
			imageUrls.set(imageId, url);
			return url;
		} catch (error) {
			debug.error('notes', 'Failed to load image:', error);
			return null;
		} finally {
			imageRequests.delete(imageId);
		}
	})();
	imageRequests.set(imageId, request);
	return request;
}

function releaseNoteImageUrl(imageId: string): void {
	const url = imageUrls.get(imageId);
	if (!url) return;
	URL.revokeObjectURL(url);
	imageUrls.delete(imageId);
}

function releaseAllNoteImageUrls(): void {
	for (const url of imageUrls.values()) URL.revokeObjectURL(url);
	imageUrls.clear();
	imageRequests.clear();
}

export async function uploadNoteImage(
	noteId: string,
	file: File
): Promise<{ image: NoteImage; url: string }> {
	const url = new URL('/api/notes/images/upload', window.location.origin);
	url.searchParams.set('noteId', noteId);
	url.searchParams.set('fileName', file.name);
	url.searchParams.set('fileSize', String(file.size));

	const res = await fetch(url.toString(), {
		method: 'POST',
		headers: { Authorization: `Bearer ${authToken()}` },
		body: file
	});
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(text || `Upload failed: ${res.status}`);
	}
	const data = (await res.json()) as { image: NoteImage; url: string };
	notesState.notes = notesState.notes.map((n) =>
		n.id === noteId ? { ...n, images: [...n.images, data.image] } : n
	);
	return data;
}

export async function deleteNoteImage(imageId: string, noteId: string): Promise<void> {
	await ws.http('notes:delete-image', { imageId });
	releaseNoteImageUrl(imageId);
	notesState.notes = notesState.notes.map((n) =>
		n.id === noteId ? { ...n, images: n.images.filter((img) => img.id !== imageId) } : n
	);
}

// ============================================
// WORKSPACE WIRING
// ============================================

let eventsBound = false;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

/** Subscribe to collaborative note events. Idempotent. */
export function initNotesEvents(): void {
	if (eventsBound) return;
	eventsBound = true;

	ws.on('notes:changed', (payload) => {
		if (payload.scope !== notesState.scope) return;
		if (payload.scope === 'project' && payload.projectId !== currentProjectId()) return;
		// Our own autosave echoes back here every debounce window; the response to
		// that write already updated the list, so refetching would be pure churn.
		if (hasOwnWritePending()) return;
		if (reloadTimer) clearTimeout(reloadTimer);
		reloadTimer = setTimeout(() => {
			reloadTimer = null;
			void loadNotes();
		}, REMOTE_RELOAD_DELAY_MS);
	});

	// Best-effort catch for a tab closed mid-debounce. The socket write may not
	// leave before the page goes, so the debounce is kept short rather than this
	// being relied on; closing the panel or leaving the field flushes properly.
	window.addEventListener('beforeunload', () => {
		void flushNoteSave();
	});
}

// The coordinator owns the switch: `clear()` drops the previous project's notes
// before the new project is revealed, and `load()` runs after, behind the notes
// panel's own skeleton. Loading from the panel's own `$effect` instead would
// show the previous project's notes for as long as the request takes.
registerDock({
	id: 'notes',
	panelId: 'notes',
	clear() {
		clearNotes();
	},
	load() {
		initNotesEvents();
		return loadNotes();
	}
});

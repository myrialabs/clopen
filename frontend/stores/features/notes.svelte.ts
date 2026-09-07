/**
 * Notes Store — project-scoped markdown notes
 *
 * Server is source of truth. All CRUD via ws.http.
 * Images via HTTP /api/notes/images with Bearer token.
 */

import ws from '$frontend/utils/ws';
import { authStore } from '$frontend/stores/features/auth.svelte';
import { debug } from '$shared/utils/logger';
import type { Note, NoteImage, NoteWithImages } from '$shared/types/database/schema';

interface NotesState {
	notes: NoteWithImages[];
	currentNoteId: string | null;
	isLoading: boolean;
	error: string | null;
}

export const notesState = $state<NotesState>({
	notes: [],
	currentNoteId: null,
	isLoading: false,
	error: null
});

export const currentNote = {
	get value(): NoteWithImages | null {
		if (!notesState.currentNoteId) return null;
		return notesState.notes.find((n) => n.id === notesState.currentNoteId) ?? null;
	}
};

export async function loadNotes(projectId: string): Promise<void> {
	if (!projectId) {
		notesState.notes = [];
		notesState.currentNoteId = null;
		return;
	}
	notesState.isLoading = true;
	notesState.error = null;
	try {
		const res = await ws.http('notes:list', { projectId });
		notesState.notes = (res.notes as NoteWithImages[]) ?? [];
		if (notesState.currentNoteId && !notesState.notes.some((n) => n.id === notesState.currentNoteId)) {
			notesState.currentNoteId = null;
		}
	} catch (error) {
		notesState.error = error instanceof Error ? error.message : String(error);
		debug.error('notes', 'Failed to load notes:', error);
	} finally {
		notesState.isLoading = false;
	}
}

export async function createNote(projectId: string, title: string | null, content: string): Promise<NoteWithImages | null> {
	try {
		const res = await ws.http('notes:create', { projectId, content, title: title ?? null });
		const note = res.note as NoteWithImages;
		notesState.notes = [note, ...notesState.notes];
		notesState.currentNoteId = note.id;
		return note;
	} catch (error) {
		debug.error('notes', 'Failed to create note:', error);
		throw error;
	}
}

export async function updateNote(id: string, patch: { title?: string | null; content?: string }): Promise<NoteWithImages | null> {
	try {
		const res = await ws.http('notes:update', { id, ...patch });
		const note = res.note as NoteWithImages | null;
		if (note) {
			notesState.notes = notesState.notes.map((n) => (n.id === id ? note : n));
		}
		return note;
	} catch (error) {
		debug.error('notes', 'Failed to update note:', error);
		throw error;
	}
}

export async function deleteNote(id: string): Promise<void> {
	await ws.http('notes:delete', { id });
	notesState.notes = notesState.notes.filter((n) => n.id !== id);
	if (notesState.currentNoteId === id) notesState.currentNoteId = null;
}

export function selectNote(id: string | null): void {
	notesState.currentNoteId = id;
}

export function clearNotes(): void {
	notesState.notes = [];
	notesState.currentNoteId = null;
	notesState.isLoading = false;
	notesState.error = null;
}

export function getAuthToken(): string {
	// Canonical session token lives in the auth store (localStorage key:
	// 'clopen-session-token'). Never use another key — an empty token makes
	// every image upload/download fail with 401.
	const fromStore = authStore.sessionToken;
	if (fromStore) return fromStore;
	try {
		return localStorage.getItem('clopen-session-token') ?? '';
	} catch {
		return '';
	}
}

export function getNoteImageUrl(imageId: string): string {
	const token = getAuthToken();
	const base = `/api/notes/images/${imageId}`;
	if (!token) return base;
	return `${base}?token=${encodeURIComponent(token)}`;
}

export async function uploadNoteImage(noteId: string, file: File): Promise<{ image: NoteImage; url: string }> {
	const token = getAuthToken();
	const url = new URL('/api/notes/images/upload', window.location.origin);
	url.searchParams.set('noteId', noteId);
	url.searchParams.set('fileName', file.name);
	url.searchParams.set('fileSize', String(file.size));

	const res = await fetch(url.toString(), {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`
		},
		body: file
	});
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(text || `Upload failed: ${res.status}`);
	}
	const data = (await res.json()) as { image: NoteImage; url: string };
	// Update local note images array
	notesState.notes = notesState.notes.map((n) =>
		n.id === noteId ? { ...n, images: [...n.images, data.image] } : n
	);
	return data;
}

export async function deleteNoteImage(imageId: string, noteId: string): Promise<void> {
	await ws.http('notes:delete-image', { imageId });
	notesState.notes = notesState.notes.map((n) =>
		n.id === noteId ? { ...n, images: n.images.filter((img) => img.id !== imageId) } : n
	);
}

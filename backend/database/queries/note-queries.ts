import { getDatabase } from '../index';
import type { Note, NoteImage, NoteWithImages } from '$shared/types/database/schema';

const MAX_CONTENT_LENGTH = 200_000;

function nowIso(): string {
	return new Date().toISOString();
}

export const noteQueries = {
	listByProject(projectId: string, folderPath?: string | null): NoteWithImages[] {
		const db = getDatabase();
		let notes: Note[];
		if (folderPath !== undefined && folderPath !== null) {
			notes = db
				.prepare('SELECT * FROM notes WHERE project_id = ? AND folder_path = ? ORDER BY updated_at DESC')
				.all(projectId, folderPath) as Note[];
		} else {
			notes = db
				.prepare('SELECT * FROM notes WHERE project_id = ? ORDER BY updated_at DESC')
				.all(projectId) as Note[];
		}
		return notes.map((n) => ({
			...n,
			images: noteImageQueries.listByNote(n.id)
		}));
	},

	getById(id: string): NoteWithImages | null {
		const db = getDatabase();
		const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | null;
		if (!note) return null;
		return { ...note, images: noteImageQueries.listByNote(id) };
	},

	getRawById(id: string): Note | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | null;
	},

	create(params: {
		projectId: string;
		folderPath?: string | null;
		title?: string | null;
		content: string;
		createdBy?: string | null;
	}): Note {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = nowIso();
		const title = params.title?.trim() || null;
		const content = params.content.slice(0, MAX_CONTENT_LENGTH);
		db.prepare(
			`INSERT INTO notes (id, project_id, folder_path, title, content, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(id, params.projectId, params.folderPath ?? null, title, content, params.createdBy ?? null, now, now);
		return {
			id,
			project_id: params.projectId,
			folder_path: params.folderPath ?? null,
			title,
			content,
			created_by: params.createdBy ?? null,
			created_at: now,
			updated_at: now
		};
	},

	update(
		id: string,
		patch: { title?: string | null; content?: string; folderPath?: string | null }
	): Note | null {
		const db = getDatabase();
		const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | null;
		if (!existing) return null;
		const now = nowIso();
		const title = patch.title !== undefined ? patch.title?.trim() || null : existing.title;
		const content = patch.content !== undefined ? patch.content.slice(0, MAX_CONTENT_LENGTH) : existing.content;
		const folderPath = patch.folderPath !== undefined ? patch.folderPath : existing.folder_path;
		db.prepare('UPDATE notes SET title = ?, content = ?, folder_path = ?, updated_at = ? WHERE id = ?').run(
			title,
			content,
			folderPath,
			now,
			id
		);
		return { ...existing, title, content, folder_path: folderPath as string | null, updated_at: now };
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM notes WHERE id = ?').run(id);
	},

	deleteByProject(projectId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM notes WHERE project_id = ?').run(projectId);
	}
};

export const noteImageQueries = {
	listByNote(noteId: string): NoteImage[] {
		const db = getDatabase();
		return db.prepare('SELECT * FROM note_images WHERE note_id = ? ORDER BY created_at ASC').all(noteId) as NoteImage[];
	},

	getById(id: string): NoteImage | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM note_images WHERE id = ?').get(id) as NoteImage | null;
	},

	create(params: { noteId: string; fileName: string; mimeType: string; size: number; storagePath: string }): NoteImage {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = nowIso();
		db.prepare(
			`INSERT INTO note_images (id, note_id, file_name, mime_type, size, storage_path, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(id, params.noteId, params.fileName, params.mimeType, params.size, params.storagePath, now);
		return {
			id,
			note_id: params.noteId,
			file_name: params.fileName,
			mime_type: params.mimeType,
			size: params.size,
			storage_path: params.storagePath,
			created_at: now
		};
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM note_images WHERE id = ?').run(id);
	},

	deleteByNote(noteId: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM note_images WHERE note_id = ?').run(noteId);
	}
};

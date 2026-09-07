import { getDatabase } from '../index';
import type {
	Note,
	NoteCollection,
	NoteImage,
	NoteScope,
	NoteWithImages
} from '$shared/types/database/schema';

const MAX_CONTENT_LENGTH = 200_000;
const MAX_NAME_LENGTH = 120;

/** Name given to the collection created on demand for a scope that has none. */
export const DEFAULT_COLLECTION_NAME = 'General';

function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Attach each note's images in one round trip.
 *
 * Querying per note turns a collection list into 1 + N statements, which is what
 * a project with a few dozen notes pays on every panel open and every switch.
 */
function attachImages(notes: Note[]): NoteWithImages[] {
	if (notes.length === 0) return [];
	const db = getDatabase();
	const placeholders = notes.map(() => '?').join(', ');
	const rows = db
		.prepare(
			`SELECT * FROM note_images WHERE note_id IN (${placeholders}) ORDER BY created_at ASC`
		)
		.all(...notes.map((n) => n.id)) as NoteImage[];
	const byNote = new Map<string, NoteImage[]>();
	for (const row of rows) {
		const bucket = byNote.get(row.note_id);
		if (bucket) bucket.push(row);
		else byNote.set(row.note_id, [row]);
	}
	return notes.map((note) => ({ ...note, images: byNote.get(note.id) ?? [] }));
}

export const noteCollectionQueries = {
	/**
	 * Every collection in a scope.
	 *
	 * `projectId` is required for the `project` scope and ignored for `global`,
	 * matching the CHECK constraint on the table.
	 */
	listByScope(scope: NoteScope, projectId?: string | null): NoteCollection[] {
		const db = getDatabase();
		if (scope === 'global') {
			return db
				.prepare("SELECT * FROM note_collections WHERE scope = 'global' ORDER BY name COLLATE NOCASE ASC")
				.all() as NoteCollection[];
		}
		if (!projectId) return [];
		return db
			.prepare(
				"SELECT * FROM note_collections WHERE scope = 'project' AND project_id = ? ORDER BY name COLLATE NOCASE ASC"
			)
			.all(projectId) as NoteCollection[];
	},

	getById(id: string): NoteCollection | null {
		const db = getDatabase();
		return db.prepare('SELECT * FROM note_collections WHERE id = ?').get(id) as NoteCollection | null;
	},

	/** The collection a note lives in — the note's only source of permissions. */
	getForNote(noteId: string): NoteCollection | null {
		const db = getDatabase();
		return db
			.prepare(
				`SELECT c.* FROM note_collections c
				 JOIN notes n ON n.collection_id = c.id
				 WHERE n.id = ?`
			)
			.get(noteId) as NoteCollection | null;
	},

	create(params: {
		name: string;
		scope: NoteScope;
		projectId?: string | null;
		createdBy?: string | null;
	}): NoteCollection {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = nowIso();
		const name = params.name.trim().slice(0, MAX_NAME_LENGTH) || DEFAULT_COLLECTION_NAME;
		// The table's CHECK rejects the mismatched pair; normalising here keeps a
		// stray projectId on a global collection from becoming a constraint error.
		const projectId = params.scope === 'project' ? (params.projectId ?? null) : null;
		db.prepare(
			`INSERT INTO note_collections (id, name, scope, project_id, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(id, name, params.scope, projectId, params.createdBy ?? null, now, now);
		return {
			id,
			name,
			scope: params.scope,
			project_id: projectId,
			created_by: params.createdBy ?? null,
			created_at: now,
			updated_at: now
		};
	},

	/**
	 * The collection a new note should land in when the caller named none.
	 *
	 * Created on first use rather than seeded up front: a scope nobody has taken
	 * a note in should not carry an empty collection, and there is no migration
	 * that could have seeded one for a project created later.
	 */
	ensureDefault(scope: NoteScope, projectId: string | null, createdBy: string | null): NoteCollection {
		const existing = noteCollectionQueries.listByScope(scope, projectId);
		if (existing.length > 0) return existing[0];
		return noteCollectionQueries.create({
			name: DEFAULT_COLLECTION_NAME,
			scope,
			projectId,
			createdBy
		});
	},

	rename(id: string, name: string): NoteCollection | null {
		const db = getDatabase();
		const existing = noteCollectionQueries.getById(id);
		if (!existing) return null;
		const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
		if (!trimmed) return existing;
		const now = nowIso();
		db.prepare('UPDATE note_collections SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, now, id);
		return { ...existing, name: trimmed, updated_at: now };
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM note_collections WHERE id = ?').run(id);
	},

	/** Collection ids belonging to a project, for cleaning their files off disk. */
	idsByProject(projectId: string): string[] {
		const db = getDatabase();
		const rows = db
			.prepare("SELECT id FROM note_collections WHERE scope = 'project' AND project_id = ?")
			.all(projectId) as { id: string }[];
		return rows.map((r) => r.id);
	}
};

export const noteQueries = {
	listByCollection(collectionId: string): NoteWithImages[] {
		const db = getDatabase();
		const notes = db
			.prepare('SELECT * FROM notes WHERE collection_id = ? ORDER BY updated_at DESC')
			.all(collectionId) as Note[];
		return attachImages(notes);
	},

	/** Every note across a set of collections, grouped by the caller. */
	listByCollections(collectionIds: string[]): NoteWithImages[] {
		if (collectionIds.length === 0) return [];
		const db = getDatabase();
		const placeholders = collectionIds.map(() => '?').join(', ');
		const notes = db
			.prepare(`SELECT * FROM notes WHERE collection_id IN (${placeholders}) ORDER BY updated_at DESC`)
			.all(...collectionIds) as Note[];
		return attachImages(notes);
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

	create(params: { collectionId: string; title?: string | null; content?: string; createdBy?: string | null }): Note {
		const db = getDatabase();
		const id = crypto.randomUUID();
		const now = nowIso();
		const title = params.title?.trim() || null;
		const content = (params.content ?? '').slice(0, MAX_CONTENT_LENGTH);
		db.prepare(
			`INSERT INTO notes (id, collection_id, title, content, created_by, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(id, params.collectionId, title, content, params.createdBy ?? null, now, now);
		return {
			id,
			collection_id: params.collectionId,
			title,
			content,
			created_by: params.createdBy ?? null,
			created_at: now,
			updated_at: now
		};
	},

	update(
		id: string,
		patch: { title?: string | null; content?: string; collectionId?: string }
	): Note | null {
		const db = getDatabase();
		const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as Note | null;
		if (!existing) return null;
		const now = nowIso();
		const title = patch.title !== undefined ? patch.title?.trim() || null : existing.title;
		const content = patch.content !== undefined ? patch.content.slice(0, MAX_CONTENT_LENGTH) : existing.content;
		const collectionId = patch.collectionId ?? existing.collection_id;
		db.prepare('UPDATE notes SET title = ?, content = ?, collection_id = ?, updated_at = ? WHERE id = ?').run(
			title,
			content,
			collectionId,
			now,
			id
		);
		return { ...existing, title, content, collection_id: collectionId, updated_at: now };
	},

	delete(id: string): void {
		const db = getDatabase();
		db.prepare('DELETE FROM notes WHERE id = ?').run(id);
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
	}
};

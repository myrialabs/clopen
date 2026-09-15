/**
 * Notes Router
 *
 * Notes live in collections, and a collection carries the scope: `project`
 * (members of that project) or `global` (every signed-in user). Permissions are
 * resolved through the collection on every route — a note id is never treated
 * as a capability on its own.
 *
 * Writes broadcast `notes:changed` to whoever can see the collection, the same
 * way worktrees do: a note another member just created is invisible until the
 * next reload without it. The event carries ids only — a note holds up to
 * 200 KB, so fanning the list out on every autosave would put megabytes on the
 * socket per keystroke of a long note.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSConnection } from '$shared/utils/ws-server';
import type { NoteCollection } from '$shared/types/database/schema';
import { ws as wsServer } from '../../utils/ws';
import { requireProjectAccess } from '../access';
import {
	noteQueries,
	noteCollectionQueries,
	noteImageQueries
} from '../../database/queries/note-queries';
import { canAccessCollection } from '../../notes/access';
import { removeCollectionFiles, removeNoteFiles, resolveNoteImagePath } from '../../notes/storage';
import { unlink } from 'node:fs/promises';

const scopeSchema = t.Union([t.Literal('project'), t.Literal('global')]);

const collectionSchema = t.Object({
	id: t.String(),
	name: t.String(),
	scope: scopeSchema,
	project_id: t.Union([t.String(), t.Null()]),
	created_by: t.Union([t.String(), t.Null()]),
	created_at: t.String(),
	updated_at: t.String()
});

const noteSchema = t.Object({
	id: t.String(),
	collection_id: t.String(),
	title: t.Union([t.String(), t.Null()]),
	content: t.String(),
	created_by: t.Union([t.String(), t.Null()]),
	created_at: t.String(),
	updated_at: t.String(),
	images: t.Array(
		t.Object({
			id: t.String(),
			note_id: t.String(),
			file_name: t.String(),
			mime_type: t.String(),
			size: t.Number(),
			storage_path: t.String(),
			created_at: t.String()
		})
	)
});

/** Resolve a collection and refuse the call unless this connection may see it. */
function requireCollection(conn: WSConnection, collectionId: string): NoteCollection {
	const collection = noteCollectionQueries.getById(collectionId);
	// Same answer for "does not exist" and "not yours", so the id space cannot be
	// probed for which collections are real.
	if (!collection) throw new Error('Access denied');
	if (!canAccessCollection(wsServer.getUserId(conn), collection)) {
		throw new Error('Access denied');
	}
	return collection;
}

/** Resolve the collection a note belongs to, subject to the same check. */
function requireNoteCollection(conn: WSConnection, noteId: string): NoteCollection {
	const collection = noteCollectionQueries.getForNote(noteId);
	if (!collection) throw new Error('Access denied');
	if (!canAccessCollection(wsServer.getUserId(conn), collection)) {
		throw new Error('Access denied');
	}
	return collection;
}

/** Check the caller may write into `scope` before anything is created there. */
function requireScope(conn: WSConnection, scope: 'project' | 'global', projectId: string | null): void {
	if (scope === 'project') {
		if (!projectId) throw new Error('projectId is required for the project scope');
		requireProjectAccess(conn, projectId);
		return;
	}
	// Global is instance-wide; the only requirement is a signed-in connection,
	// which getUserId asserts.
	wsServer.getUserId(conn);
}

/**
 * Tell everyone who can see this collection that its contents moved.
 *
 * A project collection reaches the project room; a global one reaches every
 * connection, because that is exactly the set of people allowed to read it.
 */
function broadcast(collection: NoteCollection): void {
	const payload = {
		collectionId: collection.id,
		scope: collection.scope,
		projectId: collection.project_id
	};
	if (collection.scope === 'project' && collection.project_id) {
		wsServer.emit.project(collection.project_id, 'notes:changed', payload);
	} else {
		wsServer.emit.global('notes:changed', payload);
	}
}

export const notesRouter = createRouter()
	// ---- Collections ----

	.http('notes:list', {
		data: t.Object({
			scope: scopeSchema,
			projectId: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: t.Object({
			collections: t.Array(collectionSchema),
			notes: t.Array(noteSchema)
		})
	}, async ({ data, conn }) => {
		const projectId = data.projectId ?? null;
		requireScope(conn, data.scope, projectId);
		const collections = noteCollectionQueries.listByScope(data.scope, projectId);
		return {
			collections,
			notes: noteQueries.listByCollections(collections.map((c) => c.id))
		};
	})

	.http('notes:create-collection', {
		data: t.Object({
			name: t.String({ minLength: 1 }),
			scope: scopeSchema,
			projectId: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: t.Object({ collection: collectionSchema })
	}, async ({ data, conn }) => {
		const projectId = data.scope === 'project' ? (data.projectId ?? null) : null;
		requireScope(conn, data.scope, projectId);
		const collection = noteCollectionQueries.create({
			name: data.name,
			scope: data.scope,
			projectId,
			createdBy: wsServer.getUserId(conn)
		});
		broadcast(collection);
		return { collection };
	})

	.http('notes:rename-collection', {
		data: t.Object({ id: t.String({ minLength: 1 }), name: t.String({ minLength: 1 }) }),
		response: t.Object({ collection: t.Union([collectionSchema, t.Null()]) })
	}, async ({ data, conn }) => {
		const collection = requireCollection(conn, data.id);
		const renamed = noteCollectionQueries.rename(collection.id, data.name);
		if (renamed) broadcast(renamed);
		return { collection: renamed };
	})

	.http('notes:delete-collection', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const collection = requireCollection(conn, data.id);
		// Notes and image rows cascade with the collection; the files they point
		// at do not, so the whole collection directory goes with them.
		noteCollectionQueries.delete(collection.id);
		await removeCollectionFiles(collection.id);
		broadcast(collection);
		return { ok: true };
	})

	// ---- Notes ----

	.http('notes:get', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ note: t.Union([noteSchema, t.Null()]) })
	}, async ({ data, conn }) => {
		requireNoteCollection(conn, data.id);
		return { note: noteQueries.getById(data.id) };
	})

	.http('notes:create', {
		data: t.Object({
			// Either an explicit collection, or a scope whose default collection is
			// created on first use.
			collectionId: t.Optional(t.String()),
			scope: t.Optional(scopeSchema),
			projectId: t.Optional(t.Union([t.String(), t.Null()])),
			title: t.Optional(t.Union([t.String(), t.Null()])),
			content: t.Optional(t.String())
		}),
		response: t.Object({ note: noteSchema })
	}, async ({ data, conn }) => {
		const userId = wsServer.getUserId(conn);
		let collection: NoteCollection;
		if (data.collectionId) {
			collection = requireCollection(conn, data.collectionId);
		} else {
			const scope = data.scope ?? 'project';
			const projectId = scope === 'project' ? (data.projectId ?? null) : null;
			requireScope(conn, scope, projectId);
			collection = noteCollectionQueries.ensureDefault(scope, projectId, userId);
		}
		const note = noteQueries.create({
			collectionId: collection.id,
			title: data.title ?? null,
			content: data.content ?? '',
			createdBy: userId
		});
		broadcast(collection);
		return { note: { ...note, images: [] } };
	})

	.http('notes:update', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			title: t.Optional(t.Union([t.String(), t.Null()])),
			content: t.Optional(t.String()),
			collectionId: t.Optional(t.String())
		}),
		response: t.Object({ note: t.Union([noteSchema, t.Null()]) })
	}, async ({ data, conn }) => {
		const from = requireNoteCollection(conn, data.id);
		// Moving a note is only allowed between collections the caller can already
		// see, otherwise a move would be a way to read or plant one they cannot.
		const to = data.collectionId ? requireCollection(conn, data.collectionId) : from;
		const updated = noteQueries.update(data.id, {
			title: data.title,
			content: data.content,
			collectionId: data.collectionId
		});
		if (!updated) return { note: null };
		broadcast(from);
		if (to.id !== from.id) broadcast(to);
		return { note: noteQueries.getById(data.id) };
	})

	.http('notes:delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const collection = requireNoteCollection(conn, data.id);
		noteQueries.delete(data.id);
		await removeNoteFiles(collection.id, data.id);
		broadcast(collection);
		return { ok: true };
	})

	.http('notes:delete-image', {
		data: t.Object({ imageId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const img = noteImageQueries.getById(data.imageId);
		if (!img) return { ok: true };
		const collection = requireNoteCollection(conn, img.note_id);
		const absolute = resolveNoteImagePath(img.storage_path);
		if (absolute) await unlink(absolute).catch(() => {});
		noteImageQueries.delete(data.imageId);
		broadcast(collection);
		return { ok: true };
	})

	// Collaborative broadcast events (Server → Client)
	.emit('notes:changed', t.Object({
		collectionId: t.String(),
		scope: scopeSchema,
		projectId: t.Union([t.String(), t.Null()])
	}));

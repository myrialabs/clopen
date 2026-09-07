/**
 * Notes Router
 *
 * Project-scoped markdown notes with image attachments.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws as wsServer } from '../../utils/ws';
import { requireProjectAccess } from '../access';
import { noteQueries, noteImageQueries } from '../../database/queries/note-queries';
import { unlink } from 'node:fs/promises';

export const notesRouter = createRouter()
	.http('notes:list', {
		data: t.Object({
			projectId: t.String(),
			folderPath: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: t.Object({
			notes: t.Array(t.Any())
		})
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const notes = noteQueries.listByProject(data.projectId, data.folderPath ?? null);
		// If folderPath param is undefined (not sent), list all for project
		if (data.folderPath === undefined) {
			const all = noteQueries.listByProject(data.projectId);
			return { notes: all as unknown[] };
		}
		return { notes: notes as unknown[] };
	})

	.http('notes:get', {
		data: t.Object({ id: t.String() }),
		response: t.Object({ note: t.Union([t.Any(), t.Null()]) })
	}, async ({ data, conn }) => {
		const raw = noteQueries.getRawById(data.id);
		if (!raw) return { note: null };
		requireProjectAccess(conn, raw.project_id);
		const note = noteQueries.getById(data.id);
		return { note: note as unknown };
	})

	.http('notes:create', {
		data: t.Object({
			projectId: t.String(),
			folderPath: t.Optional(t.Union([t.String(), t.Null()])),
			title: t.Optional(t.Union([t.String(), t.Null()])),
			content: t.String()
		}),
		response: t.Object({ note: t.Any() })
	}, async ({ data, conn }) => {
		requireProjectAccess(conn, data.projectId);
		const userId = wsServer.getUserId(conn);
		const content = data.content.slice(0, 200_000);
		if (!content.trim() && !data.title?.trim()) {
			throw new Error('Content or title is required');
		}
		const note = noteQueries.create({
			projectId: data.projectId,
			folderPath: data.folderPath ?? null,
			title: data.title ?? null,
			content,
			createdBy: userId
		});
		const full = noteQueries.getById(note.id);
		return { note: full as unknown };
	})

	.http('notes:update', {
		data: t.Object({
			id: t.String(),
			title: t.Optional(t.Union([t.String(), t.Null()])),
			content: t.Optional(t.String()),
			folderPath: t.Optional(t.Union([t.String(), t.Null()]))
		}),
		response: t.Object({ note: t.Union([t.Any(), t.Null()]) })
	}, async ({ data, conn }) => {
		const raw = noteQueries.getRawById(data.id);
		if (!raw) return { note: null };
		requireProjectAccess(conn, raw.project_id);
		const updated = noteQueries.update(data.id, {
			title: data.title,
			content: data.content,
			folderPath: data.folderPath
		});
		if (!updated) return { note: null };
		const full = noteQueries.getById(data.id);
		return { note: full as unknown };
	})

	.http('notes:delete', {
		data: t.Object({ id: t.String() }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const raw = noteQueries.getRawById(data.id);
		if (!raw) return { ok: true };
		requireProjectAccess(conn, raw.project_id);
		// Delete image files best-effort
		const images = noteImageQueries.listByNote(data.id);
		for (const img of images) {
			try { await unlink(img.storage_path); } catch { /* ignore */ }
		}
		noteQueries.delete(data.id);
		return { ok: true };
	})

	.http('notes:delete-image', {
		data: t.Object({ imageId: t.String() }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const img = noteImageQueries.getById(data.imageId);
		if (!img) return { ok: true };
		const note = noteQueries.getRawById(img.note_id);
		if (!note) {
			noteImageQueries.delete(data.imageId);
			return { ok: true };
		}
		requireProjectAccess(conn, note.project_id);
		try { await unlink(img.storage_path); } catch { /* ignore */ }
		noteImageQueries.delete(data.imageId);
		return { ok: true };
	});

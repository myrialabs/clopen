/**
 * Snapshot Content Handler
 *
 * Reads a file's content as it was *before* a given checkpoint's turn ran.
 *
 * The editor's AI gutter records `oldContent` per tool call, but the Write tool
 * carries no "before" text — its input is the whole new file. Snapshots do carry
 * it: each checkpoint stores `session_changes[path] = { oldHash, newHash }`, and
 * `oldHash` is the blob of the file as it stood when the turn started. That is
 * what lets the AI gutter diff a Write against something meaningful (and offer
 * Discard on it) instead of painting the entire file as newly added.
 *
 * Granularity is per-turn, not per-tool: if the same file was touched more than
 * once in the turn, the caller replays its own recorded edits on top of this
 * content to reach the state immediately before a specific Write.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { isAbsolute, relative } from 'path';
import { sessionQueries, projectQueries, snapshotQueries } from '../../database/queries';
import { blobStore } from '../../snapshot/blob-store';
import { debug } from '$shared/utils/logger';
import type { SessionScopedChanges } from '$shared/types/database/schema';
import { requireMessageAccess } from '../access';

/** Reject blobs that aren't text — the caller only ever diffs source files. */
function isBinaryBuffer(buf: Buffer): boolean {
	const limit = Math.min(buf.length, 8000);
	for (let i = 0; i < limit; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

export const contentHandler = createRouter()
	.http('snapshot:read-file-before-checkpoint', {
		data: t.Object({
			/** Checkpoint message id — the user message that opened the turn. */
			messageId: t.String(),
			filePath: t.String()
		}),
		response: t.Object({
			/** File text before the turn, '' when the turn created it, null when unknown. */
			content: t.Union([t.String(), t.Null()]),
			/** True when the file existed before the turn. */
			existed: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const message = requireMessageAccess(conn, data.messageId);

		const session = sessionQueries.getById(message.session_id);
		const project = session ? projectQueries.getById(session.project_id) : null;
		if (!project) return { content: null, existed: false };

		const relativePath = (
			isAbsolute(data.filePath) ? relative(project.path, data.filePath) : data.filePath
		).replace(/\\/g, '/');

		const snapshot = snapshotQueries.getByMessageId(data.messageId);
		if (!snapshot?.session_changes) return { content: null, existed: false };

		let changes: SessionScopedChanges;
		try {
			changes = JSON.parse(snapshot.session_changes as string) as SessionScopedChanges;
		} catch {
			return { content: null, existed: false };
		}

		const change = changes[relativePath];
		// No entry means the turn left the file untouched by the time the snapshot
		// was captured — we have nothing better to offer than "unknown".
		if (!change) return { content: null, existed: false };
		// Empty oldHash means the file did not exist before the turn.
		if (!change.oldHash) return { content: '', existed: false };

		try {
			const buf = await blobStore.readBlob(change.oldHash);
			if (isBinaryBuffer(buf)) return { content: null, existed: true };
			return { content: buf.toString('utf8'), existed: true };
		} catch (err) {
			debug.warn('snapshot', `Pre-checkpoint blob unavailable for ${relativePath}:`, err);
			return { content: null, existed: true };
		}
	});

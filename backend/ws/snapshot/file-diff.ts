/**
 * Snapshot File Diff Handler
 *
 * Returns old (checkpoint) and new (current) file content for diff display.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { snapshotQueries, sessionQueries, projectQueries } from '../../database/queries';
import { requireSessionAccess } from '../access';
import { blobStore } from '../../snapshot/blob-store';
import { readFile } from 'fs/promises';
import { join } from 'path';

export const fileDiffHandler = createRouter()
	.http('snapshot:get-file-diff', {
		data: t.Object({
			messageId: t.String(),
			filepath: t.String(),
			sessionId: t.String()
		}),
		response: t.Object({
			oldContent: t.String(),
			newContent: t.String(),
			filepath: t.String()
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);

		const snapshot = snapshotQueries.getByMessageId(data.messageId);
		if (!snapshot || !snapshot.session_changes) {
			return { oldContent: '', newContent: '', filepath: data.filepath };
		}

		// Get session for project path
		const session = sessionQueries.getById(data.sessionId);
		const project = session ? projectQueries.getById(session.project_id) : null;
		const projectPath = project?.path || '';
		const currentFilePath = join(projectPath, data.filepath);

		let oldContent = '';
		let newContent = '';

		try {
			const changes = JSON.parse(snapshot.session_changes as string) as Record<string, { oldHash: string; newHash: string }>;
			const fileChange = changes[data.filepath];

			if (fileChange?.oldHash) {
				const buf = await blobStore.readBlob(fileChange.oldHash); oldContent = buf.toString('utf-8');
			}

			// Read current file from disk
			try {
				newContent = await readFile(currentFilePath, 'utf-8');
			} catch {
				// File might not exist anymore
				newContent = '';
			}
		} catch {
			// Ignore parse errors
		}

		return { oldContent, newContent, filepath: data.filepath };
	});

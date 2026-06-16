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
import { spawn } from 'child_process';
import { debug } from '$shared/utils/logger';

async function readFromGitHead(projectPath: string, filepath: string): Promise<string> {
	return new Promise(resolve => {
		const child = spawn('git', ['show', `HEAD:${filepath}`], { cwd: projectPath, stdio: ['ignore', 'pipe', 'ignore'] });
		const chunks: Buffer[] = [];
		child.stdout.on('data', c => chunks.push(c));
		child.on('error', () => resolve(''));
		child.on('close', code => {
			if (code !== 0) return resolve('');
			resolve(Buffer.concat(chunks).toString('utf-8'));
		});
	});
}

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
				// Try the blob store first — this is the normal path.
				const buf = await blobStore.readBlob(fileChange.oldHash);
				if (buf && buf.length > 0) {
					oldContent = buf.toString('utf-8');
				} else {
					// Blob missing (e.g. after a backend restart that wiped the
					// in-memory cache, or for sessions initialised before blob
					// persistence shipped). Fall back to `git show HEAD:file`
					// so the diff still has a real "before" to render against.
					oldContent = await readFromGitHead(projectPath, data.filepath);
					debug.log('snapshot', `Blob ${fileChange.oldHash.slice(0, 8)} missing for ${data.filepath}, fell back to git HEAD`);
				}
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

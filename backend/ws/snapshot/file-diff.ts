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
import { findRepoForFile } from '../../snapshot/gitignore';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { spawn } from 'child_process';
import { debug } from '$shared/utils/logger';

async function readFromGitHead(cwd: string, filepath: string): Promise<string> {
	return new Promise(resolve => {
		const child = spawn('git', ['show', `HEAD:${filepath}`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
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

		// Accumulate session_changes across every snapshot for the session.
		// `oldHash` is taken from the first snapshot that touched the file
		// (pre-AI state) and `newHash` from the latest — same logic as
		// `snapshot:get-changes` so the diff renders the full accumulated
		// change from original → current. A `seen` set guards the first-old
		// assignment so a new-file oldHash of '' doesn't get overwritten by
		// the next snapshot's entry.
		const snapshots = snapshotQueries.getBySessionId(data.sessionId);

		const seen = new Set<string>();
		let firstOld = '';
		let lastNew = '';
		for (const snap of snapshots) {
			if (!snap.session_changes) continue;
			try {
				const changes = JSON.parse(snap.session_changes as string) as Record<string, { oldHash: string; newHash: string }>;
				const entry = changes[data.filepath];
				if (!entry) continue;
				if (!seen.has(data.filepath)) {
					firstOld = entry.oldHash || '';
					seen.add(data.filepath);
				}
				lastNew = entry.newHash || '';
			} catch {
				// Skip corrupt snapshots
			}
		}

		if (!lastNew) {
			return { oldContent: '', newContent: '', filepath: data.filepath };
		}

		// Get session for project path
		const session = sessionQueries.getById(data.sessionId);
		const project = session ? projectQueries.getById(session.project_id) : null;
		const projectPath = project?.path || '';
		const currentFilePath = join(projectPath, data.filepath);

		let oldContent = '';
		let newContent = '';

		if (firstOld) {
			// Try the blob store first — this is the normal path.
			const buf = await blobStore.readBlob(firstOld);
			if (buf && buf.length > 0) {
				oldContent = buf.toString('utf-8');
			} else {
				// Blob missing (e.g. after a backend restart that wiped the
				// in-memory cache, or for sessions initialised before blob
				// persistence shipped). Fall back to `git show HEAD:file`
				// in the correct repo (nested repos have their own HEAD) so
				// the diff still has a real "before" to render against.
				const repo = projectPath
					? await findRepoForFile(projectPath, data.filepath)
					: null;
				const gitCwd = repo?.repoPath ?? projectPath;
				const gitFile = repo?.relativeFilePath ?? data.filepath;
				oldContent = await readFromGitHead(gitCwd, gitFile);
				debug.log('snapshot', `Blob ${firstOld.slice(0, 8)} missing for ${data.filepath}, fell back to git HEAD`);
			}
		}

		if (lastNew) {
			// Read the "new" content from the blob store, NOT from disk.
			// The banner diff is the AI's cumulative pending change (from
			// session-start to last AI action) and must stay stable until
			// the user accepts or discards. If we read from disk, any
			// manual edit the user makes after the AI's last action would
			// leak into the banner diff — but the banner is supposed to
			// show only what the AI changed. The blob is the AI's frozen
			// output at snapshot time, so it's the correct source.
			const buf = await blobStore.readBlob(lastNew);
			if (buf && buf.length > 0) {
				newContent = buf.toString('utf-8');
			} else {
				// Blob missing — fall back to disk. Better to show
				// something (even with manual edits) than an empty diff.
				try {
					newContent = await readFile(currentFilePath, 'utf-8');
				} catch {
					newContent = '';
				}
				debug.log('snapshot', `Blob ${lastNew.slice(0, 8)} missing for ${data.filepath} (new side), fell back to disk`);
			}
		}

		return { oldContent, newContent, filepath: data.filepath };
	});

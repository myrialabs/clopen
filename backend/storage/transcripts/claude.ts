/**
 * Claude Code transcripts: `{CLAUDE_CONFIG_DIR}/projects/<encoded cwd>/<id>.jsonl`.
 *
 * Beside a transcript may sit `<id>/` with the session's tool results and
 * subagent transcripts. Every later fork of the conversation keeps pointing at
 * those files by path, so a side folder outlives its own transcript and goes
 * only when no transcript left in the project folder mentions the id.
 *
 * `memory/` and anything else that is not a session id is the engine's own
 * per-project state and is never listed.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { measurePath, removePath } from '../fs-size';
import { findReferencedIds } from './references';
import { UUID_PATTERN, type TranscriptEntry, type TranscriptRemoval, type TranscriptStore } from './types';

export function claudeProjectsRoot(): string {
	return join(getEngineUserConfigDir('claude'), 'projects');
}

async function listDir(dir: string): Promise<import('node:fs').Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** Transcript files currently in a project folder. */
async function transcriptFiles(projectDir: string): Promise<string[]> {
	return (await listDir(projectDir))
		.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
		.map(entry => join(projectDir, entry.name));
}

export const claudeTranscripts: TranscriptStore = {
	engine: 'claude-code',

	roots: () => [claudeProjectsRoot()],

	async list(signal) {
		const root = claudeProjectsRoot();
		const entries: TranscriptEntry[] = [];
		for (const project of await listDir(root)) {
			if (signal?.aborted) break;
			if (!project.isDirectory()) continue;
			const projectDir = join(root, project.name);
			const children = await listDir(projectDir);
			const transcriptIds = new Set(
				children.filter(c => c.isFile() && c.name.endsWith('.jsonl')).map(c => c.name.slice(0, -6))
			);

			for (const child of children) {
				if (child.isFile() && child.name.endsWith('.jsonl')) {
					const id = child.name.slice(0, -6);
					if (!UUID_PATTERN.test(id)) continue;
					const file = join(projectDir, child.name);
					const stat = await fs.stat(file).catch(() => null);
					if (!stat) continue;
					const sidecarPath = join(projectDir, id);
					const sidecar = children.some(c => c.isDirectory() && c.name === id)
						? { path: sidecarPath, bytes: (await measurePath(sidecarPath)).bytes }
						: null;
					entries.push({
						engine: 'claude-code',
						id,
						paths: [file],
						bytes: stat.size,
						mtimeMs: stat.mtimeMs,
						projectKey: project.name,
						projectPath: null,
						sidecar
					});
				} else if (child.isDirectory() && UUID_PATTERN.test(child.name) && !transcriptIds.has(child.name)) {
					const dir = join(projectDir, child.name);
					const stat = await fs.stat(dir).catch(() => null);
					entries.push({
						engine: 'claude-code',
						id: child.name,
						paths: [dir],
						bytes: (await measurePath(dir)).bytes,
						mtimeMs: stat?.mtimeMs ?? 0,
						projectKey: project.name,
						projectPath: null,
						sidecarOnly: true
					});
				}
			}
		}
		return entries;
	},

	async exists(id) {
		const root = claudeProjectsRoot();
		for (const project of await listDir(root)) {
			if (!project.isDirectory()) continue;
			try {
				await fs.access(join(root, project.name, `${id}.jsonl`));
				return true;
			} catch { /* not in this folder */ }
		}
		return false;
	},

	async remove(entries) {
		const result: TranscriptRemoval = { freedBytes: 0, removed: 0, errors: [] };
		const byProject = new Map<string, TranscriptEntry[]>();
		for (const entry of entries) {
			if (!entry.projectKey) continue;
			let list = byProject.get(entry.projectKey);
			if (!list) byProject.set(entry.projectKey, list = []);
			list.push(entry);
		}

		for (const [projectKey, list] of byProject) {
			const projectDir = join(claudeProjectsRoot(), projectKey);
			const sidecars = new Map<string, string>();

			for (const entry of list) {
				if (entry.sidecarOnly) {
					sidecars.set(entry.id, entry.paths[0]);
					continue;
				}
				try {
					result.freedBytes += await removePath(entry.paths[0]);
					result.removed++;
					if (entry.sidecar) sidecars.set(entry.id, entry.sidecar.path);
				} catch (error) {
					result.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			if (sidecars.size === 0) continue;
			const stillReferenced = await findReferencedIds(await transcriptFiles(projectDir), sidecars.keys());
			for (const [id, dir] of sidecars) {
				if (stillReferenced.has(id)) continue;
				try {
					result.freedBytes += await removePath(dir);
					if (list.some(entry => entry.sidecarOnly && entry.id === id)) result.removed++;
				} catch (error) {
					result.errors.push(`${id}/: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			// A project folder left with nothing but engine state Claude recreates
			// on demand is removed too, so a deleted project leaves no folder behind.
			const remaining = await listDir(projectDir);
			if (remaining.length === 0) await fs.rmdir(projectDir).catch(() => {});
		}
		return result;
	}
};

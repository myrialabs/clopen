/**
 * Engines whose sessions are plain files or folders, one per session id.
 *
 * - Codex:   `{CODEX_HOME}/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, cwd in
 *            the first line's `payload.cwd`
 * - Qwen:    `{QWEN_RUNTIME_DIR}/projects/<encoded cwd>/chats/<id>.jsonl`
 * - Copilot: `{COPILOT_HOME}/session-state/<id>/`
 * - Pi:      `{pi agent dir}/sessions/<encoded cwd>/<timestamp>_<id>.jsonl`, cwd in
 *            the header line
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { measurePath, removePath } from '../fs-size';
import type { TranscriptEntry, TranscriptRemoval, TranscriptStore } from './types';
import { UUID_PATTERN } from './types';
import type { EngineType } from '$shared/types/unified';

async function listDir(dir: string): Promise<import('node:fs').Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** First line of a file, read without loading the rest. */
async function readFirstLine(file: string, limit = 65_536): Promise<string | null> {
	try {
		const handle = await fs.open(file, 'r');
		try {
			const buffer = Buffer.alloc(limit);
			const { bytesRead } = await handle.read(buffer, 0, limit, 0);
			const text = buffer.subarray(0, bytesRead).toString('utf8');
			const newline = text.indexOf('\n');
			return newline === -1 ? text : text.slice(0, newline);
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

function cwdFromHeader(line: string | null): string | null {
	if (!line) return null;
	try {
		const parsed = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
		const cwd = parsed.payload?.cwd ?? parsed.cwd;
		return typeof cwd === 'string' ? cwd : null;
	} catch {
		return null;
	}
}

async function removeEntries(entries: TranscriptEntry[]): Promise<TranscriptRemoval> {
	const result: TranscriptRemoval = { freedBytes: 0, removed: 0, errors: [] };
	for (const entry of entries) {
		try {
			for (const target of entry.paths) result.freedBytes += await removePath(target);
			result.removed++;
		} catch (error) {
			result.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return result;
}

async function fileEntry(
	engine: EngineType,
	id: string,
	file: string,
	projectKey: string | null,
	projectPath: string | null
): Promise<TranscriptEntry | null> {
	const stat = await fs.stat(file).catch(() => null);
	if (!stat) return null;
	return {
		engine,
		id,
		paths: [file],
		bytes: stat.isDirectory() ? (await measurePath(file)).bytes : stat.size,
		mtimeMs: stat.mtimeMs,
		projectKey,
		projectPath
	};
}

// ── Codex ────────────────────────────────────────────────────────────────────

const codexRoot = () => join(getEngineUserConfigDir('codex'), 'sessions');
const CODEX_ROLLOUT = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

async function codexFiles(signal?: AbortSignal): Promise<{ id: string; file: string }[]> {
	const files: { id: string; file: string }[] = [];
	const stack = [codexRoot()];
	while (stack.length > 0) {
		if (signal?.aborted) break;
		const dir = stack.pop()!;
		for (const entry of await listDir(dir)) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else {
				const match = CODEX_ROLLOUT.exec(entry.name);
				if (match) files.push({ id: match[1], file: full });
			}
		}
	}
	return files;
}

export const codexTranscripts: TranscriptStore = {
	engine: 'codex',
	roots: () => [codexRoot()],
	async list(signal) {
		const entries: TranscriptEntry[] = [];
		for (const { id, file } of await codexFiles(signal)) {
			const entry = await fileEntry('codex', id, file, null, cwdFromHeader(await readFirstLine(file)));
			if (entry) entries.push(entry);
		}
		return entries;
	},
	async exists(id) {
		return (await codexFiles()).some(file => file.id === id);
	},
	remove: removeEntries
};

// ── Qwen ─────────────────────────────────────────────────────────────────────

const qwenRoot = () => join(getEngineUserConfigDir('qwen'), 'projects');

export const qwenTranscripts: TranscriptStore = {
	engine: 'qwen',
	roots: () => [qwenRoot()],
	async list(signal) {
		const entries: TranscriptEntry[] = [];
		for (const project of await listDir(qwenRoot())) {
			if (signal?.aborted) break;
			if (!project.isDirectory()) continue;
			const chats = join(qwenRoot(), project.name, 'chats');
			for (const chat of await listDir(chats)) {
				if (!chat.isFile() || !chat.name.endsWith('.jsonl')) continue;
				const entry = await fileEntry('qwen', chat.name.slice(0, -6), join(chats, chat.name), project.name, null);
				if (entry) entries.push(entry);
			}
		}
		return entries;
	},
	async exists(id) {
		for (const project of await listDir(qwenRoot())) {
			try {
				await fs.access(join(qwenRoot(), project.name, 'chats', `${id}.jsonl`));
				return true;
			} catch { /* not here */ }
		}
		return false;
	},
	remove: removeEntries
};

// ── Copilot ──────────────────────────────────────────────────────────────────

const copilotRoot = () => join(getEngineUserConfigDir('copilot'), 'session-state');

export const copilotTranscripts: TranscriptStore = {
	engine: 'copilot',
	roots: () => [copilotRoot()],
	async list(signal) {
		const entries: TranscriptEntry[] = [];
		for (const session of await listDir(copilotRoot())) {
			if (signal?.aborted) break;
			if (!session.isDirectory() || !UUID_PATTERN.test(session.name)) continue;
			const entry = await fileEntry('copilot', session.name, join(copilotRoot(), session.name), null, null);
			if (entry) entries.push(entry);
		}
		return entries;
	},
	async exists(id) {
		try {
			await fs.access(join(copilotRoot(), id));
			return true;
		} catch {
			return false;
		}
	},
	remove: removeEntries
};

// ── Pi ───────────────────────────────────────────────────────────────────────

const piRoot = () => join(getEngineUserConfigDir('pi'), 'sessions');
const PI_SESSION = /^[^_]+_(.+)\.jsonl$/;

export const piTranscripts: TranscriptStore = {
	engine: 'pi',
	roots: () => [piRoot()],
	async list(signal) {
		const entries: TranscriptEntry[] = [];
		for (const project of await listDir(piRoot())) {
			if (signal?.aborted) break;
			if (!project.isDirectory()) continue;
			const dir = join(piRoot(), project.name);
			for (const file of await listDir(dir)) {
				const match = file.isFile() ? PI_SESSION.exec(file.name) : null;
				if (!match) continue;
				const full = join(dir, file.name);
				const entry = await fileEntry('pi', match[1], full, project.name, cwdFromHeader(await readFirstLine(full)));
				if (entry) entries.push(entry);
			}
		}
		return entries;
	},
	async exists(id) {
		for (const project of await listDir(piRoot())) {
			if (!project.isDirectory()) continue;
			const files = await listDir(join(piRoot(), project.name));
			if (files.some(file => file.name.endsWith(`_${id}.jsonl`))) return true;
		}
		return false;
	},
	remove: removeEntries
};

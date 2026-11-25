/**
 * Cursor agents: one `JsonlLocalAgentStore` per project under
 * `{clopenDir}/engine/cursor/user/agents/<encoded cwd>/`, four NDJSON files
 * shared by every agent in the project.
 *
 * Sizes are apportioned per agent from the lines that belong to it (run events
 * through their run). Removal goes through the SDK's own store API so the files
 * stay in the shape the SDK expects; when every agent of a store goes, the store
 * folder goes with them and the SDK is not needed at all.
 *
 * The store API treats an EMPTY filter as "everything". Every call here passes a
 * non-empty id list and is skipped otherwise.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { getEngineUserConfigDir } from '$backend/utils/paths';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import { measurePath, removePath } from '../fs-size';
import type { TranscriptEntry, TranscriptRemoval, TranscriptStore } from './types';

const root = () => join(getEngineUserConfigDir('cursor'), 'agents');

async function readLines(file: string): Promise<string[]> {
	try {
		return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
	} catch {
		return [];
	}
}

function field(line: string, name: string): string | null {
	try {
		const value = (JSON.parse(line) as Record<string, unknown>)[name];
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

interface StoreAgents {
	dir: string;
	agents: Map<string, { bytes: number; cwd: string | null; updatedAt: number }>;
}

async function readStore(dir: string): Promise<StoreAgents> {
	const agents = new Map<string, { bytes: number; cwd: string | null; updatedAt: number }>();
	const credit = (agentId: string | null, bytes: number) => {
		if (!agentId) return;
		const agent = agents.get(agentId);
		if (agent) agent.bytes += bytes;
	};

	for (const line of await readLines(join(dir, 'agents.ndjson'))) {
		try {
			const doc = JSON.parse(line) as { agentId?: string; cwd?: string; updatedAt?: number };
			if (!doc.agentId) continue;
			agents.set(doc.agentId, { bytes: line.length, cwd: doc.cwd ?? null, updatedAt: doc.updatedAt ?? 0 });
		} catch { /* skip */ }
	}

	const runOwner = new Map<string, string>();
	for (const line of await readLines(join(dir, 'runs.ndjson'))) {
		const agentId = field(line, 'agentId');
		const runId = field(line, 'runId');
		if (agentId && runId) runOwner.set(runId, agentId);
		credit(agentId, line.length);
	}
	for (const line of await readLines(join(dir, 'run_events.ndjson'))) {
		const runId = field(line, 'runId');
		credit(runId ? runOwner.get(runId) ?? null : null, line.length);
	}
	for (const line of await readLines(join(dir, 'checkpoints.ndjson'))) {
		credit(field(line, 'agentId'), line.length);
	}
	return { dir, agents };
}

async function storeDirs(): Promise<string[]> {
	try {
		return (await fs.readdir(root(), { withFileTypes: true }))
			.filter(entry => entry.isDirectory())
			.map(entry => join(root(), entry.name));
	} catch {
		return [];
	}
}

export const cursorTranscripts: TranscriptStore = {
	engine: 'cursor',
	roots: () => [root()],

	async list(signal) {
		const entries: TranscriptEntry[] = [];
		for (const dir of await storeDirs()) {
			if (signal?.aborted) break;
			const { agents } = await readStore(dir);
			const projectKey = dir.slice(root().length + 1);
			for (const [agentId, agent] of agents) {
				entries.push({
					engine: 'cursor',
					id: agentId,
					paths: [dir],
					bytes: agent.bytes,
					mtimeMs: agent.updatedAt,
					projectKey,
					projectPath: agent.cwd
				});
			}
		}
		return entries;
	},

	async exists(id) {
		for (const dir of await storeDirs()) {
			if ((await readStore(dir)).agents.has(id)) return true;
		}
		return false;
	},

	async remove(entries) {
		const result: TranscriptRemoval = { freedBytes: 0, removed: 0, errors: [] };
		const byStore = new Map<string, TranscriptEntry[]>();
		for (const entry of entries) {
			const dir = entry.paths[0];
			let list = byStore.get(dir);
			if (!list) byStore.set(dir, list = []);
			list.push(entry);
		}

		for (const [dir, list] of byStore) {
			const store = await readStore(dir);
			const ids = list.map(entry => entry.id).filter(id => store.agents.has(id));
			if (ids.length === 0) continue;

			if (ids.length === store.agents.size) {
				result.freedBytes += await removePath(dir);
				result.removed += ids.length;
				continue;
			}

			try {
				const before = (await measurePath(dir)).bytes;
				const { JsonlLocalAgentStore } = await loadEngineSdk<typeof import('@cursor/sdk')>('cursor', '@cursor/sdk');
				const sdkStore = new JsonlLocalAgentStore(dir);
				const runIds: string[] = [];
				let cursor: string | undefined;
				do {
					const page = await sdkStore.runs.list({ filter: { agentIds: ids, ...(cursor && { cursor }) } });
					runIds.push(...page.items.map(run => run.runId));
					cursor = page.nextCursor;
				} while (cursor);
				if (runIds.length > 0) await sdkStore.runEvents.delete({ filter: { runIds } });
				await sdkStore.runs.delete({ filter: { agentIds: ids } });
				await sdkStore.checkpoints.delete({ filter: { agentIds: ids } });
				await sdkStore.agents.delete({ filter: { agentIds: ids } });
				result.freedBytes += Math.max(0, before - (await measurePath(dir)).bytes);
				result.removed += ids.length;
			} catch (error) {
				result.errors.push(`Cursor store ${dir}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return result;
	}
};

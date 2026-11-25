/**
 * Engine transcripts through their whole life: referenced by chats, found unused,
 * deduplicated into an alias, released when their chat is deleted or slimmed.
 *
 * Runs against the test data dir (`~/.clopen-test`), with Claude transcripts
 * written into its isolated engine home.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeDatabase, initializeDatabase } from '$backend/database';
import { messageQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';
import { slimSession } from './chats';
import { purgeSessions, releaseTranscripts } from './purge';
import { collectEngineRefs, measureSession, refreshSessionIndex } from './session-index';
import {
	applyDedupe, listAllTranscripts, removeOrphans, resolveTranscriptAlias, selectOrphans, selectRedundant, transcriptExists,
	type TranscriptUsage
} from './transcripts';
import { claudeProjectsRoot } from './transcripts/claude';

const projectDir = join(claudeProjectsRoot(), 'storage-flow-test');
const id = () => crypto.randomUUID();
const A1 = id();
const A2 = id();
const B1 = id();
const ORPHAN = id();
const FRESH = id();
const DAY_AGO = (Date.now() - 24 * 60 * 60_000) / 1000;

let projectId: string;
let chatA: string;
let chatB: string;

const engine = { type: 'claude-code', provider: '', model: { id: '', name: '' }, account: { id: 0, name: '' } };
function assistant(sessionId: string, text = 'ok'): UnifiedMessage {
	return {
		type: 'assistant', createdAt: '', messageId: '', sessionId, stopReason: null, usage: null,
		parent: { messageId: null, sessionId: null, toolUseId: null }, engine,
		content: [{ type: 'text', text }]
	} as unknown as UnifiedMessage;
}

function writeTranscript(sessionId: string, uuids: string[], extra = ''): void {
	const lines = uuids.map((uuid, i) => JSON.stringify({ type: 'user', uuid, parentUuid: i === 0 ? null : uuids[i - 1], sessionId, text: extra }));
	const file = join(projectDir, `${sessionId}.jsonl`);
	writeFileSync(file, lines.join('\n') + '\n');
	utimesSync(file, DAY_AGO, DAY_AGO);
}

async function usage(): Promise<TranscriptUsage> {
	await refreshSessionIndex();
	const { byEngine, owners } = collectEngineRefs();
	return { refs: byEngine, owners, active: new Set() };
}

beforeAll(async () => {
	await initializeDatabase();
	const now = new Date().toISOString();
	projectId = projectQueries.create({ name: 'storage-flow', path: `/tmp/storage-flow-${id()}`, created_at: now, last_opened_at: now } as never).id;
	chatA = sessionQueries.create({ project_id: projectId, engine: 'claude-code', started_at: now } as never).id;
	chatB = sessionQueries.create({ project_id: projectId, engine: 'claude-code', started_at: now } as never).id;
	for (const [chat, sessionId] of [[chatA, A1], [chatA, A2], [chatB, B1]] as const) {
		const row = messageQueries.create({ session_id: chat, message: assistant(sessionId, 'y'.repeat(6000)) });
		sessionQueries.updateHead(chat, row.id);
		sessionQueries.updateOnMessage(chat, { messageType: 'assistant', timestamp: new Date().toISOString() });
	}

	mkdirSync(projectDir, { recursive: true });
	writeTranscript(A1, ['a', 'b']);
	// A2 is the next fork: every entry of A1, and it points at A1's side files.
	writeTranscript(A2, ['a', 'b', 'c', 'd'], `${projectDir}/${A1}/tool-results/out.txt`);
	mkdirSync(join(projectDir, A1, 'tool-results'), { recursive: true });
	writeFileSync(join(projectDir, A1, 'tool-results', 'out.txt'), 'output');
	writeTranscript(B1, ['e']);
	writeTranscript(ORPHAN, ['o']);
	writeFileSync(join(projectDir, `${FRESH}.jsonl`), '{"uuid":"f","parentUuid":null}\n');
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
	sessionQueries.deleteAllByProjectId(projectId);
	projectQueries.deleteProject(projectId);
	closeDatabase();
});

describe('storage transcript lifecycle', () => {
	it('reads the engine sessions each chat refers to', () => {
		expect(measureSession(chatA).refs.map(ref => ref.id).sort()).toEqual([A1, A2].sort());
	});

	it('finds unused transcripts, but not ones touched within the grace period', async () => {
		const orphans = selectOrphans(await listAllTranscripts(), await usage()).map(entry => entry.id);
		expect(orphans).toContain(ORPHAN);
		expect(orphans).not.toContain(FRESH);
		expect(orphans).not.toContain(A1);
		expect(orphans).not.toContain(B1);
	});

	it('replaces a contained fork by an alias and keeps the side files the later fork points at', async () => {
		const u = await usage();
		const redundant = await selectRedundant(await listAllTranscripts(), u);
		expect(redundant.map(item => [item.entry.id, item.target.id, item.resumeAt])).toEqual([[A1, A2, 'b']]);

		await applyDedupe(redundant);
		expect(existsSync(join(projectDir, `${A1}.jsonl`))).toBe(false);
		expect(existsSync(join(projectDir, A1, 'tool-results', 'out.txt'))).toBe(true);
		expect(resolveTranscriptAlias('claude-code', A1)).toEqual({ targetSessionId: A2, resumeAt: 'b' });
		expect(await transcriptExists('claude-code', A1, '/')).toBe(false);
		expect(await transcriptExists('claude-code', A2, '/')).toBe(true);
	});

	it('removes unused transcripts', async () => {
		const u = await usage();
		const result = await removeOrphans(selectOrphans(await listAllTranscripts(), u), u);
		expect(result.errors).toEqual([]);
		expect(existsSync(join(projectDir, `${ORPHAN}.jsonl`))).toBe(false);
		expect(existsSync(join(projectDir, `${FRESH}.jsonl`))).toBe(true);
	});

	it('releases a slimmed chat’s transcripts', async () => {
		await slimSession(chatB);
		expect(sessionQueries.getById(chatB)?.slimmed_at).toBeTruthy();
		expect(existsSync(join(projectDir, `${B1}.jsonl`))).toBe(false);
	});

	it('deleting a chat removes its transcripts, side files and aliases', async () => {
		const refs = measureSession(chatA).refs;
		await purgeSessions([chatA]);
		await releaseTranscripts(refs);
		expect(existsSync(join(projectDir, `${A2}.jsonl`))).toBe(false);
		expect(existsSync(join(projectDir, A1))).toBe(false);
		expect(resolveTranscriptAlias('claude-code', A1)).toBeNull();
	});
});

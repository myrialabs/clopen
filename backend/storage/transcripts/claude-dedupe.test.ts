/**
 * A Claude fork is redundant only when a later one holds every entry of it;
 * branches that diverged are both kept.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findContained, groupByOwner, readChain, type ChainSummary } from './claude-dedupe';
import type { TranscriptEntry } from './types';

const dir = mkdtempSync(join(tmpdir(), 'clopen-dedupe-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function entry(id: string, mtimeMs = 0): TranscriptEntry {
	return { engine: 'claude-code', id, paths: [join(dir, `${id}.jsonl`)], bytes: 1, mtimeMs, projectKey: 'p', projectPath: null };
}

function chain(...uuids: string[]): ChainSummary {
	return { uuids: new Set(uuids), tip: uuids.at(-1) ?? null };
}

describe('readChain', () => {
	it('collects chain entries and the last one as the tip, skipping metadata and sidechains', async () => {
		const file = join(dir, 'chain.jsonl');
		writeFileSync(file, [
			JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 's' }),
			JSON.stringify({ type: 'user', uuid: 'a', parentUuid: null }),
			JSON.stringify({ type: 'assistant', uuid: 'b', parentUuid: 'a' }),
			JSON.stringify({ type: 'assistant', uuid: 'side', parentUuid: 'b', isSidechain: true }),
			JSON.stringify({ type: 'attachment', uuid: 'c', parentUuid: 'b' }),
			JSON.stringify({ type: 'cost-state', sessionId: 's' }),
			'{"type":"user","uuid":"torn","parentUu'
		].join('\n'));
		const summary = await readChain(file);
		expect(summary).not.toBeNull();
		expect([...summary!.uuids]).toEqual(['a', 'b', 'c']);
		expect(summary!.tip).toBe('c');
	});

	it('returns null for a file that cannot be read', async () => {
		expect(await readChain(join(dir, 'missing.jsonl'))).toBeNull();
	});
});

describe('findContained', () => {
	it('aliases each earlier fork to the fork that contains it, cut at its own tip', () => {
		const result = findContained([
			{ entry: entry('t1'), chain: chain('a', 'b') },
			{ entry: entry('t2'), chain: chain('a', 'b', 'c', 'd') },
			{ entry: entry('t3'), chain: chain('a', 'b', 'c', 'd', 'e', 'f') }
		]);
		expect(result.map(r => [r.entry.id, r.target.id, r.resumeAt]).sort()).toEqual([
			['t1', 't3', 'b'],
			['t2', 't3', 'd']
		]);
	});

	it('keeps both ends of a branch', () => {
		const result = findContained([
			{ entry: entry('base'), chain: chain('a', 'b') },
			{ entry: entry('left'), chain: chain('a', 'b', 'l1') },
			{ entry: entry('right'), chain: chain('a', 'b', 'r1', 'r2') }
		]);
		expect(result.map(r => r.entry.id)).toEqual(['base']);
		expect(result[0].target.id).toBe('right');
	});

	it('keeps the newer of two identical files', () => {
		const result = findContained([
			{ entry: entry('old', 1), chain: chain('a', 'b') },
			{ entry: entry('new', 2), chain: chain('a', 'b') }
		]);
		expect(result.map(r => [r.entry.id, r.target.id])).toEqual([['old', 'new']]);
	});

	it('never aliases a file one entry short of containment', () => {
		const result = findContained([
			{ entry: entry('x'), chain: chain('a', 'b', 'z') },
			{ entry: entry('y'), chain: chain('a', 'b', 'c', 'd') }
		]);
		expect(result).toEqual([]);
	});
});

describe('groupByOwner', () => {
	it('groups transcripts of chats that share an engine session, and drops unowned ones', () => {
		const owners = new Map<string, Set<string>>([
			['t1', new Set(['chatA'])],
			['t2', new Set(['chatA', 'chatB'])],
			['t3', new Set(['chatB'])],
			['t4', new Set(['chatC'])],
			['t5', new Set(['chatC'])]
		]);
		const groups = groupByOwner(['t1', 't2', 't3', 't4', 't5', 'orphan'].map(id => entry(id)), owners)
			.map(group => group.map(e => e.id).sort())
			.sort((a, b) => a[0].localeCompare(b[0]));
		expect(groups).toEqual([['t1', 't2', 't3'], ['t4', 't5']]);
	});
});

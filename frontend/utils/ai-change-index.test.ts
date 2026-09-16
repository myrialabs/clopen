/**
 * The rules behind the violet marker.
 *
 * Three surfaces read this — the Files tree, the Git changes list and the
 * checkpoint Changes tab — and the bug that started this work was them
 * disagreeing: a file the AI had written showed no dot, and a file that had
 * been staged kept one forever. Both are decided here, so both are asserted
 * here.
 */

import { describe, expect, test } from 'bun:test';

import {
	indexTurnsByPath,
	toAbsolutePath,
	markerStateFor,
	describeTurns,
	turnIdOf,
	PENDING_TURN_ID,
	type TurnChanges,
	type TurnFileChange
} from './ai-change-index';

const ROOT = '/proj';

function file(path: string, overrides: Partial<TurnFileChange> = {}): TurnFileChange {
	return {
		path,
		status: 'modified',
		insertions: 1,
		deletions: 1,
		isBinary: false,
		contentAvailable: true,
		...overrides
	};
}

function turn(id: string | null, index: number | null, files: TurnFileChange[]): TurnChanges {
	return {
		checkpointMessageId: id,
		turnIndex: index,
		timestamp: '2026-01-01T00:00:00.000Z',
		promptText: id ? `prompt ${id}` : 'In progress',
		files
	};
}

describe('toAbsolutePath', () => {
	test('joins with the root\'s own separator', () => {
		expect(toAbsolutePath('/proj', 'src/a.ts')).toBe('/proj/src/a.ts');
		expect(toAbsolutePath('C:\\proj', 'src/a.ts')).toBe('C:\\proj\\src\\a.ts');
	});
});

describe('indexTurnsByPath', () => {
	test('keys files by absolute path, which is what the tree looks them up by', () => {
		const index = indexTurnsByPath([turn('c1', 1, [file('src/a.ts')])], ROOT);

		expect([...index.keys()]).toEqual(['/proj/src/a.ts']);
		expect(index.get('/proj/src/a.ts')?.relativePath).toBe('src/a.ts');
	});

	test('collects every turn that touched a file, newest first', () => {
		const index = indexTurnsByPath(
			[turn('c3', 3, [file('src/a.ts')]), turn('c1', 1, [file('src/a.ts')])],
			ROOT
		);

		const entry = index.get('/proj/src/a.ts');
		expect(entry?.turns.map((t) => t.checkpointMessageId)).toEqual(['c3', 'c1']);
		// The status shown is the newest one, not whatever was seen last.
		expect(entry?.latestStatus).toBe('modified');
	});

	test('takes the newest turn\'s status, so a re-created file does not read as deleted', () => {
		const index = indexTurnsByPath(
			[
				turn('c2', 2, [file('src/a.ts', { status: 'added' })]),
				turn('c1', 1, [file('src/a.ts', { status: 'deleted' })])
			],
			ROOT
		);

		expect(index.get('/proj/src/a.ts')?.latestStatus).toBe('added');
	});

	test('flags a file the running turn is touching', () => {
		const index = indexTurnsByPath(
			[turn(null, null, [file('src/a.ts')]), turn('c1', 1, [file('src/b.ts')])],
			ROOT
		);

		expect(index.get('/proj/src/a.ts')?.isPending).toBe(true);
		expect(index.get('/proj/src/b.ts')?.isPending).toBe(false);
	});

	test('answers empty when no project root is known yet', () => {
		expect(indexTurnsByPath([turn('c1', 1, [file('src/a.ts')])], '').size).toBe(0);
	});
});

describe('markerStateFor', () => {
	const changes = indexTurnsByPath([turn('c1', 1, [file('src/a.ts')])], ROOT).get('/proj/src/a.ts')!;

	test('shows nothing for a file this chat never touched', () => {
		expect(markerStateFor(null, true, new Set())).toBeNull();
	});

	test('stays live while the change is still unstaged', () => {
		expect(markerStateFor(changes, true, new Set(['/proj/src/a.ts']))).toBe('live');
	});

	test('dims once the change is staged or committed', () => {
		expect(markerStateFor(changes, true, new Set())).toBe('settled');
	});

	test('stays live outside a git repo, where there is no staging to read', () => {
		expect(markerStateFor(changes, false, new Set())).toBe('live');
	});
});

describe('describeTurns', () => {
	function entryFor(turns: TurnChanges[]) {
		return indexTurnsByPath(turns, ROOT).get('/proj/src/a.ts')!;
	}

	test('names the turn when only one touched the file', () => {
		expect(describeTurns(entryFor([turn('c3', 3, [file('src/a.ts')])]))).toBe(
			'Changed in turn 3 of this chat'
		);
	});

	test('counts them when several did', () => {
		expect(
			describeTurns(entryFor([turn('c2', 2, [file('src/a.ts')]), turn('c1', 1, [file('src/a.ts')])]))
		).toBe('Changed in 2 turns of this chat');
	});

	test('says so while the turn is still running', () => {
		expect(describeTurns(entryFor([turn(null, null, [file('src/a.ts')])]))).toBe(
			'Changing in the turn running now'
		);
	});
});

describe('turnIdOf', () => {
	test('uses the checkpoint id, and a stable stand-in for the running turn', () => {
		expect(turnIdOf(turn('c1', 1, []))).toBe('c1');
		expect(turnIdOf(turn(null, null, []))).toBe(PENDING_TURN_ID);
	});
});

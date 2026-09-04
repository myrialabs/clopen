/**
 * Panel state is stored one row per (user, project) but must be separated per
 * workspace inside it. Sharing one entry carried open tabs — including unsaved
 * buffers — from the main tree into a worktree, which read as the edit having
 * crossed between them.
 *
 * The envelope logic is what enforces that separation, so it is exercised here
 * against the same shape the handlers read and write.
 */
import { describe, expect, test } from 'bun:test';

interface ScopedPanelState {
	v: 2;
	scopes: Record<string, string>;
}

function parseStored(raw: string | null): ScopedPanelState {
	if (!raw) return { v: 2, scopes: {} };
	try {
		const parsed = JSON.parse(raw) as ScopedPanelState;
		if (parsed && parsed.v === 2 && typeof parsed.scopes === 'object') return parsed;
	} catch {
		// unparseable → treated as absent
	}
	return { v: 2, scopes: {} };
}

function isLegacyState(raw: string | null): boolean {
	if (!raw) return false;
	try {
		return (JSON.parse(raw) as { v?: number })?.v !== 2;
	} catch {
		return false;
	}
}

/** Mirrors files:set-panel-state. */
function writeScope(raw: string | null, projectId: string, scopeKey: string, state: string | null): string {
	const stored = parseStored(raw);
	if (isLegacyState(raw) && raw) stored.scopes[projectId] = raw;
	if (state === null) delete stored.scopes[scopeKey];
	else stored.scopes[scopeKey] = state;
	return JSON.stringify(stored);
}

/** Mirrors files:get-panel-state. */
function readScope(raw: string | null, projectId: string, scopeKey: string): string | null {
	if (isLegacyState(raw)) return scopeKey === projectId ? raw : null;
	return parseStored(raw).scopes[scopeKey] ?? null;
}

const PROJECT = 'proj-1';
const MAIN = PROJECT;
const WORKTREE = 'proj-1~wt-1';

describe('files panel state scoping', () => {
	test('a worktree does not see the main tree state', () => {
		const stored = writeScope(null, PROJECT, MAIN, '{"openTabs":["a.ts"]}');
		expect(readScope(stored, PROJECT, MAIN)).toBe('{"openTabs":["a.ts"]}');
		expect(readScope(stored, PROJECT, WORKTREE)).toBeNull();
	});

	test('writing one workspace keeps the other', () => {
		let stored = writeScope(null, PROJECT, MAIN, 'main-state');
		stored = writeScope(stored, PROJECT, WORKTREE, 'worktree-state');

		expect(readScope(stored, PROJECT, MAIN)).toBe('main-state');
		expect(readScope(stored, PROJECT, WORKTREE)).toBe('worktree-state');
	});

	test('two worktrees of one project stay separate', () => {
		const second = 'proj-1~wt-2';
		let stored = writeScope(null, PROJECT, WORKTREE, 'first');
		stored = writeScope(stored, PROJECT, second, 'second');

		expect(readScope(stored, PROJECT, WORKTREE)).toBe('first');
		expect(readScope(stored, PROJECT, second)).toBe('second');
	});

	test('legacy flat state belongs to the main tree only', () => {
		const legacy = '{"v":1,"openTabs":[]}';
		expect(readScope(legacy, PROJECT, MAIN)).toBe(legacy);
		expect(readScope(legacy, PROJECT, WORKTREE)).toBeNull();
	});

	test('the first worktree write preserves legacy main state', () => {
		const legacy = '{"v":1,"openTabs":[]}';
		const stored = writeScope(legacy, PROJECT, WORKTREE, 'worktree-state');

		expect(readScope(stored, PROJECT, MAIN)).toBe(legacy);
		expect(readScope(stored, PROJECT, WORKTREE)).toBe('worktree-state');
	});

	test('clearing one workspace leaves the others intact', () => {
		let stored = writeScope(null, PROJECT, MAIN, 'main-state');
		stored = writeScope(stored, PROJECT, WORKTREE, 'worktree-state');
		stored = writeScope(stored, PROJECT, WORKTREE, null);

		expect(readScope(stored, PROJECT, MAIN)).toBe('main-state');
		expect(readScope(stored, PROJECT, WORKTREE)).toBeNull();
	});
});

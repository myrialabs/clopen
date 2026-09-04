import { describe, expect, test } from 'bun:test';
import { isScopeOfProject, makeScopeKey, parseScopeKey, scopeProjectId, scopeSlug } from './workspace-scope';

const PROJECT = '0f8c2a1e-1111-4a2b-9c3d-000000000001';
const WORKTREE = '5b7d3c9f-2222-4e6a-8b1c-000000000002';

describe('makeScopeKey', () => {
	test('is the project id itself for the main tree', () => {
		expect(makeScopeKey(PROJECT, null)).toBe(PROJECT);
		expect(makeScopeKey(PROJECT)).toBe(PROJECT);
		expect(makeScopeKey(PROJECT, '')).toBe(PROJECT);
	});

	test('joins project and worktree for a worktree', () => {
		expect(makeScopeKey(PROJECT, WORKTREE)).toBe(`${PROJECT}~${WORKTREE}`);
	});
});

describe('parseScopeKey', () => {
	test('reads back a main-tree key', () => {
		expect(parseScopeKey(PROJECT)).toEqual({ projectId: PROJECT, worktreeId: null });
	});

	test('reads back a worktree key', () => {
		expect(parseScopeKey(makeScopeKey(PROJECT, WORKTREE))).toEqual({
			projectId: PROJECT,
			worktreeId: WORKTREE
		});
	});

	test('treats a trailing separator as the main tree', () => {
		expect(parseScopeKey(`${PROJECT}~`)).toEqual({ projectId: PROJECT, worktreeId: null });
	});
});

describe('scopeProjectId', () => {
	test('is what every access check runs against', () => {
		expect(scopeProjectId(makeScopeKey(PROJECT, WORKTREE))).toBe(PROJECT);
		expect(scopeProjectId(PROJECT)).toBe(PROJECT);
	});
});

describe('isScopeOfProject', () => {
	test('matches the project and each of its worktrees', () => {
		expect(isScopeOfProject(PROJECT, PROJECT)).toBe(true);
		expect(isScopeOfProject(makeScopeKey(PROJECT, WORKTREE), PROJECT)).toBe(true);
	});

	test('rejects another project', () => {
		const other = '9999aaaa-3333-4c4d-8e5f-000000000003';
		expect(isScopeOfProject(makeScopeKey(other, WORKTREE), PROJECT)).toBe(false);
	});

	test('rejects a project id that merely shares a prefix', () => {
		expect(isScopeOfProject(`${PROJECT}-extra`, PROJECT)).toBe(false);
	});
});

describe('scopeSlug', () => {
	test('distinguishes a worktree from its project', () => {
		expect(scopeSlug(PROJECT)).not.toBe(scopeSlug(makeScopeKey(PROJECT, WORKTREE)));
	});

	test('distinguishes two worktrees of the same project', () => {
		const other = 'aaaa1111-4444-4f7b-9d2e-000000000004';
		expect(scopeSlug(makeScopeKey(PROJECT, WORKTREE))).not.toBe(
			scopeSlug(makeScopeKey(PROJECT, other))
		);
	});

	test('is stable and alphanumeric so it survives id sanitisation', () => {
		const slug = scopeSlug(makeScopeKey(PROJECT, WORKTREE));
		expect(slug).toBe(scopeSlug(makeScopeKey(PROJECT, WORKTREE)));
		expect(slug).toMatch(/^[a-zA-Z0-9]+$/);
	});

	test('keeps the main-tree token short and project-derived', () => {
		expect(scopeSlug(PROJECT)).toBe('0f8c2a1e');
	});
});

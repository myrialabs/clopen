import { describe, expect, test } from 'bun:test';
import type { PermissionSet } from '$backend/database/queries';
import {
	matchesPattern,
	matchesAny,
	mergePermissions,
	mergeLayers,
	isToolAllowed,
	hasAnyRestriction,
	pickEngineSet,
	EMPTY_PERMISSIONS
} from './resolve';

describe('matchesPattern', () => {
	test('exact match', () => {
		expect(matchesPattern('Bash', 'Bash')).toBe(true);
		expect(matchesPattern('Bash', 'Edit')).toBe(false);
	});

	test('trailing wildcard', () => {
		expect(matchesPattern('mcp__github__*', 'mcp__github__create_issue')).toBe(true);
		expect(matchesPattern('mcp__github__*', 'mcp__gitlab__x')).toBe(false);
		// A bare `*` matches everything.
		expect(matchesPattern('*', 'anything')).toBe(true);
	});

	test('wildcard does not match middle', () => {
		expect(matchesPattern('mcp__*__issue', 'mcp__github__issue')).toBe(false);
	});
});

describe('matchesAny', () => {
	test('any pattern hits', () => {
		expect(matchesAny(['Read', 'Write'], 'Write')).toBe(true);
		expect(matchesAny(['Read', 'Write'], 'Bash')).toBe(false);
		expect(matchesAny([], 'Bash')).toBe(false);
	});
});

describe('isToolAllowed', () => {
	test('empty set allows everything', () => {
		expect(isToolAllowed(EMPTY_PERMISSIONS, 'Bash')).toBe(true);
	});

	test('deny blocks', () => {
		expect(isToolAllowed({ allow: [], deny: ['Bash'] }, 'Bash')).toBe(false);
		expect(isToolAllowed({ allow: [], deny: ['Bash'] }, 'Read')).toBe(true);
	});

	test('allowlist gates non-listed tools', () => {
		const set = { allow: ['Read', 'Grep'], deny: [] };
		expect(isToolAllowed(set, 'Read')).toBe(true);
		expect(isToolAllowed(set, 'Bash')).toBe(false);
	});

	test('deny wins over allow', () => {
		const set = { allow: ['Bash'], deny: ['Bash'] };
		expect(isToolAllowed(set, 'Bash')).toBe(false);
	});

	test('wildcards in both lists', () => {
		const set = { allow: ['mcp__github__*'], deny: ['mcp__github__delete_*'] };
		expect(isToolAllowed(set, 'mcp__github__create_issue')).toBe(true);
		expect(isToolAllowed(set, 'mcp__github__delete_repo')).toBe(false);
		expect(isToolAllowed(set, 'Bash')).toBe(false); // not in allowlist
	});
});

describe('mergePermissions', () => {
	test('deny is the union of both scopes', () => {
		const merged = mergePermissions({ allow: [], deny: ['Bash'] }, { allow: [], deny: ['Write'] });
		expect(merged.deny.sort()).toEqual(['Bash', 'Write']);
	});

	test('project allowlist overrides global when non-empty', () => {
		const merged = mergePermissions({ allow: ['Read'], deny: [] }, { allow: ['Grep'], deny: [] });
		expect(merged.allow).toEqual(['Grep']);
	});

	test('global allowlist applies when project has none', () => {
		const merged = mergePermissions({ allow: ['Read'], deny: [] }, { allow: [], deny: ['Bash'] });
		expect(merged.allow).toEqual(['Read']);
		expect(merged.deny).toEqual(['Bash']);
	});

	test('undefined scopes yield empty', () => {
		expect(mergePermissions(undefined, undefined)).toEqual({ allow: [], deny: [] });
	});

	test('deny union de-duplicates', () => {
		const merged = mergePermissions({ allow: [], deny: ['Bash'] }, { allow: [], deny: ['Bash'] });
		expect(merged.deny).toEqual(['Bash']);
	});
});

describe('mergeLayers', () => {
	test('deny unions across all layers', () => {
		const merged = mergeLayers([
			{ allow: [], deny: ['Bash'] },
			{ allow: [], deny: ['Write'] },
			{ allow: [], deny: ['WebFetch'] }
		]);
		expect(merged.deny.sort()).toEqual(['Bash', 'WebFetch', 'Write']);
	});

	test('most specific non-empty allowlist wins', () => {
		const merged = mergeLayers([
			{ allow: ['Read'], deny: [] },      // global
			{ allow: ['Grep'], deny: [] },      // project
			{ allow: ['Edit'], deny: [] }       // profile (most specific)
		]);
		expect(merged.allow).toEqual(['Edit']);
	});

	test('broader allowlist applies when more specific layers have none', () => {
		const merged = mergeLayers([
			{ allow: ['Read'], deny: [] },
			undefined,
			{ allow: [], deny: ['Bash'] }
		]);
		expect(merged.allow).toEqual(['Read']);
		expect(merged.deny).toEqual(['Bash']);
	});

	test('profile layer only adds deny (union), keeps base allow', () => {
		const merged = mergeLayers([
			{ allow: ['Read', 'Edit'], deny: ['Bash'] }, // base (global)
			undefined,                                    // no project
			{ allow: [], deny: ['WebFetch'] }             // profile overlay
		]);
		expect(merged.allow).toEqual(['Read', 'Edit']);
		expect(merged.deny.sort()).toEqual(['Bash', 'WebFetch']);
	});

	test('all-undefined yields empty', () => {
		expect(mergeLayers([undefined, undefined, undefined])).toEqual({ allow: [], deny: [] });
	});
});

describe('hasAnyRestriction', () => {
	test('true when either list is non-empty', () => {
		expect(hasAnyRestriction({ allow: ['Read'], deny: [] })).toBe(true);
		expect(hasAnyRestriction({ allow: [], deny: ['Bash'] })).toBe(true);
		expect(hasAnyRestriction(EMPTY_PERMISSIONS)).toBe(false);
	});
});

describe('pickEngineSet', () => {
	const sets: PermissionSet[] = [
		{ id: 1, scope: 'global', projectId: null, profileId: null, engine: 'claude-code', allow: ['Read'], deny: ['Bash'] },
		{ id: 2, scope: 'global', projectId: null, profileId: null, engine: 'codex', allow: [], deny: ['shell'] }
	];

	test('finds the row for the engine', () => {
		expect(pickEngineSet(sets, 'claude-code')).toEqual({ allow: ['Read'], deny: ['Bash'] });
		expect(pickEngineSet(sets, 'codex')).toEqual({ allow: [], deny: ['shell'] });
	});

	test('undefined when engine has no row', () => {
		expect(pickEngineSet(sets, 'qwen')).toBeUndefined();
	});
});

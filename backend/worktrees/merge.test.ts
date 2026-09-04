import { describe, expect, test } from 'bun:test';
import { planMerge } from './merge';

const HASH_A = 'aaaa';
const HASH_B = 'bbbb';
const HASH_C = 'cccc';

describe('planMerge', () => {
	test('carries a file the source added', () => {
		const plan = planMerge({}, { 'new.ts': HASH_A }, {});

		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0]).toMatchObject({
			path: 'new.ts',
			status: 'added',
			conflict: false
		});
	});

	test('carries a file the source modified', () => {
		const plan = planMerge({ 'a.ts': HASH_A }, { 'a.ts': HASH_B }, { 'a.ts': HASH_A });

		expect(plan.entries[0]).toMatchObject({ path: 'a.ts', status: 'modified', conflict: false });
	});

	test('carries a file the source deleted', () => {
		const plan = planMerge({ 'a.ts': HASH_A }, {}, { 'a.ts': HASH_A });

		expect(plan.entries[0]).toMatchObject({ path: 'a.ts', status: 'deleted', conflict: false });
	});

	test('ignores files the source never touched', () => {
		// The target moved on alone — a transfer must not drag it back to the base.
		const plan = planMerge({ 'a.ts': HASH_A }, { 'a.ts': HASH_A }, { 'a.ts': HASH_B });

		expect(plan.entries).toHaveLength(0);
	});

	test('ignores files where both sides made the same change', () => {
		const plan = planMerge({ 'a.ts': HASH_A }, { 'a.ts': HASH_B }, { 'a.ts': HASH_B });

		expect(plan.entries).toHaveLength(0);
	});

	test('flags a file both sides changed differently', () => {
		const plan = planMerge({ 'a.ts': HASH_A }, { 'a.ts': HASH_B }, { 'a.ts': HASH_C });

		expect(plan.conflicts).toHaveLength(1);
		expect(plan.conflicts[0]).toMatchObject({
			path: 'a.ts',
			status: 'modified',
			conflict: true,
			baseHash: HASH_A,
			sourceHash: HASH_B,
			targetHash: HASH_C
		});
	});

	test('flags a source edit against a target deletion', () => {
		const plan = planMerge({ 'a.ts': HASH_A }, { 'a.ts': HASH_B }, {});

		expect(plan.conflicts[0]).toMatchObject({
			path: 'a.ts',
			status: 'modified',
			conflict: true,
			targetHash: null
		});
	});

	test('treats an add on both sides with different content as a conflict', () => {
		const plan = planMerge({}, { 'a.ts': HASH_A }, { 'a.ts': HASH_B });

		expect(plan.conflicts[0]).toMatchObject({ path: 'a.ts', status: 'added', conflict: true });
	});

	test('leaves an empty plan when nothing diverged', () => {
		const tree = { 'a.ts': HASH_A, 'b.ts': HASH_B };
		const plan = planMerge(tree, { ...tree }, { ...tree });

		expect(plan.entries).toHaveLength(0);
		expect(plan.conflicts).toHaveLength(0);
	});

	test('returns entries in a stable path order', () => {
		const plan = planMerge(
			{},
			{ 'z.ts': HASH_A, 'a.ts': HASH_A, 'm.ts': HASH_A },
			{}
		);

		expect(plan.entries.map((entry) => entry.path)).toEqual(['a.ts', 'm.ts', 'z.ts']);
	});
});

import { describe, expect, it } from 'bun:test';
import { collectProcessTree, cpuCapacityFactor, getHostFacts, withTimeout } from './metrics';

function proc(pid: number, parentPid: number) {
	return { pid, parentPid };
}

describe('collectProcessTree', () => {
	it('keeps the roots even when the table does not list them', () => {
		expect([...collectProcessTree([], [42])]).toEqual([42]);
	});

	it('excludes processes outside the roots', () => {
		const tree = collectProcessTree([proc(100, 1), proc(200, 1), proc(201, 200)], [200]);
		expect([...tree].sort((a, b) => a - b)).toEqual([200, 201]);
	});

	it('reaches past the depth a bounded pass count would stop at', () => {
		// shell → 15 nested children, listed child-before-parent so a
		// repeated-pass matcher would only pick up one level per pass.
		const list = [];
		for (let depth = 15; depth >= 1; depth--) list.push(proc(1000 + depth, 1000 + depth - 1));
		const tree = collectProcessTree(list, [1000]);
		expect(tree.size).toBe(16);
		expect(tree.has(1015)).toBe(true);
	});

	it('collects several roots at once', () => {
		const list = [proc(11, 10), proc(21, 20), proc(31, 30)];
		const tree = collectProcessTree(list, [10, 20]);
		expect([...tree].sort((a, b) => a - b)).toEqual([10, 11, 20, 21]);
	});

	it('terminates on a parent cycle', () => {
		const tree = collectProcessTree([proc(2, 1), proc(1, 2)], [1]);
		expect([...tree].sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it('ignores a process that claims to be its own parent', () => {
		const tree = collectProcessTree([proc(5, 5), proc(6, 5)], [5]);
		expect([...tree].sort((a, b) => a - b)).toEqual([5, 6]);
	});
});

describe('cpuCapacityFactor', () => {
	it('passes Linux through once a delta exists', () => {
		expect(cpuCapacityFactor('linux', 8, 0.5, true)).toBe(1);
	});

	it('has no answer for Linux before the second sample', () => {
		expect(cpuCapacityFactor('linux', 8, 0.5, false)).toBeNull();
	});

	it('divides the per-core macOS reading by the core count', () => {
		expect(cpuCapacityFactor('darwin', 8, null, false)).toBe(1 / 8);
	});

	it('treats the BSDs like macOS', () => {
		expect(cpuCapacityFactor('freebsd', 4, null, true)).toBe(1 / 4);
	});

	it('scales Windows by the machine busy fraction', () => {
		expect(cpuCapacityFactor('win32', 8, 0.25, true)).toBe(0.25);
	});

	it('has no answer for Windows without a busy fraction', () => {
		expect(cpuCapacityFactor('win32', 8, null, true)).toBeNull();
		expect(cpuCapacityFactor('win32', 8, 0.25, false)).toBeNull();
	});

	it('refuses to divide by a missing core count', () => {
		expect(cpuCapacityFactor('darwin', 0, null, true)).toBeNull();
	});
});

describe('withTimeout', () => {
	it('passes a value through when it beats the deadline', async () => {
		expect(await withTimeout(Promise.resolve(7), 1000)).toBe(7);
	});

	it('resolves null on timeout when no fallback is given', async () => {
		expect(await withTimeout(new Promise(() => {}), 10)).toBeNull();
	});

	it('resolves the fallback on timeout when one is given', async () => {
		expect(await withTimeout(new Promise<number>(() => {}), 10, -1)).toBe(-1);
	});

	it('treats a rejection like a timeout rather than propagating it', async () => {
		expect(await withTimeout(Promise.reject(new Error('nope')), 1000)).toBeNull();
	});
});

describe('getHostFacts', () => {
	it('probes once and hands every caller the same object', async () => {
		const [a, b] = await Promise.all([getHostFacts(), getHostFacts()]);
		expect(a).toBe(b);
	});

	it('always answers with a usable core count and installed RAM', async () => {
		// Both are denominators: the core count normalises per-process CPU on
		// macOS/BSD, and the RAM total is what "percent of host memory" divides
		// by in Project Info. A zero from a failed probe would poison both.
		const facts = await getHostFacts();
		expect(facts.logicalCores).toBeGreaterThan(0);
		expect(facts.totalMemBytes).toBeGreaterThan(0);
		expect(facts.platform).toBeTruthy();
		expect(facts.arch).toBeTruthy();
	});
});

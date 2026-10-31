import { describe, expect, test } from 'bun:test';
import { GitBusyError, getScopeOpStates, hasProjectOps, onGitOpChange, withGitOpLock } from './op-lock';
import type { GitRepoOpState } from '$shared/types/git';

let counter = 0;
/** A fresh repository key per test, so tests never share a lock. */
function key(scope = 'project-a') {
	return { cwd: `/tmp/op-lock-test-${++counter}`, scope };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => (resolve = r));
	return { promise, resolve };
}

describe('withGitOpLock', () => {
	test('refuses an exclusive operation while another runs, naming it', async () => {
		const repo = key();
		const gate = deferred();
		const pull = withGitOpLock(repo, { category: 'pull', label: 'Pull', target: 'main' }, () => gate.promise);

		const push = withGitOpLock(repo, { category: 'push', label: 'Push' }, async () => 'pushed');
		await expect(push).rejects.toBeInstanceOf(GitBusyError);
		await expect(push).rejects.toThrow(/Pull \(main\) is still running/);

		gate.resolve();
		await pull;
		expect(await withGitOpLock(repo, { category: 'push', label: 'Push' }, async () => 'pushed')).toBe('pushed');
	});

	test('lets staging run while a network operation is in flight', async () => {
		const repo = key();
		const gate = deferred();
		const push = withGitOpLock(repo, { category: 'push', label: 'Push' }, () => gate.promise);
		expect(await withGitOpLock(repo, { category: 'staging', label: 'Staging' }, async () => 'staged')).toBe('staged');
		gate.resolve();
		await push;
	});

	test('refuses a second network operation', async () => {
		const repo = key();
		const gate = deferred();
		const push = withGitOpLock(repo, { category: 'push', label: 'Push' }, () => gate.promise);
		await expect(withGitOpLock(repo, { category: 'fetch', label: 'Fetch' }, async () => {})).rejects.toBeInstanceOf(
			GitBusyError
		);
		gate.resolve();
		await push;
	});

	test('queues index writes behind each other instead of refusing', async () => {
		const repo = key();
		const order: string[] = [];
		const gate = deferred();
		const first = withGitOpLock(repo, { category: 'staging', label: 'Staging', queue: true }, async () => {
			await gate.promise;
			order.push('first');
		});
		const second = withGitOpLock(repo, { category: 'staging', label: 'Staging', queue: true }, async () => {
			order.push('second');
		});
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(['first', 'second']);
	});

	test('a queued index write still refuses an exclusive holder', async () => {
		const repo = key();
		const gate = deferred();
		const commit = withGitOpLock(repo, { category: 'commit', label: 'Commit' }, () => gate.promise);
		await expect(
			withGitOpLock(repo, { category: 'staging', label: 'Staging', queue: true }, async () => {})
		).rejects.toBeInstanceOf(GitBusyError);
		gate.resolve();
		await commit;
	});

	test('releases the lock when the operation throws', async () => {
		const repo = key();
		await expect(
			withGitOpLock(repo, { category: 'pull', label: 'Pull' }, async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		expect(await withGitOpLock(repo, { category: 'pull', label: 'Pull' }, async () => 'again')).toBe('again');
	});

	test('reports state to listeners and snapshots, per scope and project', async () => {
		const repo = { ...key('project-b~wt1'), repoPath: '/nested' };
		const seen: GitRepoOpState[] = [];
		const stop = onGitOpChange(state => {
			if (state.scope === 'project-b~wt1') seen.push(state);
		});
		const gate = deferred();
		const running = withGitOpLock(repo, { category: 'fetch', label: 'Fetch', target: 'origin' }, () => gate.promise);

		expect(getScopeOpStates('project-b~wt1')).toHaveLength(1);
		expect(getScopeOpStates('project-b~wt1')[0].repoPath).toBe('/nested');
		expect(getScopeOpStates('project-b')).toHaveLength(0);
		expect(hasProjectOps('project-b')).toBe(true);

		gate.resolve();
		await running;
		stop();

		expect(seen.map(s => s.ops.length)).toEqual([1, 0]);
		expect(seen[0].ops[0]).toMatchObject({ category: 'fetch', cls: 'network', target: 'origin' });
		expect(hasProjectOps('project-b')).toBe(false);
	});
});

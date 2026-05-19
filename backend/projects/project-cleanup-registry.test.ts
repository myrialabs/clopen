import { beforeEach, describe, expect, test } from 'bun:test';
import { projectCleanupRegistry } from './project-cleanup-registry';

describe('projectCleanupRegistry', () => {
	beforeEach(() => {
		projectCleanupRegistry._clearHandlers();
	});

	test('runAll invokes registered handlers', async () => {
		const calls: string[] = [];
		projectCleanupRegistry.register({
			name: 'test-a',
			run: async (projectId) => {
				calls.push(`a:${projectId}`);
			}
		});
		projectCleanupRegistry.register({
			name: 'test-b',
			run: (projectId) => {
				calls.push(`b:${projectId}`);
			}
		});

		await projectCleanupRegistry.runAll('proj-1');

		expect(calls).toEqual(['a:proj-1', 'b:proj-1']);
	});

	test('runAll continues when a handler throws', async () => {
		const calls: string[] = [];
		projectCleanupRegistry.register({
			name: 'failing',
			run: () => {
				throw new Error('boom');
			}
		});
		projectCleanupRegistry.register({
			name: 'ok',
			run: () => {
				calls.push('ok');
			}
		});

		await projectCleanupRegistry.runAll('proj-2');

		expect(calls).toEqual(['ok']);
	});
});

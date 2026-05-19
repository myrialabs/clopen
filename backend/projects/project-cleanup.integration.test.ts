import { describe, expect, test } from 'bun:test';
import { projectCleanupRegistry, runProjectCleanups } from './project-cleanup-registry';

import './project-cleanup';

const DEFAULT_CLEANUP_HANDLERS = ['engine', 'mcp-context', 'file-watcher', 'presence'] as const;

describe('project cleanup integration', () => {
	test('registers default backend handlers when project-cleanup is loaded', () => {
		const names = projectCleanupRegistry._getHandlerNames();
		for (const expected of DEFAULT_CLEANUP_HANDLERS) {
			expect(names).toContain(expected);
		}
		expect(names.indexOf('engine')).toBeLessThan(names.indexOf('mcp-context'));
		expect(names.indexOf('mcp-context')).toBeLessThan(names.indexOf('file-watcher'));
		expect(names.indexOf('file-watcher')).toBeLessThan(names.indexOf('presence'));
	});

	test('runProjectCleanups runs default handlers without throwing', async () => {
		await expect(runProjectCleanups('proj-cleanup-integration')).resolves.toBeUndefined();
	});

	test('runProjectCleanups forwards the project id to registered handlers', async () => {
		const received: string[] = [];
		projectCleanupRegistry.register({
			name: 'integration-spy',
			run: (projectId) => {
				received.push(projectId);
			}
		});

		await runProjectCleanups('proj-cleanup-spy');

		expect(received).toEqual(['proj-cleanup-spy']);
	});
});

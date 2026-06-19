import { describe, expect, test, beforeEach } from 'bun:test';
import { projectContextService } from './project-context';

describe('projectContextService.clearByProjectId', () => {
	beforeEach(() => {
		projectContextService.clear();
	});

	test('removes session and stream mappings for the project only', () => {
		projectContextService.registerSession('session-a', 'project-1');
		projectContextService.registerStream('stream-a', 'project-1', 'session-a');
		projectContextService.registerSession('session-b', 'project-2');
		projectContextService.registerStream('stream-b', 'project-2', 'session-b');

		projectContextService.clearByProjectId('project-1');

		expect(projectContextService.getProjectIdForSession('session-a')).toBeNull();
		expect(projectContextService.getProjectIdForStream('stream-a')).toBeNull();
		expect(projectContextService.getProjectIdForSession('session-b')).toBe('project-2');
		expect(projectContextService.getLastUsedProjectId()).toBe('project-2');
	});
});

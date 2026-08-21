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

describe('projectContextService bridge identity', () => {
	beforeEach(() => {
		projectContextService.clear();
	});

	test('a bound project wins over the most recently started stream', () => {
		projectContextService.registerSession('session-a', 'project-a');
		projectContextService.registerStream('stream-a', 'project-a', 'session-a', 'codex');
		// The user moves to another project and prompts there — this is the stream
		// the old ambient fallback would have attributed project-a's tool call to.
		projectContextService.registerSession('session-b', 'project-b');
		projectContextService.registerStream('stream-b', 'project-b', 'session-b', 'codex');

		projectContextService.runWithContext({ projectId: 'project-a' }, () => {
			expect(projectContextService.getCurrentProjectId()).toBe('project-a');
			expect(projectContextService.getCurrentChatSessionId()).toBe('session-a');
		});
	});

	test('engine scoping ignores streams belonging to another engine', () => {
		projectContextService.registerSession('session-a', 'project-a');
		projectContextService.registerStream('stream-a', 'project-a', 'session-a', 'opencode');
		projectContextService.registerSession('session-b', 'project-b');
		projectContextService.registerStream('stream-b', 'project-b', 'session-b', 'claude-code');

		expect(projectContextService.getContextForEngine('opencode')).toMatchObject({
			projectId: 'project-a',
			chatSessionId: 'session-a'
		});
		expect(projectContextService.getContextForEngine('cursor')).toBeUndefined();
	});

	test('an unidentified caller still falls back to the most recent stream', () => {
		projectContextService.registerSession('session-a', 'project-a');
		projectContextService.registerStream('stream-a', 'project-a', 'session-a', 'codex');

		expect(projectContextService.getCurrentProjectId()).toBe('project-a');
	});
});

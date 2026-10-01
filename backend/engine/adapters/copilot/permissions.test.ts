import { describe, expect, test } from 'bun:test';
import type { PermissionRequest } from '@github/copilot-sdk';
import { buildCopilotManagedSettings, enforceCopilotPermission } from './permissions';

describe('buildCopilotManagedSettings', () => {
	test('returns undefined when the policy restricts nothing', () => {
		expect(buildCopilotManagedSettings({ allow: [], deny: [] })).toBeUndefined();
	});

	test('denies the families the deny list names', () => {
		expect(buildCopilotManagedSettings({ allow: [], deny: ['shell', 'write'] })).toEqual({
			permissions: { deny: ['Shell', 'Write'] }
		});
	});

	test('denies the families an allowlist leaves out', () => {
		expect(buildCopilotManagedSettings({ allow: ['read', 'url'], deny: [] })).toEqual({
			permissions: { deny: ['Shell', 'Write'] }
		});
	});

	test('never emits a family the runtime rejects', () => {
		// url / memory / MCP rules fail session creation on the runtime, so a
		// policy that only touches them must leave the managed layer empty.
		expect(buildCopilotManagedSettings({ allow: [], deny: ['url', 'memory', 'mcp__clopen__*'] })).toBeUndefined();
	});

	test('honours wildcard patterns', () => {
		expect(buildCopilotManagedSettings({ allow: [], deny: ['*'] })).toEqual({
			permissions: { deny: ['Shell', 'Write', 'Read'] }
		});
	});
});

describe('enforceCopilotPermission', () => {
	const request = (data: Record<string, unknown>) => data as unknown as PermissionRequest;

	test('rejects a denied kind', () => {
		expect(enforceCopilotPermission({ allow: [], deny: ['url'] }, request({ kind: 'url' }))?.kind).toBe('reject');
	});

	test('matches MCP tools by tool name rather than kind', () => {
		const policy = { allow: [], deny: ['mcp__github__*'] };
		expect(enforceCopilotPermission(policy, request({ kind: 'mcp', toolName: 'mcp__github__get_me' }))?.kind).toBe('reject');
		expect(enforceCopilotPermission(policy, request({ kind: 'mcp', toolName: 'mcp__clopen__x' }))).toBeNull();
	});
});

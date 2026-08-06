import { describe, expect, test } from 'bun:test';
import { mapCopilotToolName } from './copilot/message-converter';
import { canonicaliseToolName as mapQwenToolName } from './qwen/message-converter';

describe('multi-agent coordination tool mappings', () => {
	test('maps Qwen send_message', () => {
		expect(mapQwenToolName('send_message')).toBe('SendMessage');
	});

	test('maps Copilot coordination tools', () => {
		expect(mapCopilotToolName('write_agent')).toBe('SendMessage');
		expect(mapCopilotToolName('list_agents')).toBe('ListAgents');
		expect(mapCopilotToolName('read_agent')).toBe('ReadAgent');
		expect(mapCopilotToolName('send_inbox')).toBe('SendInbox');
		expect(mapCopilotToolName('context_board')).toBe('ContextBoard');
	});
});

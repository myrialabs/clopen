import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, TextPart } from '@opencode-ai/sdk';

import { convertPendingTextParts } from './message-converter';

const sessionId = 'session-1';
const messageId = 'message-1';

const assistantMessage: AssistantMessage = {
	id: messageId,
	sessionID: sessionId,
	role: 'assistant',
	time: { created: 1 },
	parentID: 'user-1',
	modelID: 'model-1',
	providerID: 'provider-1',
	mode: 'build',
	path: { cwd: '/project', root: '/project' },
	cost: 0,
	tokens: {
		input: 0,
		output: 0,
		reasoning: 0,
		cache: { read: 0, write: 0 },
	},
};

function textPart(id: string, text: string): TextPart {
	return {
		id,
		sessionID: sessionId,
		messageID: messageId,
		type: 'text',
		text,
	};
}

describe('convertPendingTextParts', () => {
	test('finalizes each text segment once across successive tool boundaries', () => {
		const emittedTextPartIds = new Set<string>();
		const parts: Part[] = [textPart('text-1', 'A3')];

		const beforeFirstTool = convertPendingTextParts(
			assistantMessage,
			parts,
			sessionId,
			emittedTextPartIds,
		);

		expect(beforeFirstTool).toHaveLength(1);
		expect(beforeFirstTool[0]).toMatchObject({
			type: 'assistant',
			content: [{ type: 'text', text: 'A3' }],
		});
		expect(emittedTextPartIds).toEqual(new Set(['text-1']));

		// The normal message finalizer sees the same accumulated parts later.
		expect(convertPendingTextParts(
			assistantMessage,
			parts,
			sessionId,
			emittedTextPartIds,
		)).toEqual([]);

		parts.push(textPart('text-2', 'A7'));
		const beforeSecondTool = convertPendingTextParts(
			assistantMessage,
			parts,
			sessionId,
			emittedTextPartIds,
		);

		expect(beforeSecondTool).toHaveLength(1);
		expect(beforeSecondTool[0]).toMatchObject({
			type: 'assistant',
			content: [{ type: 'text', text: 'A7' }],
		});
		expect(emittedTextPartIds).toEqual(new Set(['text-1', 'text-2']));
	});
});

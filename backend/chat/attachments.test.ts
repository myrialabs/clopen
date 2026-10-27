/**
 * The one attachment rule: what the model reads inline stays inline, anything
 * else lands in the session's folder and is named in the prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StreamRequest } from '$shared/types/unified';
import { registerModels } from '$shared/constants/engines';
import { base64Size, isNative, normalizeAttachments } from './attachments';

const VISION = { text: true, image: true, pdf: true, audio: false, video: false };
const TEXT_ONLY = { text: true, image: false, pdf: false, audio: false, video: false };

function model(id: string, input: typeof VISION) {
	return {
		engine: { type: 'codex', provider: 'openai', model: { id, name: id }, account: { id: 0, name: '' } },
		limit: { input: 0, output: 0 },
		modalities: { input, output: TEXT_ONLY },
		capabilities: { reasoning: false, tools: true, structuredOutput: false },
		cost: { input: 0, output: 0 }
	} as never;
}

function request(modelId: string, content: unknown[]): StreamRequest {
	return {
		projectPath: '/',
		projectId: 'p',
		chatSessionId: 's',
		prompt: { type: 'user', content } as never,
		engine: { type: 'codex', provider: 'openai', model: { id: modelId, name: modelId }, account: { id: 0, name: '' } },
		sender: { id: 'u', name: 'u' }
	};
}

const b64 = (text: string) => Buffer.from(text).toString('base64');

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'clopen-attach-'));
	registerModels('codex', [model('vision', VISION), model('text', TEXT_ONLY)]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('attachments', () => {
	it('knows what a model reads inline', () => {
		expect(isNative('image/png', VISION)).toBe(true);
		expect(isNative('application/pdf', VISION)).toBe(true);
		expect(isNative('image/png', TEXT_ONLY)).toBe(false);
		expect(isNative('text/csv', VISION)).toBe(false);
		expect(base64Size(b64('hello'))).toBe(5);
	});

	it('leaves a prompt alone when every file is native', async () => {
		const input = request('vision', [{ type: 'image', mediaType: 'image/png', data: b64('png'), title: 'a.png' }, { type: 'text', text: 'what is this' }]);
		expect(await normalizeAttachments(input, root)).toBe(input);
	});

	it('saves any other file into the session folder, ignored by git, and names it ahead of the text', async () => {
		const result = await normalizeAttachments(
			request('vision', [
				{ type: 'document', mediaType: 'text/csv', data: b64('a,b\n1,2'), title: 'data.csv' },
				{ type: 'text', text: 'summarise it' }
			]),
			root
		);
		const content = result.prompt.content as Array<{ type: string; text?: string }>;
		expect(content).toHaveLength(1);
		expect(content[0].type).toBe('text');
		const match = /saved at \.\/(\S+)\]/.exec(content[0].text!);
		expect(match).not.toBeNull();
		expect(readFileSync(join(root, match![1]), 'utf8')).toBe('a,b\n1,2');
		expect(content[0].text).toContain('"data.csv"');
		expect(content[0].text!.endsWith('summarise it')).toBe(true);
		expect(readFileSync(join(root, '.clopen', '.gitignore'), 'utf8')).toBe('*\n');
	});

	it('saves an image for a model that cannot see, and adds a text block when there was none', async () => {
		const result = await normalizeAttachments(request('text', [{ type: 'image', mediaType: 'image/png', data: b64('png'), title: 'shot.png' }]), root);
		const content = result.prompt.content as Array<{ type: string; text?: string }>;
		expect(content.map((block) => block.type)).toEqual(['text']);
		expect(content[0].text).toContain('shot.png');
		expect(existsSync(join(root, '.clopen', 'attachments'))).toBe(true);
	});
});

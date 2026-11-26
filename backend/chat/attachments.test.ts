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
import { base64Size, isNative, labelAttachments, normalizeAttachments } from './attachments';

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
		engine: { type: 'codex', provider: 'openai', model: { id: modelId, name: modelId }, account: { id: 0, name: '' } }
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

	it('leaves a prompt without attachments alone', async () => {
		const input = request('vision', [{ type: 'text', text: 'hello' }]);
		expect(await normalizeAttachments(input, root)).toBe(input);
	});

	it('keeps native files inline and numbers every attachment in order', async () => {
		const result = await normalizeAttachments(
			request('vision', [
				{ type: 'image', mediaType: 'image/png', data: b64('png'), title: 'a.png' },
				{ type: 'document', mediaType: 'text/csv', data: b64('a,b'), title: 'b.csv' },
				{ type: 'text', text: 'what is this' }
			]),
			root
		);
		const content = result.prompt.content as Array<{ type: string; index?: number }>;
		expect(content.map((block) => [block.type, block.index])).toEqual([['image', 1], ['file', 2], ['text', undefined]]);
	});

	it('saves any other file into the session folder, ignored by git, and keeps where it went', async () => {
		const result = await normalizeAttachments(
			request('vision', [
				{ type: 'document', mediaType: 'text/csv', data: b64('a,b\n1,2'), title: 'data.csv' },
				{ type: 'text', text: 'summarise it' }
			]),
			root
		);
		const content = result.prompt.content as Array<{ type: string; path?: string; title?: string; size?: number; text?: string }>;
		expect(content.map((block) => block.type)).toEqual(['file', 'text']);
		expect(content[0].path!.startsWith(join(root, '.clopen', 'attachments'))).toBe(true);
		expect(readFileSync(content[0].path!, 'utf8')).toBe('a,b\n1,2');
		expect(content[0].title).toBe('data.csv');
		expect(content[0].size).toBe(7);
		expect(content[1].text).toBe('summarise it');
		expect(readFileSync(join(root, '.clopen', '.gitignore'), 'utf8')).toBe('*\n');
	});

	it('saves an image for a model that cannot see', async () => {
		const result = await normalizeAttachments(request('text', [{ type: 'image', mediaType: 'image/png', data: b64('png'), title: 'shot.png' }]), root);
		const content = result.prompt.content as Array<{ type: string; title?: string }>;
		expect(content.map((block) => block.type)).toEqual(['file']);
		expect(content[0].title).toBe('shot.png');
		expect(existsSync(join(root, '.clopen', 'attachments'))).toBe(true);
	});

	it('labels every attachment with its number for the engine', () => {
		const labelled = labelAttachments(
			[
				{ type: 'image', mediaType: 'image/png', data: b64('png'), title: 'a.png', index: 1 },
				{ type: 'file', mediaType: 'text/csv', title: 'b.csv', size: 3, path: join(root, '.clopen', 'attachments', 'b.csv'), index: 2 },
				{ type: 'text', text: 'compare @1 with @2' }
			],
			root
		);
		expect(labelled.map((block) => block.type)).toEqual(['text', 'image', 'text', 'text']);
		expect((labelled[0] as { text: string }).text).toBe('[Attachment @1: "a.png" (image/png, 3 B)]');
		expect((labelled[2] as { text: string }).text).toBe('[Attachment @2: "b.csv" (text/csv, 3 B), saved at ./.clopen/attachments/b.csv]');
	});

	it('leaves messages from before numbering as they were', () => {
		const content = [{ type: 'image' as const, mediaType: 'image/png', data: b64('png') }, { type: 'text' as const, text: 'hi' }];
		expect(labelAttachments(content, root)).toBe(content);
	});
});

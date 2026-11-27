/**
 * The one attachment rule: what the model reads inline stays inline, anything
 * else lands in the session's folder and is named in the prompt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StreamRequest } from '$shared/types/unified';
import { registerModels } from '$shared/constants/engines';
import { base64Size, CONTEXT_NOTE, isNative, labelAttachments, normalizeAttachments } from './attachments';
import { buildContextDocument, fileReferenceDocument } from '$shared/utils/context-document';
import type { FileBlock } from '$shared/types/unified';

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

	it('saves a mention snapshot and names what it is', async () => {
		const snapshot = buildContextDocument({
			kind: 'terminal',
			label: 'dev server',
			detail: '2 lines',
			capturedAt: '2026-11-27T10:00:00.000Z',
			sections: [{ title: 'Output', body: 'ready\nerror: port in use', fence: 'text' }]
		});
		const result = await normalizeAttachments(
			request('vision', [
				{ type: 'document', mediaType: 'text/markdown', data: b64(snapshot.text), title: snapshot.fileName },
				{ type: 'text', text: 'why does @1 fail' }
			]),
			root
		);
		const [file] = result.prompt.content as FileBlock[];
		expect(file.type).toBe('file');
		expect(file.index).toBe(1);
		expect(file.source).toEqual({ kind: 'terminal', label: 'dev server', detail: '2 lines', capturedAt: '2026-11-27T10:00:00.000Z' });
		expect(readFileSync(file.path, 'utf8')).toBe(snapshot.text);

		const labelled = labelAttachments(result.prompt.content as FileBlock[], root);
		expect((labelled[0] as { text: string }).text).toBe(CONTEXT_NOTE);
		expect((labelled[1] as { text: string }).text).toMatch(
			/^\[Attachment @1: terminal output "dev server" \(2 lines, captured 2026-11-27T10:00:00\.000Z\), saved at \.\/\.clopen\/attachments\/.+\.md\]$/
		);
	});

	it('points the engine at a mentioned project file rather than a copy', async () => {
		mkdirSync(join(root, 'src'), { recursive: true });
		writeFileSync(join(root, 'src', 'app.ts'), 'export {};\n');
		const reference = fileReferenceDocument('src/app.ts');
		const result = await normalizeAttachments(
			request('vision', [{ type: 'document', mediaType: 'text/markdown', data: b64(reference.text), title: reference.fileName }]),
			root
		);
		const [file] = result.prompt.content as FileBlock[];
		expect(file.path).toBe(join(root, 'src', 'app.ts'));
		expect(file.source?.kind).toBe('file');
		expect(existsSync(join(root, '.clopen', 'attachments'))).toBe(false);

		const labelled = labelAttachments([file], root);
		expect(labelled).toEqual([{ type: 'text', text: '[Attachment @1: project file "src/app.ts", at ./src/app.ts]' }]);
	});

	it('says so when a mentioned file is gone or outside the project', async () => {
		for (const path of ['src/missing.ts', '../outside.ts']) {
			const reference = fileReferenceDocument(path);
			const result = await normalizeAttachments(
				request('vision', [{ type: 'document', mediaType: 'text/markdown', data: b64(reference.text), title: reference.fileName }]),
				root
			);
			expect(result.prompt.content).toEqual([{ type: 'text', text: `[Attachment @1 "${path}" is no longer in the project.]` }]);
		}
	});
});

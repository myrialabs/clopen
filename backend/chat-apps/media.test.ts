/**
 * Files in a chat: what a message turns into for the prompt, and which
 * images of an answer are sent — only from the session's own folder.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { answerImages, promptContent, textOf } from './media';

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'clopen-media-'));
	writeFileSync(join(root, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a message from a chat', () => {
	it('reads text, a caption, a location and a contact as prompt text', () => {
		expect(textOf({ type: 'text', text: 'hi' })).toBe('hi');
		expect(textOf({ type: 'media', media_type: 'image', caption: 'look' })).toBe('look');
		expect(textOf({ type: 'location', lat: 1.5, lng: 2.5 })).toContain('1.5, 2.5');
		expect(textOf({ type: 'contact', name: 'Ana', phone: '+62' })).toContain('Ana +62');
	});

	it('puts files before the text, like the web composer, and keeps a file-only message', () => {
		const file = { type: 'image' as const, mediaType: 'image/png', data: 'AAAA', title: 'a.png' };
		expect(promptContent('what is it', [file]).map((block) => (block as { type: string }).type)).toEqual(['image', 'text']);
		expect(promptContent('', [file]).map((block) => (block as { type: string }).type)).toEqual(['image']);
		expect(promptContent('only text', [])).toEqual([{ type: 'text', text: 'only text' }]);
	});
});

describe('images in an answer', () => {
	it('sends a local image from the session folder and replaces its path with a marker', async () => {
		const { markdown, images } = await answerImages('Here it is:\n\n![Revenue](chart.png)\n\nDone.', root);
		expect(images).toHaveLength(1);
		expect(images[0]).toMatchObject({ filename: 'chart.png', mime: 'image/png', caption: 'Revenue' });
		expect(markdown).toContain('🖼️ Revenue');
		expect(markdown).not.toContain('chart.png)');
	});

	it('decodes a data URI', async () => {
		const { images } = await answerImages('![dot](data:image/png;base64,iVBORw0KGgo=)', root);
		expect(images[0]?.mime).toBe('image/png');
	});

	it('never reads an image from outside the session folder or the temp folder', async () => {
		const outside = join(homedir(), 'definitely-not-here.png');
		const { markdown, images } = await answerImages(`![x](${outside}) ![y](../../etc/passwd.png)`, root);
		expect(images).toHaveLength(0);
		expect(markdown).toContain(outside);
	});

	it('leaves a missing or non-image file as written', async () => {
		const { images } = await answerImages('![a](missing.png) ![b](notes.txt)', root);
		expect(images).toHaveLength(0);
	});
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { renderMarkdown, resolveLocalImageSrc } from './markdown-renderer';

// resolveLocalImageSrc consults window.location for same-host URLs; the rest of the module works
// without a DOM.
const hadWindow = 'window' in globalThis;

beforeAll(() => {
	(globalThis as { window?: unknown }).window = {
		location: { origin: 'http://localhost:9141', hostname: 'localhost' }
	};
});

afterAll(() => {
	if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

describe('resolveLocalImageSrc', () => {
	test('resolves bare absolute paths', () => {
		expect(resolveLocalImageSrc('/Users/me/shots/cover.png')).toBe('/Users/me/shots/cover.png');
		expect(resolveLocalImageSrc('/home/me/shots/cover.png')).toBe('/home/me/shots/cover.png');
	});

	test('resolves file:// URLs, decoding escapes', () => {
		expect(resolveLocalImageSrc('file:///Users/me/my%20shots/cover.png')).toBe(
			'/Users/me/my shots/cover.png'
		);
	});

	test('resolves same-host URLs that carry an absolute path', () => {
		expect(resolveLocalImageSrc('http://localhost:9141/Users/me/shots/cover.png')).toBe(
			'/Users/me/shots/cover.png'
		);
	});

	test('resolves Windows paths', () => {
		expect(resolveLocalImageSrc('C:\\Users\\me\\cover.png')).toBe('C:/Users/me/cover.png');
		expect(resolveLocalImageSrc('file:///C:/Users/me/cover.png')).toBe('C:/Users/me/cover.png');
	});

	test('leaves remote, inline and relative sources alone', () => {
		expect(resolveLocalImageSrc('https://example.com/cover.png')).toBeNull();
		expect(resolveLocalImageSrc('data:image/png;base64,AAAA')).toBeNull();
		expect(resolveLocalImageSrc('blob:http://localhost:9141/abc')).toBeNull();
		expect(resolveLocalImageSrc('evidence/cover.png')).toBeNull();
		expect(resolveLocalImageSrc('/assets/cover.png')).toBeNull();
		expect(resolveLocalImageSrc('')).toBeNull();
	});
});

describe('renderMarkdown images', () => {
	test('marks a local image instead of emitting a doomed src', () => {
		const html = renderMarkdown('![Cover](/Users/me/shots/cover.png)');
		expect(html).toContain('data-md-local-src="/Users/me/shots/cover.png"');
		expect(html).toContain('alt="Cover"');
		expect(html).not.toContain(' src=');
	});

	test('keeps a remote image src', () => {
		const html = renderMarkdown('![Cover](https://example.com/cover.png "Title")');
		expect(html).toContain('src="https://example.com/cover.png"');
		expect(html).toContain('title="Title"');
		expect(html).not.toContain('data-md-local-src');
	});
});

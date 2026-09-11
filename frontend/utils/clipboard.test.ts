/**
 * Clipboard fallback.
 *
 * The case that matters is the one the modern API cannot serve: Clopen reached
 * over plain HTTP, where `navigator.clipboard` is undefined because the origin
 * is not a secure context. That is a normal deployment here — a LAN address, a
 * VPS IP, a phone on the same network — so "copy silently does nothing" would
 * be the default experience rather than an edge case.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { copyText } from './clipboard';

const originalNavigator = globalThis.navigator;
const originalDocument = globalThis.document;

interface FakeDocument {
	execCommand: (command: string) => boolean;
	body: { appendChild: (node: unknown) => void; removeChild: (node: unknown) => void };
	createElement: () => Record<string, unknown>;
}

let copied: string | null = null;
let lastElement: Record<string, unknown> | null = null;

// Through `unknown`, because the real `document` type and this stub only
// overlap in the three members the helper actually touches.
function installFakeDocument(succeeds: boolean): void {
	copied = null;
	(globalThis as unknown as { document: FakeDocument }).document = {
		createElement: () => {
			const element: Record<string, unknown> = {
				value: '',
				style: {},
				setAttribute: () => {},
				select: () => {
					copied = element.value as string;
				},
				setSelectionRange: () => {}
			};
			lastElement = element;
			return element;
		},
		execCommand: () => succeeds,
		body: { appendChild: () => {}, removeChild: () => {} }
	};
}

beforeEach(() => {
	lastElement = null;
});

afterEach(() => {
	(globalThis as { navigator?: unknown }).navigator = originalNavigator;
	(globalThis as { document?: unknown }).document = originalDocument;
});

describe('copyText', () => {
	it('uses the Clipboard API when it is available', async () => {
		let written = '';
		(globalThis as { navigator?: unknown }).navigator = {
			clipboard: {
				writeText: async (text: string) => {
					written = text;
				}
			}
		};
		installFakeDocument(true);

		expect(await copyText('https://example.com/1')).toBe(true);
		expect(written).toBe('https://example.com/1');
		// The fallback must not also run — two copies race for the clipboard.
		expect(lastElement).toBeNull();
	});

	it('falls back when the Clipboard API is absent', async () => {
		// Exactly what a non-secure origin looks like: the property is missing,
		// so reading through it would be a TypeError rather than a rejection.
		(globalThis as { navigator?: unknown }).navigator = {};
		installFakeDocument(true);

		expect(await copyText('ghp_secret_link')).toBe(true);
		expect(copied).toBe('ghp_secret_link');
	});

	it('falls back when the Clipboard API rejects', async () => {
		(globalThis as { navigator?: unknown }).navigator = {
			clipboard: {
				writeText: async () => {
					throw new Error('Document is not focused');
				}
			}
		};
		installFakeDocument(true);

		expect(await copyText('retry me')).toBe(true);
		expect(copied).toBe('retry me');
	});

	it('reports failure rather than claiming success', async () => {
		(globalThis as { navigator?: unknown }).navigator = {};
		installFakeDocument(false);

		expect(await copyText('nope')).toBe(false);
	});

	it('refuses empty text without touching the document', async () => {
		(globalThis as { navigator?: unknown }).navigator = {};
		installFakeDocument(true);

		expect(await copyText('')).toBe(false);
		expect(lastElement).toBeNull();
	});
});

import { describe, expect, it } from 'bun:test';
import {
	buildContextDocument,
	contextFileSlug,
	countLines,
	readContextHeader,
	readContextHeaderFromBase64,
	textToBase64
} from './context-document';

describe('context documents', () => {
	it('carry what they are in their first line', () => {
		const document = buildContextDocument({
			kind: 'git-commit',
			label: 'fix: stop the  leak\n',
			detail: 'abc123',
			capturedAt: '2026-11-27T00:00:00.000Z',
			facts: [['Commit', 'abc123'], ['Empty', null]],
			sections: [{ title: 'Commit', body: 'diff --git a b', fence: 'diff' }]
		});
		expect(document.fileName).toBe('git-commit-fix-stop-the-leak.md');
		expect(document.source).toEqual({ kind: 'git-commit', label: 'fix: stop the leak', detail: 'abc123', capturedAt: '2026-11-27T00:00:00.000Z' });
		expect(readContextHeader(document.text)).toEqual(document.source);
		expect(document.text).toContain('# Git commit: fix: stop the leak');
		expect(document.text).toContain('- Commit: abc123');
		expect(document.text).not.toContain('Empty');
		expect(document.text).toContain('```diff\ndiff --git a b\n```');
	});

	it('survive a label that would end the comment and a body that holds a fence', () => {
		const document = buildContextDocument({ kind: 'note', label: 'a --> b', sections: [{ body: '```js\nx\n```', fence: 'md' }] });
		expect(document.text.split('\n')[0].endsWith(' -->')).toBe(true);
		expect(document.text.split('\n')[0].indexOf('-->')).toBe(document.text.split('\n')[0].length - 3);
		expect(readContextHeader(document.text)?.label).toBe('a --> b');
		expect(document.text).toContain('````md\n```js\nx\n```\n````');
	});

	it('are told apart from any other file by their bytes', () => {
		const document = buildContextDocument({ kind: 'terminal', label: 'Ünïcode tab', sections: [{ body: 'x'.repeat(20_000) }] });
		expect(readContextHeaderFromBase64(textToBase64(document.text), 'text/markdown')?.label).toBe('Ünïcode tab');
		expect(readContextHeaderFromBase64(textToBase64('# just notes'), 'text/markdown')).toBeNull();
		expect(readContextHeaderFromBase64(textToBase64(document.text), 'image/png')).toBeNull();
		expect(readContextHeader('<!-- clopen-context {"kind":"nope","label":"x"} -->')).toBeNull();
	});

	it('name files and lines the way people read them', () => {
		expect(contextFileSlug('  ')).toBe('context');
		expect(contextFileSlug('src/App.svelte:10-20')).toBe('src-app-svelte-10-20');
		expect(countLines('')).toBe('0 lines');
		expect(countLines('a\n')).toBe('1 line');
		expect(countLines('a\nb\nc')).toBe('3 lines');
	});
});

import { describe, expect, test } from 'bun:test';

import { isAppRelease, parseChangeLine, parseReleaseBody, toReleaseNote } from './release-notes';

const GENERATED_BODY = [
	"## What's Changed",
	'* fix(db): stop message saves from stalling the whole server by @someone in https://github.com/myrialabs/clopen/pull/582',
	'* feat(chat): mention workspace context with @ by @someone in https://github.com/myrialabs/clopen/pull/595',
	'* perf(preview): encode frames on the GPU by @someone in https://github.com/myrialabs/clopen/pull/590',
	'* chore: bump dependencies by @some-bot in https://github.com/myrialabs/clopen/pull/591',
	'* feat(api)!: drop the v1 endpoints by @someone in https://github.com/myrialabs/clopen/pull/592',
	'',
	'## New Contributors',
	'* @newcomer made their first contribution in https://github.com/myrialabs/clopen/pull/590',
	'',
	'',
	'**Full Changelog**: https://github.com/myrialabs/clopen/compare/v0.4.49...v0.4.50'
].join('\r\n');

describe('parseChangeLine', () => {
	test('reads type, scope, summary and pull request, dropping the author', () => {
		expect(parseChangeLine('* fix(db): stop message saves by @someone in https://github.com/myrialabs/clopen/pull/582')).toEqual({
			kind: 'fix',
			scope: 'db',
			summary: 'Stop message saves',
			breaking: false,
			pullUrl: 'https://github.com/myrialabs/clopen/pull/582',
			pullNumber: 582
		});
	});

	test('keeps a line without a conventional prefix as an "other" change', () => {
		expect(parseChangeLine('- Update README by @someone in https://github.com/myrialabs/clopen/pull/7')).toEqual({
			kind: 'other',
			summary: 'Update README',
			breaking: false,
			pullUrl: 'https://github.com/myrialabs/clopen/pull/7',
			pullNumber: 7
		});
	});

	test('keeps a hand-written bullet with no author or link', () => {
		expect(parseChangeLine('* feat: a faster start')).toEqual({ kind: 'feature', summary: 'A faster start', breaking: false });
	});

	test('marks breaking changes', () => {
		expect(parseChangeLine('* feat(api)!: drop the v1 endpoints')?.breaking).toBe(true);
	});

	test('does not mistake a colon inside the summary for a type', () => {
		expect(parseChangeLine('* Note: this is plain text')).toEqual({ kind: 'other', summary: 'Note: this is plain text', breaking: false });
	});
});

describe('parseReleaseBody', () => {
	test('turns a generated body into changes and contributors with nothing left over', () => {
		const parsed = parseReleaseBody(GENERATED_BODY);
		expect(parsed.changes.map(change => [change.kind, change.scope, change.pullNumber])).toEqual([
			['fix', 'db', 582],
			['feature', 'chat', 595],
			['improvement', 'preview', 590],
			['other', undefined, 591],
			['feature', 'api', 592]
		]);
		expect(parsed.changes[1].summary).toBe('Mention workspace context with @');
		expect(parsed.newContributors).toEqual(['newcomer']);
		expect(parsed.notes).toBe('');
	});

	test('keeps hand-written sections as markdown notes', () => {
		const parsed = parseReleaseBody([
			'## Highlights',
			'Clopen now restarts itself after an update.',
			'',
			"## What's Changed",
			'* fix(server): keep the port by @someone in https://github.com/myrialabs/clopen/pull/600'
		].join('\n'));
		expect(parsed.notes).toBe('## Highlights\nClopen now restarts itself after an update.');
		expect(parsed.changes).toHaveLength(1);
	});

	test('an empty body has no changes', () => {
		expect(parseReleaseBody('')).toEqual({ changes: [], newContributors: [], notes: '' });
	});
});

describe('toReleaseNote', () => {
	test('strips the tag prefix into a plain version', () => {
		const note = toReleaseNote({
			tag_name: 'v0.4.50',
			html_url: 'https://github.com/myrialabs/clopen/releases/tag/v0.4.50',
			published_at: '2026-11-18T12:12:26Z',
			body: null,
			draft: false,
			prerelease: false
		});
		expect(note.version).toBe('0.4.50');
		expect(note.tagName).toBe('v0.4.50');
		expect(note.changes).toEqual([]);
	});
});

describe('isAppRelease', () => {
	test('accepts app versions and rejects asset releases, drafts and pre-releases', () => {
		expect(isAppRelease({ tag_name: 'v0.4.50', draft: false, prerelease: false })).toBe(true);
		expect(isAppRelease({ tag_name: 'embedding-v0.0.1', draft: false, prerelease: false })).toBe(false);
		expect(isAppRelease({ tag_name: 'v0.5.0', draft: true, prerelease: false })).toBe(false);
		expect(isAppRelease({ tag_name: 'v0.5.0-beta.1', draft: false, prerelease: true })).toBe(false);
	});
});

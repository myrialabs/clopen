/**
 * Listing with a date range.
 *
 * The provider sorts by update time, newest first, and offers no "until"
 * parameter. Applying that end date to the page AFTER it was fetched asked a
 * question with an obvious wrong answer — "of the fifty most recently updated
 * items, which are older than last week?" — and any range not ending today
 * produced an empty list while matching items sat on the next page.
 *
 * These tests drive `list()` against a stubbed API so the paging behaviour is
 * pinned: a range in the past finds its items, and a range whose start has been
 * passed stops asking for more pages.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { githubWorkAdapter } from './adapter';
import type { WorkContext } from '../../types';

interface Row {
	number: number;
	updated_at: string;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function issue(row: Row) {
	return {
		id: row.number,
		number: row.number,
		title: `Item ${row.number}`,
		body: '',
		html_url: `https://github.com/acme/web/pull/${row.number}`,
		state: 'open',
		labels: [],
		assignees: [],
		user: { login: 'someone' },
		created_at: row.updated_at,
		updated_at: row.updated_at
	};
}

/** Serve `pages` in order, recording every URL asked for. */
function stubPages(pages: Row[][]): { urls: string[] } {
	const urls: string[] = [];

	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = String(input);
		urls.push(url);
		const page = Number(new URL(url).searchParams.get('page') ?? '1');
		const rows = pages[page - 1] ?? [];
		const hasNext = page < pages.length;

		return new Response(JSON.stringify(rows.map(issue)), {
			status: 200,
			headers: {
				'content-type': 'application/json',
				...(hasNext && {
					link: `<https://api.github.com/repos/acme/web/pulls?page=${page + 1}>; rel="next"`
				})
			}
		});
	}) as typeof fetch;

	return { urls };
}

const context = {
	projectId: 'p1',
	account: {} as WorkContext['account'],
	credentials: { token: 'test-token' },
	binding: {
		locator: 'acme/web',
		detected: true,
		defaultBranch: 'main',
		config: { transitionOnStartWork: null, transitionOnPrOpen: null, branchTemplate: '' }
	}
} as WorkContext;

/** A local date string the way the picker produces one. */
function day(offsetDays: number): string {
	const date = new Date();
	date.setDate(date.getDate() + offsetDays);
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, '0'),
		String(date.getDate()).padStart(2, '0')
	].join('-');
}

function at(offsetDays: number): string {
	const date = new Date();
	date.setDate(date.getDate() + offsetDays);
	date.setHours(12, 0, 0, 0);
	return date.toISOString();
}

describe('list with a from/to range', () => {
	it('reaches a range that sits behind pages of newer activity', async () => {
		// Seven pages of items newer than the range, then the matches. Five pages
		// of budget — what an unranged list gets — stops short of them, which is
		// what made every range older than a few days come back empty.
		const newer = Array.from({ length: 7 }, (_unused, index) => [
			{ number: 900 - index, updated_at: at(-1) }
		]);
		stubPages([
			...newer,
			[{ number: 42, updated_at: at(-6) }, { number: 41, updated_at: at(-7) }]
		]);

		const page = await githubWorkAdapter.list(context, {
			kind: 'pull-request',
			state: 'all',
			mineOnly: false,
			since: day(-8),
			until: day(-5)
		});

		expect(page.items.map((item) => item.identifier)).toEqual(['42', '41']);
	});

	it('includes items updated on the last day of the range', async () => {
		stubPages([[{ number: 7, updated_at: at(-3) }]]);

		const page = await githubWorkAdapter.list(context, {
			kind: 'pull-request',
			state: 'all',
			mineOnly: false,
			since: day(-3),
			until: day(-3)
		});

		expect(page.items.map((item) => item.identifier)).toEqual(['7']);
	});

	it('stops paging once a page runs past the start of the range', async () => {
		const { urls } = stubPages([
			[{ number: 90, updated_at: at(-1) }],
			[{ number: 42, updated_at: at(-6) }, { number: 5, updated_at: at(-40) }],
			[{ number: 1, updated_at: at(-90) }]
		]);

		const page = await githubWorkAdapter.list(context, {
			kind: 'pull-request',
			state: 'all',
			mineOnly: false,
			since: day(-8),
			until: day(-5)
		});

		expect(page.items.map((item) => item.identifier)).toEqual(['42']);
		// Page three is older than the range's start and is never requested.
		expect(urls.some((url) => url.includes('page=3'))).toBe(false);
		expect(page.hasMore).toBe(false);
	});
});

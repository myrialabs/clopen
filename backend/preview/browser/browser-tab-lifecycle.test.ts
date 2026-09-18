/**
 * What may run, and what may not.
 *
 * The rules under test are the ones whose failure is invisible until it is
 * expensive: a tab nobody is watching that keeps a renderer busy, or — far
 * worse — a tab someone *is* watching that gets frozen underneath them.
 */

// Read before the profile is first asked for, so the budget under test is the
// low-spec one rather than whatever machine happens to run the suite.
process.env.CLOPEN_PREVIEW_QUALITY = 'low';

import { afterEach, describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { BrowserTabLifecycle } from './browser-tab-lifecycle';

const GRACE_MS = 20;

/** Records every lifecycle command the page was sent. */
interface FakePage {
	page: Page;
	states: string[];
	closed: boolean;
}

function fakePage(options: { failFreeze?: boolean } = {}): FakePage {
	const record: FakePage = { page: null as unknown as Page, states: [], closed: false };

	const cdp = {
		send: async (method: string, params?: { state?: string }) => {
			if (method !== 'Page.setWebLifecycleState') return {};
			const state = params?.state ?? '';
			if (options.failFreeze && state === 'frozen') {
				throw new Error('cannot freeze');
			}
			record.states.push(state);
			return {};
		},
		detach: async () => {}
	};

	record.page = {
		isClosed: () => record.closed,
		createCDPSession: async () => cdp
	} as unknown as Page;

	return record;
}

function settle(ms = GRACE_MS * 3): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lifecycles built by a test, torn down after it.
 *
 * Their timers outlive the test that made them, and a stray freeze landing
 * during the next one is how a suite starts reporting on the wrong tabs.
 */
const built: BrowserTabLifecycle[] = [];

afterEach(async () => {
	await Promise.all(built.splice(0).map((lifecycle) => lifecycle.cleanup()));
});

function lifecycleOver(
	pages: Record<string, FakePage>,
	pinned: Set<string> = new Set()
): BrowserTabLifecycle {
	const lifecycle = new BrowserTabLifecycle({
		getPage: (tabId) => pages[tabId]?.page ?? null,
		isPinned: (tabId) => pinned.has(tabId),
		freezeAfterMs: GRACE_MS
	});
	built.push(lifecycle);
	return lifecycle;
}

describe('a preview tab nobody is watching', () => {
	test('is frozen once the grace has passed', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		expect(pages.a.states).toEqual([]);

		await settle();

		expect(pages.a.states).toEqual(['frozen']);
		expect(lifecycle.isFrozen('a')).toBe(true);
	});

	test('wakes on demand, and says so', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages);
		const announced: boolean[] = [];
		lifecycle.on('state', ({ state }: { state: string }) => announced.push(state === 'frozen'));

		lifecycle.register('a');
		await settle();
		await lifecycle.ensureAwake('a');

		expect(pages.a.states).toEqual(['frozen', 'active']);
		expect(lifecycle.isFrozen('a')).toBe(false);
		expect(announced).toEqual([true, false]);
	});

	test('stops being asked once the page has refused enough times', async () => {
		const pages = { a: fakePage({ failFreeze: true }) };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		await settle(GRACE_MS * 12);

		// Three attempts, all refused, and then left alone — never reported as
		// asleep, because it is still running.
		expect(pages.a.states).toEqual([]);
		expect(lifecycle.isFrozen('a')).toBe(false);
	});
});

describe('a preview tab someone is using', () => {
	test('is never frozen while a viewer is attached', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		lifecycle.attachViewer('a', 'viewer-1');
		await settle();

		expect(pages.a.states).toEqual([]);
		expect(lifecycle.hasViewers('a')).toBe(true);
	});

	test('freezes only after the last viewer leaves', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		lifecycle.attachViewer('a', 'laptop');
		lifecycle.attachViewer('a', 'phone');
		lifecycle.detachViewer('a', 'laptop');
		await settle();

		expect(pages.a.states).toEqual([]);

		lifecycle.detachViewer('a', 'phone');
		await settle();

		expect(pages.a.states).toEqual(['frozen']);
	});

	test('is never frozen while an agent holds it', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages, new Set(['a']));

		lifecycle.register('a');
		await settle();

		expect(pages.a.states).toEqual([]);
	});

	test('counts a viewer with the preview off screen as gone', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		lifecycle.attachViewer('a', 'viewer-1');
		lifecycle.setViewerVisible('a', 'viewer-1', false);
		await settle();

		expect(pages.a.states).toEqual(['frozen']);
	});
});

describe('the host budget', () => {
	test('reclaims idle tabs beyond it, oldest first', async () => {
		const pages = { a: fakePage(), b: fakePage(), c: fakePage() };
		const lifecycle = lifecycleOver(pages);

		// Registered in order, so `a` is the least recently awake of the three.
		lifecycle.register('a');
		lifecycle.register('b');
		lifecycle.register('c');

		// A viewer arriving is what makes the budget count the room. The low
		// tier allows two awake pages; `a` is the one that has to go.
		lifecycle.attachViewer('c', 'viewer-1');
		await settle();

		expect(pages.a.states).toEqual(['frozen']);
		expect(pages.c.states).toEqual([]);
	});

	test('never counts a watched tab out of existence', async () => {
		const pages = { a: fakePage(), b: fakePage(), c: fakePage() };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		lifecycle.register('b');
		lifecycle.register('c');
		lifecycle.attachViewer('a', 'one');
		lifecycle.attachViewer('b', 'two');
		lifecycle.attachViewer('c', 'three');

		await settle();

		// Three watched tabs on a two-tab budget: every one of them is still
		// running, because freezing one would blank a preview on screen.
		expect(pages.a.states).toEqual([]);
		expect(pages.b.states).toEqual([]);
		expect(pages.c.states).toEqual([]);
	});
});

describe('a tab whose page went away', () => {
	test('is treated as awake rather than frozen', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		pages.a.closed = true;
		await settle();

		expect(pages.a.states).toEqual([]);
		expect(lifecycle.isFrozen('a')).toBe(false);
	});

	test('starts over awake once its page is rebuilt', async () => {
		const pages = { a: fakePage() };
		const lifecycle = lifecycleOver(pages);

		lifecycle.register('a');
		await settle();
		expect(lifecycle.isFrozen('a')).toBe(true);

		lifecycle.rebind('a');
		expect(lifecycle.isFrozen('a')).toBe(false);
	});
});

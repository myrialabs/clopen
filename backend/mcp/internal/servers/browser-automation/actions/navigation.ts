/**
 * Navigation and synchronisation.
 *
 * `wait_for` lives here rather than with the input gestures because it is not
 * a gesture: it is how a batch stays honest about the page having caught up.
 */

import { z } from 'zod';
import { sleep } from '$shared/utils/async';
import type { ActionDef } from './types';
import { commonFields } from './shared';

export const navigate: ActionDef = {
	type: 'navigate',
	kind: 'control',
	doc: `navigate {url} — load a URL in the current tab.
  Following a link you already have the href for is cheaper and far more reliable than clicking it. Session state (cookies, storage) is kept.`,
	schema: z.object({
		type: z.literal('navigate'),
		url: z.string().url().describe('Target URL including protocol. Redirects are followed.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		// Goes through the service, not page.goto: the service is what records
		// the navigation, re-reads title/favicon and re-baselines history, which
		// is what keeps the toolbar and tab strip truthful.
		const finalUrl = await ctx.service.navigateTab(ctx.tab.id, args.url);
		await sleep(300);
		return { summary: `→ ${finalUrl}` };
	}
};

export const goBack: ActionDef = {
	type: 'go_back',
	kind: 'control',
	doc: `go_back {steps?} — walk back through the tab's history.`,
	schema: z.object({
		type: z.literal('go_back'),
		steps: z.number().int().min(1).optional().describe('How many entries (default: 1).'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const moved = await ctx.service.goHistory(ctx.tab.id, -(args.steps ?? 1));
		if (!moved) throw new Error('Nothing to go back to');
		await sleep(300);
		return { summary: `← ${ctx.service.getTab(ctx.tab.id)?.url ?? ''}` };
	}
};

export const goForward: ActionDef = {
	type: 'go_forward',
	kind: 'control',
	doc: `go_forward {steps?} — walk forward through the tab's history.`,
	schema: z.object({
		type: z.literal('go_forward'),
		steps: z.number().int().min(1).optional().describe('How many entries (default: 1).'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const moved = await ctx.service.goHistory(ctx.tab.id, args.steps ?? 1);
		if (!moved) throw new Error('Nothing to go forward to');
		await sleep(300);
		return { summary: `→ ${ctx.service.getTab(ctx.tab.id)?.url ?? ''}` };
	}
};

export const reload: ActionDef = {
	type: 'reload',
	kind: 'control',
	doc: `reload {hard?} — reload the page. hard bypasses the cache.`,
	schema: z.object({
		type: z.literal('reload'),
		hard: z.boolean().optional().describe('Ignore the cache.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		if (args.hard) {
			await ctx.tab.page.evaluate(() => window.location.reload());
		} else {
			await ctx.tab.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
		}
		await sleep(300);
		return { summary: ctx.tab.page.url() };
	}
};

export const waitFor: ActionDef = {
	type: 'wait_for',
	kind: 'control',
	doc: `wait_for {selector|text|urlContains|state, timeout?} — wait for the page to catch up.
  Returns the moment the condition holds, so it costs only what it has to.
  state: visible (default, with selector/text) · hidden · navigation · networkIdle.
  Reach for this instead of wait{ms} — a fixed delay is either too short and the batch fails, or too long and every run pays for it.`,
	schema: z.object({
		type: z.literal('wait_for'),
		selector: z.string().optional().describe('Wait for this CSS selector.'),
		text: z.string().optional().describe('Wait for this text to appear on the page.'),
		urlContains: z.string().optional().describe('Wait until the URL contains this substring.'),
		state: z.enum(['visible', 'hidden', 'navigation', 'networkIdle']).optional().describe('What to wait for (default: visible).'),
		timeout: z.number().optional().describe('Milliseconds before giving up (default: 10000).'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const timeout = args.timeout ?? 10_000;
		const page = ctx.tab.page;
		const started = Date.now();
		const took = () => `${Date.now() - started}ms`;

		if (args.state === 'navigation') {
			await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout });
			return { summary: `navigated in ${took()} → ${page.url()}` };
		}

		if (args.state === 'networkIdle') {
			await page.waitForNetworkIdle({ timeout }).catch(() => {
				throw new Error(`Network did not settle within ${timeout}ms`);
			});
			return { summary: `network idle in ${took()}` };
		}

		if (args.urlContains) {
			await page.waitForFunction(
				(needle: string) => window.location.href.includes(needle),
				{ timeout, polling: 200 },
				args.urlContains
			);
			return { summary: `url matched in ${took()} → ${page.url()}` };
		}

		if (args.selector) {
			await page.waitForSelector(args.selector, {
				timeout,
				visible: args.state !== 'hidden',
				hidden: args.state === 'hidden'
			});
			return { summary: `"${args.selector}" ${args.state ?? 'visible'} in ${took()}` };
		}

		if (args.text) {
			const shouldVanish = args.state === 'hidden';
			await page.waitForFunction(
				(needle: string, gone: boolean) => {
					const present = (document.body?.innerText ?? '').includes(needle);
					return gone ? !present : present;
				},
				{ timeout, polling: 200 },
				args.text,
				shouldVanish
			);
			return { summary: `text ${shouldVanish ? 'gone' : 'present'} in ${took()}` };
		}

		throw new Error('wait_for needs one of: selector, text, urlContains, or state');
	}
};

export const navigationActions: ActionDef[] = [navigate, goBack, goForward, reload, waitFor];

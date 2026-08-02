/**
 * Console: reading what the page logged, and running code in it.
 */

import { z } from 'zod';
import type { ActionDef } from './types';
import { commonFields } from './shared';

export const consoleLogs: ActionDef = {
	type: 'console_logs',
	kind: 'control',
	doc: `console_logs {limit?, level?} — the page's console output, oldest first.
  Where to look when an action "worked" but the page did not react: the error is usually here and invisible on screen.`,
	schema: z.object({
		type: z.literal('console_logs'),
		limit: z.number().int().min(1).max(200).optional().describe('How many entries (default: 20).'),
		level: z.enum(['log', 'info', 'warn', 'error', 'debug']).optional().describe('Only this level.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const all = ctx.service.getConsoleLogs(ctx.tab.id);
		const filtered = args.level ? all.filter((log) => log.type === args.level) : all;

		if (filtered.length === 0) return { summary: 'no console output' };

		const limit = args.limit ?? 20;
		const shown = filtered.slice(-limit);
		const lines = shown.map((log) => {
			const time = new Date(log.timestamp).toLocaleTimeString();
			return `[${time}] ${log.type.toUpperCase().padEnd(5)} ${log.text}`;
		});

		return { summary: `${shown.length} of ${filtered.length} entries`, detail: lines.join('\n') };
	}
};

export const clearConsole: ActionDef = {
	type: 'clear_console',
	kind: 'control',
	doc: `clear_console {} — drop stored console output.
  Put this before the step you are debugging so what follows is only that step's output.`,
	schema: z.object({ type: z.literal('clear_console'), ...commonFields }),
	run: async (_args, ctx) => {
		if (!ctx.service.clearConsoleLogs(ctx.tab.id)) throw new Error('Could not clear console logs');
		return { summary: 'cleared' };
	}
};

export const evaluate: ActionDef = {
	type: 'eval',
	kind: 'control',
	doc: `eval {expression} — run JavaScript in the page and return the result.
  For state that is not in the DOM: computed styles, localStorage, framework internals, window globals. The result must be JSON-serialisable.`,
	schema: z.object({
		type: z.literal('eval'),
		expression: z.string().min(1).describe('JavaScript expression, e.g. document.title or localStorage.getItem("token").'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const result = await ctx.service.executeConsoleCommand(ctx.tab.id, args.expression);
		return { summary: args.expression, detail: JSON.stringify(result, null, 2) };
	}
};

export const consoleActions: ActionDef[] = [consoleLogs, clearConsole, evaluate];

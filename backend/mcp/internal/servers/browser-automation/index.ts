/**
 * Browser Automation — internal MCP server.
 *
 * One tool. Every capability is an action inside it, so the agent decides what
 * to run and how much to run at once, and a whole interaction can be a single
 * call instead of a round trip per click.
 */

import { defineServer } from '../helper';
import { actionsToolDescription } from './description';
import { actionsToolSchema } from './schema';
import { runActions } from './runner';
import { formatReport } from './format';

export default defineServer({
	name: 'browser-automation',
	title: 'Browser Automation',
	description:
		'Drives the built-in Preview Browser — navigate, click, type, drag, swipe and inspect pages, batching whole interactions into a single call.',
	version: '2.0.0',
	tools: {
		actions: {
			description: actionsToolDescription,
			schema: actionsToolSchema,
			handler: async (args) => {
				try {
					const report = await runActions(args as any);
					return formatReport(report);
				} catch (error) {
					// Nothing ran: no project context, no tab, no browser. The batch
					// never started, so there is no partial report to render.
					return {
						content: [
							{
								type: 'text' as const,
								text: `Browser actions failed before starting: ${error instanceof Error ? error.message : 'Unknown error'}`
							}
						],
						isError: true
					};
				}
			}
		}
	}
});

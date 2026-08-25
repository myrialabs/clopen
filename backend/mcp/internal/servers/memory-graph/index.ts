/**
 * Memory Graph — internal MCP server.
 *
 * One tool. Every capability is an operation inside it, so recalling a memory and
 * then walking its neighbours can be one call instead of a round trip each, and
 * the whole surface fits in a single description the agent reads once.
 *
 * Exposed through the existing Streamable HTTP endpoint
 * (`backend/mcp/internal/remote-server.ts`), which is what makes the graph
 * agent-agnostic for free: every engine that can consume an MCP URL reaches the
 * same store, with no per-engine work.
 */

import { defineServer } from '../helper';
import { memoryToolDescription } from './description';
import { memoryToolSchema } from './schema';
import { runMemoryOperations } from './runner';
import { formatReport } from './format';

export default defineServer({
	name: 'memory-graph',
	title: 'Memory Graph',
	description:
		'Persistent memory shared by every engine — past decisions, patterns and failures, plus the code they attach to, searchable across every project.',
	version: '1.0.0',
	tools: {
		memory: {
			description: memoryToolDescription,
			schema: memoryToolSchema,
			handler: async (args) => {
				try {
					const report = await runMemoryOperations(args as Parameters<typeof runMemoryOperations>[0]);
					return formatReport(report);
				} catch (error) {
					// Nothing ran: the batch never started, so there is no partial report
					// to render.
					return {
						content: [
							{
								type: 'text' as const,
								text: `Memory Graph call failed before starting: ${
									error instanceof Error ? error.message : 'Unknown error'
								}`
							}
						],
						isError: true
					};
				}
			}
		}
	}
});

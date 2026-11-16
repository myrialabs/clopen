/**
 * The assistant sits in an import cycle by nature: the stream manager loads
 * the engines, the engines load the MCP registry, the registry loads the
 * `control` server, and its actions load the missions — which listen to the
 * stream manager. That is fine as long as nothing on the cycle uses an import
 * at module load. This loads the whole graph the way the server does and
 * checks the pieces that are built from it.
 */

import { describe, expect, it } from 'bun:test';

describe('loading the backend with the assistant in it', () => {
	it('loads the WebSocket router with the assistant routes registered', async () => {
		const { wsRouter } = await import('$backend/ws');
		const routes = wsRouter.describeRoutes().map((route) => route.action);
		for (const route of ['assistant:overview', 'assistant:ask', 'assistant:inbox-approve', 'assistant:route', 'assistant:tasks-list', 'assistant:flow-save', 'assistant:secret-save', 'assistant:card-answer', 'assistant:live-frame', 'agents:install-status-all', 'library:project-scan', 'toolsets:list', 'rules:get-global']) {
			expect(routes).toContain(route);
		}
		for (const old of ['stack:status-all', 'engine:claude-status', 'profiles:list', 'instructions:get-global', 'project-artifacts:scan', 'assistant:missions-list', 'assistant:job-save', 'assistant:automation-save']) {
			expect(routes).not.toContain(old);
		}
	});

	it('registers the control MCP server and builds its description from the action catalog', async () => {
		const { serverMetadata } = await import('$backend/mcp/internal/servers');
		const control = (serverMetadata as Record<string, { toolDefs: Record<string, { description: string }> }>).control;
		expect(control).toBeDefined();
		const description = control.toolDefs.run.description;
		expect(description).toContain('task.delegate');
		expect(description).toContain('[needs approval]');
	});
});

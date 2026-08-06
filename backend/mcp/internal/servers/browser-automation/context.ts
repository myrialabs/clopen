/**
 * Execution context for browser actions.
 *
 * Every action needs the same three things — which project's browser, which
 * chat session is driving it, and which tab is the target — and getting any of
 * them wrong is silent: a tool call lands on another project's browser, or on a
 * tab someone else's session owns. Resolving them in one place is what keeps
 * that from being re-derived (and re-broken) per action.
 */

import { browserMcpControl, browserPreviewServiceManager, type BrowserPreviewService } from '$backend/preview';
import type { BrowserTab } from '$backend/preview/browser/types';
import { projectContextService } from '$backend/mcp/internal/project-context';
import { debug } from '$shared/utils/logger';

/**
 * Resolve the BrowserPreviewService for the current MCP call.
 *
 * Order matters: an explicit id beats the ambient stream context, which beats
 * "whatever project happens to be open". The last one is a fallback for
 * transports that lose the context across an HTTP boundary, and it warns
 * because acting on a guessed project is worth noticing in the logs.
 */
export function getPreviewService(projectId?: string): BrowserPreviewService {
	if (projectId) return browserPreviewServiceManager.getService(projectId);

	const contextProjectId = projectContextService.getCurrentProjectId();
	if (contextProjectId) return browserPreviewServiceManager.getService(contextProjectId);

	const activeProjects = browserPreviewServiceManager.getActiveProjects();
	if (activeProjects.length > 0) {
		debug.warn('mcp', `⚠️ No project context found, falling back to first active project: ${activeProjects[0]}`);
		return browserPreviewServiceManager.getService(activeProjects[0]);
	}

	throw new Error('No active browser preview service found. Project isolation requires projectId.');
}

/** The chat session driving this call — MCP control is scoped to it. */
export function getChatSessionId(): string {
	const chatSessionId = projectContextService.getCurrentChatSessionId();
	if (!chatSessionId) {
		throw new Error('No chat session context available. Cannot acquire MCP control.');
	}
	return chatSessionId;
}

/**
 * Which tab the batch is pointed at right now, or null when nothing is open.
 *
 * A chat session accumulates tabs (open/switch add to its set), and the most
 * recently used one is the target — not the frontend's active tab, which the
 * user may have changed while the agent was working.
 *
 * Takes no control and opens nothing, so it is safe for actions that only want
 * to know where things stand.
 */
export function peekSessionTab(service: BrowserPreviewService, chatSessionId: string): BrowserTab | null {
	const sessionTabs = browserMcpControl.getSessionTabs(chatSessionId);
	if (sessionTabs.length > 0) {
		const lastTabId = sessionTabs[sessionTabs.length - 1];
		const controlledTab = service.getTab(lastTabId);
		if (controlledTab) return controlledTab;
	}

	return service.getActiveTab();
}

/**
 * The tab this call should act on, with MCP control acquired for it.
 *
 * Opens one when the project has none. Failing instead was a dead end: a fresh
 * browser has no tab, so the first call failed no matter what it asked for, and
 * the only way out was for someone to open a tab by hand in the UI.
 */
export async function getActiveTabSession(
	projectId?: string
): Promise<{ tab: BrowserTab; service: BrowserPreviewService; opened: boolean }> {
	const service = getPreviewService(projectId);
	const resolvedProjectId = service.getProjectId();
	const chatSessionId = getChatSessionId();

	const existing = peekSessionTab(service, chatSessionId);
	if (existing) {
		const acquired = browserMcpControl.acquireControl(existing.id, chatSessionId, resolvedProjectId);
		if (!acquired) {
			// Two very different refusals. Saying "another session" for both sent
			// an agent looking for a tab conflict that does not exist, when what
			// actually happened is that its own run was interrupted.
			if (!browserMcpControl.isSessionLive(chatSessionId)) {
				throw new Error('This chat session is no longer running — the browser was released when it stopped.');
			}
			const owner = browserMcpControl.getTabOwner(existing.id);
			throw new Error(`Tab '${existing.id}' is controlled by another chat session (${owner?.slice(0, 8)}...). Use a different tab.`);
		}

		debug.log('mcp', `🎮 Using tab: ${existing.id}`);
		return { tab: existing, service, opened: false };
	}

	debug.log('mcp', `📑 No tab open for project ${resolvedProjectId} — opening a blank one`);
	const tab = await service.createTab(undefined, 'laptop', 'landscape');
	browserMcpControl.acquireControl(tab.id, chatSessionId, resolvedProjectId);

	return { tab, service, opened: true };
}

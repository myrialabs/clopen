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
 * The tab this call should act on, with MCP control acquired for it.
 *
 * A chat session accumulates tabs (open/switch add to its set), and the most
 * recently used one is the target — not the frontend's active tab, which the
 * user may have changed while the agent was working.
 */
export async function getActiveTabSession(projectId?: string): Promise<{ tab: BrowserTab; service: BrowserPreviewService }> {
	const service = getPreviewService(projectId);
	const resolvedProjectId = service.getProjectId();
	const chatSessionId = getChatSessionId();

	const sessionTabs = browserMcpControl.getSessionTabs(chatSessionId);
	if (sessionTabs.length > 0) {
		const lastTabId = sessionTabs[sessionTabs.length - 1];
		const controlledTab = service.getTab(lastTabId);
		if (controlledTab) {
			debug.log('mcp', `🎮 Using session-controlled tab: ${controlledTab.id}`);
			return { tab: controlledTab, service };
		}
	}

	const tab = service.getActiveTab();
	if (!tab) {
		throw new Error("No open tab. Start with an `open_tab` action.");
	}

	const acquired = browserMcpControl.acquireControl(tab.id, chatSessionId, resolvedProjectId);
	if (!acquired) {
		const owner = browserMcpControl.getTabOwner(tab.id);
		throw new Error(`Tab '${tab.id}' is controlled by another chat session (${owner?.slice(0, 8)}...). Use a different tab.`);
	}

	return { tab, service };
}

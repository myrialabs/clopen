/**
 * Browser Action Handlers
 */

import { browserPreviewServiceManager, type BrowserPreviewService } from "$backend/lib/preview";
import type { BrowserAutonomousAction } from "$backend/lib/preview/browser/types";
import { browserMcpControl } from "$backend/lib/preview";
import { projectContextService } from "$backend/lib/mcp/project-context";
import { getActiveTabSession } from "./browser";
import { debug } from "$shared/utils/logger";

/**
 * Get BrowserPreviewService for current MCP execution context
 */
function getPreviewService(projectId?: string): BrowserPreviewService {
	// 1. Use explicit projectId if provided
	if (projectId) {
		debug.log('mcp', `Using explicit projectId: ${projectId}`);
		return browserPreviewServiceManager.getService(projectId);
	}

	// 2. Try to get projectId from current execution context
	const contextProjectId = projectContextService.getCurrentProjectId();
	if (contextProjectId) {
		debug.log('mcp', `Using projectId from context: ${contextProjectId}`);
		return browserPreviewServiceManager.getService(contextProjectId);
	}

	// 3. Fallback: Get first available project's service
	const activeProjects = browserPreviewServiceManager.getActiveProjects();
	if (activeProjects.length > 0) {
		const fallbackProjectId = activeProjects[0];
		debug.warn('mcp', `⚠️ No project context found, falling back to first active project: ${fallbackProjectId}`);
		return browserPreviewServiceManager.getService(fallbackProjectId);
	}

	throw new Error('No active browser preview service found. Project isolation requires projectId.');
}

// Define action types using discriminated union
type ClickAction = {
	type: 'click';
	x: number;
	y: number;
	click?: 'left' | 'right' | 'middle';
};

type TypeAction = {
	type: 'type';
	text?: string;  // text OR key (mutually exclusive)
	key?: string;   // text OR key (mutually exclusive)
	clearFirst?: boolean;
};

type MoveAction = {
	type: 'move';
	x: number;
	y: number;
	steps?: number;
};

type ScrollAction = {
	type: 'scroll';
	deltaX?: number;  // deltaX or deltaY or both
	deltaY?: number;  // deltaX or deltaY or both
	smooth?: boolean;
};

type WaitAction = {
	type: 'wait';
	delay: number;
};

type ExtractDataAction = {
	type: 'extract_data';
	selector: string;
};

type BrowserAction =
	| ClickAction
	| TypeAction
	| MoveAction
	| ScrollAction
	| WaitAction
	| ExtractDataAction;

export async function actionsHandler(args: {
	actions: BrowserAction[];
	projectId?: string;
}) {
	try {
		// Get active tab and session
		const { tab } = await getActiveTabSession(args.projectId);
		const sessionId = tab.id;

		// Get preview service
		const previewService = getPreviewService(args.projectId);

		// Process actions and apply MCP-optimized defaults
		const processedActions: BrowserAutonomousAction[] = args.actions.map(action => {
			const processed: BrowserAutonomousAction = { ...action } as any;

			// Apply MCP-optimized default delay for type actions with text (30ms)
			if (action.type === 'type' && 'text' in action && action.text && !('delay' in action)) {
				(processed as any).delay = 30;
			}

			// Apply clearFirst = true by default for MCP autonomous type actions
			if (action.type === 'type' && 'text' in action && action.text && action.clearFirst === undefined) {
				processed.clearFirst = true;
			}

			return processed;
		});

		// Note: Cursor events are emitted by performAutonomousActions internally
		// with proper delays between each action. No need to emit here.
		const results = await previewService.performAutonomousActions(sessionId, processedActions);
		browserMcpControl.updateLastAction();

		// Format response with extracted data if any
		const extractedData = results?.filter((r: any) => r.action === 'extract_data') || [];

		let responseText = `Successfully performed ${args.actions.length} action(s) in sequence.`;

		if (extractedData.length > 0) {
			responseText += '\n\nExtracted Data:';
			extractedData.forEach((item: any, idx: number) => {
				if (item.error) {
					responseText += `\n  [${idx + 1}] Error from '${item.selector}': ${item.error}`;
				} else if (item.data !== null && item.data !== undefined) {
					const attrInfo = item.attribute ? ` (via ${item.attribute})` : '';
					responseText += `\n  [${idx + 1}] From '${item.selector}'${attrInfo}: ${item.data}`;
				} else {
					responseText += `\n  [${idx + 1}] From '${item.selector}': (element not found or empty)`;
				}
			});
		}

		return {
			content: [{
				type: "text" as const,
				text: responseText
			}]
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return {
			content: [{
				type: "text" as const,
				text: `Actions execution failed: ${errorMessage}`
			}],
			isError: true
		};
	}
}

/**
 * Preview access guards.
 *
 * Browser preview handlers all read `projectId` from the connection and grab a
 * project-scoped `BrowserPreviewService` from the manager. Without an explicit
 * project-membership check, a connection that managed to land in another
 * project's room could drive that project's browser. These helpers compose the
 * membership guard with the service lookup so handlers cannot forget either.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import { requireCurrentProjectAccess } from '../access';
import { browserPreviewServiceManager } from '../../preview/index';

type PreviewService = ReturnType<typeof browserPreviewServiceManager.getService>;
type Tab = NonNullable<ReturnType<PreviewService['getActiveTab']>>;

export interface BrowserPreviewContext {
	userId: string;
	projectId: string;
	previewService: PreviewService;
}

export function requireBrowserPreviewAccess(conn: WSConnection): BrowserPreviewContext {
	const { userId, projectId } = requireCurrentProjectAccess(conn);
	const previewService = browserPreviewServiceManager.getService(projectId);
	return { userId, projectId, previewService };
}

/**
 * Resolve a tab in the caller's project. If `tabId` is omitted the active tab
 * is returned. Throws if the caller can't access the project, or if no tab
 * matches.
 */
export function requireBrowserTabAccess(
	conn: WSConnection,
	tabId?: string
): BrowserPreviewContext & { tab: Tab } {
	const ctx = requireBrowserPreviewAccess(conn);
	const tab = tabId ? ctx.previewService.getTab(tabId) : ctx.previewService.getActiveTab();
	if (!tab) {
		throw new Error(tabId ? `Tab not found: ${tabId}` : 'No active tab');
	}
	return { ...ctx, tab };
}

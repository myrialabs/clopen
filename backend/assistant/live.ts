/**
 * Clopen's live view — the browser an agent is using, from Clopen's screen.
 *
 * Clopen's own workspace has no Preview panel, yet its agents log in, fill
 * forms and read pages in the browser. The live view shows the tab an agent
 * controls right now (or the last one Clopen used) as frames with the
 * agent's cursor on them, and lets the owner click, scroll and type straight
 * into the page. "Take over" holds the tab for the owner — the agent cannot
 * act on it until they hand it back — for the rare thing only they can do (a
 * captcha); a login or a code is asked for in the chat instead.
 */

import { browserMcpControl, OWNER_HOLD_PREFIX } from '$backend/preview/browser/browser-mcp-control';
import { browserPreviewServiceManager } from '$backend/preview/browser/browser-preview-service';
import { projectQueries, sessionQueries } from '$backend/database/queries';
import { ensureAssistantProject } from './project';

export interface LiveTab {
	projectId: string;
	tabId: string;
	url: string;
	title: string;
	/** Who is driving it, when an agent is. */
	controlledBy: { sessionId: string; title: string; projectName: string } | null;
	/** The owner took it over from the agent. */
	heldByOwner: boolean;
}

/** Where the agent's pointer last was on each tab, and what it is doing — drawn over the frames. */
const cursors = new Map<string, { x: number; y: number; at: number }>();
let listening = false;
function listen(): void {
	if (listening) return;
	listening = true;
	browserMcpControl.on('cursor-position', (event: { tabId: string; x: number; y: number }) => cursors.set(event.tabId, { x: event.x, y: event.y, at: Date.now() }));
	browserMcpControl.on('cursor-click', (event: { tabId: string; x: number; y: number }) => cursors.set(event.tabId, { x: event.x, y: event.y, at: Date.now() }));
}

function tabOf(projectId: string, tabId: string) {
	if (!browserPreviewServiceManager.hasService(projectId)) return null;
	const tab = browserPreviewServiceManager.getService(projectId).getTab(tabId);
	return tab && !tab.page.isClosed() ? tab : null;
}

/** Tabs worth showing: every agent-controlled one, newest first, then Clopen's own. */
export function liveTabs(): LiveTab[] {
	const out: LiveTab[] = [];
	const seen = new Set<string>();
	for (const owned of browserMcpControl.listControlledTabs().sort((a, b) => b.acquiredAt - a.acquiredAt)) {
		const tab = tabOf(owned.projectId, owned.tabId);
		if (!tab) continue;
		const held = owned.chatSessionId.startsWith(OWNER_HOLD_PREFIX);
		const session = held ? null : sessionQueries.getById(owned.chatSessionId);
		const project = projectQueries.getById(owned.projectId);
		seen.add(owned.tabId);
		out.push({
			projectId: owned.projectId,
			tabId: owned.tabId,
			url: tab.page.url(),
			title: tab.title || tab.page.url(),
			controlledBy: held ? null : { sessionId: owned.chatSessionId, title: session?.title ?? 'Agent', projectName: project?.kind === 'home' ? 'Clopen' : (project?.name ?? '') },
			heldByOwner: held
		});
	}
	const home = ensureAssistantProject();
	if (browserPreviewServiceManager.hasService(home.id)) {
		for (const tab of browserPreviewServiceManager.getService(home.id).getAllTabs()) {
			if (seen.has(tab.id) || tab.page.isClosed()) continue;
			out.push({ projectId: home.id, tabId: tab.id, url: tab.page.url(), title: tab.title || tab.page.url(), controlledBy: null, heldByOwner: false });
		}
	}
	return out;
}

/** One frame of a tab, as a JPEG data URL, with the viewport it maps to. */
export async function liveFrame(
	projectId: string,
	tabId: string
): Promise<{ image: string; width: number; height: number; url: string; cursor: { x: number; y: number } | null; activity: string | null; deviceSize: string; deviceModel: string | null } | null> {
	listen();
	const tab = tabOf(projectId, tabId);
	if (!tab) return null;
	const buffer = await tab.page.screenshot({ type: 'jpeg', quality: 55 });
	const viewport = tab.page.viewport() ?? { width: 1280, height: 800 };
	const cursor = cursors.get(tabId);
	const agentHolds = browserMcpControl.isTabControlled(tabId) && !browserMcpControl.getTabOwner(tabId)?.startsWith(OWNER_HOLD_PREFIX);
	return {
		image: `data:image/jpeg;base64,${Buffer.from(buffer).toString('base64')}`,
		width: viewport.width,
		height: viewport.height,
		url: tab.page.url(),
		cursor: agentHolds && cursor && Date.now() - cursor.at < 60_000 ? { x: cursor.x, y: cursor.y } : null,
		activity: agentHolds ? browserMcpControl.getActivity(tabId) : null,
		// Drawn in the same device mockup the Preview Browser shows.
		deviceSize: tab.deviceSize,
		deviceModel: tab.deviceModel ?? null
	};
}

/** The owner takes the tab from the agent (it cannot act until handed back), or hands it back. */
export function liveHold(projectId: string, tabId: string, hold: boolean): void {
	const owner = browserMcpControl.getTabOwner(tabId);
	if (hold) {
		if (owner?.startsWith(OWNER_HOLD_PREFIX)) return;
		if (owner) browserMcpControl.releaseTab(tabId);
		browserMcpControl.acquireControl(tabId, `${OWNER_HOLD_PREFIX}${tabId}`, projectId);
	} else if (owner?.startsWith(OWNER_HOLD_PREFIX)) {
		browserMcpControl.releaseTab(tabId);
	}
}

/** The owner clicks or types into the tab (viewport coordinates). */
export async function liveInput(
	projectId: string,
	tabId: string,
	input: { type: 'click'; x: number; y: number } | { type: 'type'; text: string } | { type: 'key'; key: string } | { type: 'scroll'; x: number; y: number; deltaY: number }
): Promise<void> {
	const tab = tabOf(projectId, tabId);
	if (!tab) throw new Error('That tab is closed.');
	if (input.type === 'click') await tab.page.mouse.click(input.x, input.y);
	else if (input.type === 'scroll') {
		await tab.page.mouse.move(input.x, input.y);
		await tab.page.mouse.wheel({ deltaY: input.deltaY });
	}
	else if (input.type === 'type') await tab.page.keyboard.type(input.text, { delay: 20 });
	else await tab.page.keyboard.press(input.key as never);
}

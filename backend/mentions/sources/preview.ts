/**
 * The preview browser: a tab (its address, what it shows, what went wrong in
 * it), a tab's console, and one element of a page.
 *
 * A tab is captured with a picture of what is on screen beside the document —
 * the model can see the page the user is talking about. The tab's id is in
 * the document too, so an agent with the browser tool can act on that tab.
 */

import { ws } from '$backend/utils/ws';
import { browserPreviewServiceManager } from '$backend/preview/index';
import { makeScopeKey } from '$shared/utils/workspace-scope';
import type { CapturedAttachment, MentionCandidate } from '$shared/types/mentions';
import type { BrowserConsoleMessage } from '$backend/preview/browser/types';
import { buildContextDocument, contextFileSlug, countLines } from '$shared/utils/context-document';
import { rank, wants } from '../shared';
import { refString, type MentionContext, type MentionSource } from '../types';

const CATEGORY = 'preview';

/** The preview of the workspace on screen, without starting one. */
function previewService(ctx: MentionContext) {
	const scope = makeScopeKey(ctx.projectId, ws.getWorktreeId(ctx.conn));
	return browserPreviewServiceManager.hasService(scope) ? browserPreviewServiceManager.getService(scope) : null;
}

function consoleLine(message: BrowserConsoleMessage): string {
	const where = message.location?.url ? ` (${message.location.url}:${message.location.lineNumber})` : '';
	const repeat = message.count && message.count > 1 ? ` ×${message.count}` : '';
	return `[${message.type}] ${message.text}${where}${repeat}${message.stackTrace ? `\n${message.stackTrace}` : ''}`;
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

export const previewSource: MentionSource = {
	kinds: ['preview-tab', 'preview-console', 'preview-element'],

	categories(ctx) {
		const service = previewService(ctx);
		if (!service || service.getTabCount() === 0) return [];
		return [{ id: CATEGORY, label: 'Preview tabs', detail: `${service.getTabCount()} open`, icon: 'lucide:app-window', group: 'Preview' }];
	},

	async list(ctx, request) {
		const mode = wants(request.category, CATEGORY);
		if (!mode) return [];
		const service = previewService(ctx);
		if (!service) return [];
		const tabs = service.getAllTabsInfo();
		const rows: MentionCandidate[] = [];
		for (const tab of tabs) {
			rows.push({
				key: `preview-tab:${tab.id}`, kind: 'preview-tab', group: 'Preview', label: tab.title || tab.url || 'Untitled tab',
				detail: `${tab.isActive ? 'Active · ' : ''}${tab.url}`, icon: 'lucide:app-window', ref: { tabId: tab.id }
			});
			if (mode === 'own') {
				const count = service.getConsoleLogs(tab.id).length;
				rows.push({
					key: `preview-console:${tab.id}`, kind: 'preview-console', group: 'Console', label: `Console · ${tab.title || tab.url}`,
					detail: `${count} ${count === 1 ? 'message' : 'messages'}`, icon: 'lucide:scroll-text', ref: { tabId: tab.id }
				});
			}
		}
		// At the root with nothing typed, only the tab on screen is suggested.
		if (mode === 'root' && !request.query.trim()) return rows.filter((row) => tabs.find((tab) => tab.isActive && row.ref.tabId === tab.id)).slice(0, 1);
		return rank(rows, request.query, (row) => [row.label, row.detail, 'preview browser'], mode === 'root' ? 3 : request.limit);
	},

	async capture(ctx, kind, ref) {
		const service = previewService(ctx);
		if (!service) throw new Error('The preview is not running');
		const tabId = refString(ref, 'tabId');
		const tab = service.getTabInfo(tabId);
		if (!tab) throw new Error('That tab is no longer open');
		const logs = service.getConsoleLogs(tabId).filter((message) => message.type !== 'clear');
		const tabFacts: Array<[string, string]> = [
			['URL', tab.url],
			['Title', tab.title],
			['Tab id', tab.id],
			['Device', `${tab.deviceSize}${tab.deviceModel ? ` (${tab.deviceModel})` : ''}, ${tab.width}×${tab.height}`]
		];

		if (kind === 'preview-console') {
			const body = logs.map(consoleLine).join('\n');
			return {
				documents: [buildContextDocument({
					kind, label: tab.title || tab.url, detail: `${logs.length} messages`, facts: tabFacts,
					sections: [{ title: 'Console', body, fence: 'text' }]
				})]
			};
		}

		if (kind === 'preview-tab') {
			const problems = logs.filter((message) => message.type === 'error' || message.type === 'warn').slice(-50);
			const images: CapturedAttachment[] = [];
			try {
				const shot = await service.takeScreenshot(tabId, { kind: 'viewport' }, { format: 'jpeg', quality: 80 }, 'user');
				images.push({ fileName: `preview-${contextFileSlug(tab.title || 'tab')}.jpg`, mediaType: shot.mimeType, data: base64(shot.data) });
			} catch {
				// The page and its errors still say what is going on.
			}
			return {
				documents: [buildContextDocument({
					kind, label: tab.title || tab.url, detail: tab.url, facts: tabFacts,
					sections: [{
						title: 'Recent errors and warnings',
						body: problems.length ? problems.map(consoleLine).join('\n') : 'None.',
						fence: problems.length ? 'text' : undefined
					}]
				})],
				images
			};
		}

		// preview-element
		const x = Number(ref.x);
		const y = Number(ref.y);
		const depth = Number(ref.depth) || 0;
		if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('No point on the page was given');
		const element = await service.describeElementAt(tabId, x, y, depth);
		if (!element) throw new Error('There is no element at that point');
		const images: CapturedAttachment[] = [];
		try {
			const shot = await service.takeScreenshot(tabId, { kind: 'element', x, y, depth }, { format: 'png' }, 'user');
			images.push({ fileName: `element-${contextFileSlug(element.selector)}.png`, mediaType: shot.mimeType, data: base64(shot.data) });
		} catch {
			// An element with no visible box still has its markup.
		}
		const attributes = Object.entries(element.attributes).map(([name, value]) => `${name}="${value}"`).join('\n');
		const styles = Object.entries(element.styles).map(([name, value]) => `${name}: ${value};`).join('\n');
		return {
			documents: [buildContextDocument({
				kind, label: element.selector, detail: `<${element.tag}> on ${element.title || element.url}`,
				facts: [
					['Page', element.url],
					['Tab id', tab.id],
					['Selector', element.selector],
					['Box', `${element.rect.width}×${element.rect.height} at (${element.rect.x}, ${element.rect.y}) in a ${tab.width}×${tab.height} viewport`],
					['Inside', element.ancestors.slice(-6).join(' > ') || '(document)']
				],
				sections: [
					...(element.text ? [{ title: 'Visible text', body: element.text, fence: 'text' }] : []),
					...(attributes ? [{ title: 'Attributes', body: attributes, fence: '' }] : []),
					{ title: 'Computed style', body: styles, fence: 'css' },
					{ title: `HTML${element.htmlTruncated ? ' (cut short)' : ''} · ${countLines(element.html)}`, body: element.html, fence: 'html' }
				]
			})],
			images
		};
	}
};

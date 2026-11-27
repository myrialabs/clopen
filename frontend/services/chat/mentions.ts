/**
 * The `@` picker's client side.
 *
 * Most of what can be mentioned is looked up on the server (mentions:search)
 * and snapshotted there (mentions:capture). A few things only this page
 * knows: the names of the terminal tabs, and the issues of the hosting account
 * the Git panel is signed in to. Those are added here, so the composer asks
 * one place and gets one list.
 *
 * Everything else in the app that sends something to a chat — an editor
 * selection, a terminal selection, a page element, a query result — goes
 * through `addContextToChat`, so it lands in the message box exactly the way
 * a mention does.
 */

import ws from '$frontend/utils/ws';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { sessionState } from '$frontend/stores/core/sessions.svelte';
import { terminalStore } from '$frontend/stores/features/terminal.svelte';
import { activeWorktree, currentScopeKey } from '$frontend/stores/features/worktrees.svelte';
import { hostingStore } from '$frontend/stores/features/hosting.svelte';
import { addToComposer } from '$frontend/stores/ui/chat-input.svelte';
import { addNotification } from '$frontend/stores/ui/notification.svelte';
import { bestFuzzyScore } from '$shared/utils/fuzzy';
import { buildContextDocument, CONTEXT_MEDIA_TYPE, countLines, textToBase64, type ContextDocument, type ContextDocumentInput } from '$shared/utils/context-document';
import type { CapturedAttachment, ContextKind, MentionCandidate, MentionRef } from '$shared/types/mentions';
import type { IconName } from '$shared/types/ui/icons';
import type { WorkItem } from '$shared/types/work';
import { debug } from '$shared/utils/logger';

/** A list the picker can open, as a row. */
export interface MentionCategoryRow {
	id: string;
	label: string;
	detail: string;
	icon: IconName;
	group: string;
}

export interface MentionResults {
	items: MentionCandidate[];
	categories: MentionCategoryRow[];
}

const TERMINALS = 'terminals';
const ISSUES = 'issues';

/** Searching an issue tracker is a network call; the root does not wait long for it. */
const ROOT_ISSUE_BUDGET_MS = 1500;

function terminalRows(query: string, limit: number): MentionCandidate[] {
	const scope = currentScopeKey();
	const rows = terminalStore.sessions
		.filter((session) => !scope || session.projectId === scope)
		.map((session): MentionCandidate => ({
			key: `terminal:${session.id}`,
			kind: 'terminal',
			group: 'Terminals',
			label: session.name,
			detail: `${terminalStore.activeSessionId === session.id ? 'Active · ' : ''}${session.directory}`,
			icon: 'lucide:square-terminal',
			ref: { sessionId: session.id, name: session.name }
		}));
	if (!query.trim()) return rows.slice(0, limit);
	return rows
		.map((row) => ({ row, score: bestFuzzyScore(query, [row.label, 'terminal']) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.row);
}

function issueRow(item: WorkItem): MentionCandidate {
	const isPull = item.kind === 'pull-request';
	return {
		key: `work-item:${item.kind}:${item.id}`,
		kind: 'work-item',
		group: 'Issues & pull requests',
		label: `#${item.identifier} ${item.title}`,
		detail: `${isPull ? hostingStore.prNoun.short : 'Issue'} · ${item.state}`,
		icon: isPull ? 'lucide:git-pull-request' : 'lucide:circle-dot',
		ref: { id: item.id, kind: item.kind, identifier: item.identifier, title: item.title }
	};
}

async function issueRows(query: string, wait: number | null): Promise<MentionCandidate[]> {
	if (!hostingStore.offersWork) return [];
	const search = hostingStore.searchWorkItems(query).then((items) => items.map(issueRow)).catch(() => []);
	if (wait === null) return search;
	return Promise.race([search, new Promise<MentionCandidate[]>((resolve) => setTimeout(() => resolve([]), wait))]);
}

/** The lists only this page can open. */
function clientCategories(): MentionCategoryRow[] {
	const categories: MentionCategoryRow[] = [];
	if (terminalStore.sessions.length) {
		categories.push({ id: TERMINALS, label: 'Terminals', detail: `${terminalStore.sessions.length} open`, icon: 'lucide:square-terminal', group: 'Workspace' });
	}
	if (hostingStore.offersWork) {
		categories.push({ id: ISSUES, label: 'Issues & pull requests', detail: hostingStore.providerName ? `From ${hostingStore.providerName}` : 'From the linked repository', icon: 'lucide:circle-dot', group: 'Workspace' });
	}
	return categories;
}

/**
 * Rows for what was typed after `@`. At the root: suggestions and matches
 * from every source, then the lists that can be opened. Inside a category:
 * that list.
 */
export async function searchMentions(query: string, category: string | null): Promise<MentionResults> {
	const projectId = projectState.currentProject?.id;
	if (!projectId) return { items: [], categories: [] };

	if (category === TERMINALS) return { items: terminalRows(query, 100), categories: [] };
	if (category === ISSUES) return { items: await issueRows(query, null), categories: [] };

	const server = ws
		.http('mentions:search', {
			projectId,
			chatSessionId: sessionState.currentSession?.id ?? null,
			query,
			...(category && { category }),
			limit: category ? 100 : 30
		}, category ? 30_000 : 10_000)
		.catch((error) => {
			debug.warn('chat', 'Mention search failed:', error);
			return { items: [], categories: [] };
		}) as Promise<{ items: MentionCandidate[]; categories: MentionCategoryRow[] }>;

	if (category) return { items: (await server).items, categories: [] };

	// The active terminal is offered under an empty `@`; others once typed for.
	const terminals = query.trim()
		? terminalRows(query, 3)
		: terminalRows('', 100).filter((row) => row.ref.sessionId === terminalStore.activeSessionId);
	const [answer, issues] = await Promise.all([server, query.trim() ? issueRows(query, ROOT_ISSUE_BUDGET_MS) : Promise.resolve([])]);
	const localCategories = clientCategories().filter((entry) => !query.trim() || bestFuzzyScore(query, [entry.label, entry.detail]) > 0);

	return {
		items: [...answer.items, ...terminals, ...issues.slice(0, 3)],
		categories: [...answer.categories, ...localCategories]
	};
}

/** A context document as the attachment it travels as. */
export function documentAttachment(document: ContextDocument): CapturedAttachment {
	return { fileName: document.fileName, mediaType: CONTEXT_MEDIA_TYPE, data: textToBase64(document.text) };
}

/** Build a context document on this side — for what only the page has on screen. */
export function clientContext(input: ContextDocumentInput): CapturedAttachment {
	return documentAttachment(buildContextDocument(input));
}

/** The snapshot of a picked row, as attachments: its documents, then its pictures. */
export async function captureMention(kind: ContextKind, ref: MentionRef): Promise<CapturedAttachment[]> {
	if (kind === 'work-item') {
		const item = { id: String(ref.id), kind: ref.kind, identifier: String(ref.identifier), title: String(ref.title) } as WorkItem;
		const document = await hostingStore.workItemDocument(item);
		if (!document) throw new Error('This project is not connected to an issue tracker');
		return [documentAttachment(document)];
	}

	const projectId = projectState.currentProject?.id;
	if (!projectId) throw new Error('Open a project first');
	const result = await ws.http('mentions:capture', {
		projectId,
		chatSessionId: sessionState.currentSession?.id ?? null,
		kind,
		ref
	}, 120_000);
	return result.attachments;
}

/**
 * Put snapshots into the open chat's message box, the way a mention does.
 * Into the box, not sent: the user still writes what they want done.
 */
export function addContextToChat(attachments: CapturedAttachment[], options: { text?: string; quiet?: boolean } = {}): boolean {
	const chatSessionId = sessionState.currentSession?.id;
	if (!chatSessionId) {
		addNotification({ type: 'warning', title: 'No chat open', message: 'Open a chat first — this goes into its message box', duration: 4000 });
		return false;
	}
	addToComposer({ chatSessionId, text: options.text ?? '', attachments, mention: true });
	if (!options.quiet) {
		addNotification({ type: 'success', title: 'Added to chat', message: 'It is in the message box of the open chat', duration: 2500 });
	}
	return true;
}

/** Capture something on the server and add it to the chat, reporting a failure. */
export async function captureToChat(kind: ContextKind, ref: MentionRef): Promise<void> {
	try {
		addContextToChat(await captureMention(kind, ref));
	} catch (error) {
		addNotification({
			type: 'error',
			title: 'Could not add to chat',
			message: error instanceof Error ? error.message : String(error),
			duration: 5000
		});
	}
}

/** A path as the workspace names it: relative to the tree on screen when it is inside it. */
export function workspacePath(path: string): string {
	const normalized = path.replace(/\\/g, '/');
	for (const root of [activeWorktree()?.path, projectState.currentProject?.path]) {
		if (!root) continue;
		const base = root.replace(/\\/g, '/').replace(/\/$/, '');
		if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
	}
	return normalized;
}

/** Lines selected in an editor, as they are on screen — unsaved edits included. */
export function mentionCode(input: { path?: string; language?: string; text: string; startLine: number; endLine: number }): boolean {
	const path = input.path ? workspacePath(input.path) : null;
	const lines = input.startLine === input.endLine ? `${input.startLine}` : `${input.startLine}-${input.endLine}`;
	return addContextToChat([
		clientContext({
			kind: 'code',
			label: path ? `${path}:${lines}` : `Selection, lines ${lines}`,
			detail: countLines(input.text),
			facts: [['File', path], ['Lines', `${input.startLine}–${input.endLine}`], ['Language', input.language]],
			sections: [{ body: input.text, fence: input.language && input.language !== 'plaintext' ? input.language : '' }]
		})
	]);
}

/** Text selected in a terminal tab. */
export function mentionTerminalSelection(input: { name: string; directory?: string; text: string }): boolean {
	return addContextToChat([
		clientContext({
			kind: 'terminal-selection',
			label: input.name,
			detail: countLines(input.text),
			facts: [['Terminal', input.name], ['Working directory', input.directory]],
			sections: [{ title: 'Selected output', body: input.text, fence: 'text' }]
		})
	]);
}

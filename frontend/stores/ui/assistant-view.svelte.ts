/**
 * What Clopen's screen is showing: Chat or Tasks (chosen in the sidebar),
 * the task selected in Tasks — a one-off task or a repeating one — and the
 * live view's state. One store, so the sidebar, the command palette and a deep
 * link all open the same thing.
 */

import ws from '$frontend/utils/ws';

export type AssistantTab = 'chat' | 'tasks';

interface AssistantViewState {
	tab: AssistantTab;
	/** Which of Clopen's chats Chat shows: Main, or one the owner opened. */
	chatId: string;
	/** The task shown in Tasks: a one-off task (`task`) or a repeating one (`repeat`); `new` makes a repeating task. */
	selected: { type: 'task' | 'repeat'; id: string } | null;
	/** The live view is folded to a pill. */
	liveCollapsed: boolean;
	/** The owner closed the live view of this tab: do not reopen it until an agent takes another one. */
	liveDismissedFor: string | null;
	/** The "Needs you" list, opened from the sidebar. */
	needsYouOpen: boolean;
	/** Width of the Tasks list, dragged at the gap beside it. */
	taskListWidth: number;
	/** Where the floating live view sits over the chat, and its size; null until the owner moves it. */
	liveBox: LiveBox | null;
}

/** The live view's place over the chat: offsets from the chat's top-right corner, and its size. */
export interface LiveBox {
	right: number;
	top: number;
	width: number;
	height: number;
}

const LAYOUT_KEY = 'clopen:assistant-layout';
export const TASK_LIST_MIN = 220;
export const TASK_LIST_MAX = 560;

function storedLayout(): { taskListWidth?: number; liveBox?: LiveBox | null } {
	try {
		return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
	} catch {
		return {};
	}
}

/** Keep where the owner put things, on this device. */
export function saveAssistantLayout(): void {
	try {
		localStorage.setItem(LAYOUT_KEY, JSON.stringify({ taskListWidth: assistantView.taskListWidth, liveBox: assistantView.liveBox }));
	} catch {
		// Not kept; the defaults come back next time.
	}
}

const layout = typeof localStorage === 'undefined' ? {} : storedLayout();

export const assistantView = $state<AssistantViewState>({
	tab: 'chat',
	chatId: 'main',
	selected: null,
	liveCollapsed: false,
	liveDismissedFor: null,
	needsYouOpen: false,
	taskListWidth: Math.min(TASK_LIST_MAX, Math.max(TASK_LIST_MIN, layout.taskListWidth ?? 288)),
	liveBox: layout.liveBox ?? null
});

export function setAssistantTab(tab: AssistantTab) {
	assistantView.tab = tab;
}

/**
 * Show one of Clopen's chats — here, and in every other place at once: the
 * owner's Telegram and their other screens show the same chat.
 */
export function openChat(chatId: string) {
	assistantView.tab = 'chat';
	assistantView.chatId = chatId;
	void ws.http('assistant:chat-activate', { chatId }).catch(() => {});
}

/** Another place switched chats (Telegram's /chats, another screen): follow it. */
export function followActiveChat(chatId: string) {
	assistantView.chatId = chatId;
}

export function openTask(id: string | null) {
	assistantView.tab = 'tasks';
	assistantView.selected = id ? { type: 'task', id } : null;
}

/** A repeating task (stored as a flow). */
export function openFlow(id: string | null) {
	assistantView.tab = 'tasks';
	assistantView.selected = id ? { type: 'repeat', id } : null;
}

export function newFlow() {
	openFlow('new');
}

export function openNeedsYou() {
	assistantView.needsYouOpen = true;
}

export function closeNeedsYou() {
	assistantView.needsYouOpen = false;
}

/**
 * Clopen's own work from a chat: tasks — under way (with a look at the screen)
 * and repeating — and what is waiting for the owner. Repeating tasks are
 * stored as flows; to the owner they are just tasks that run again.
 */

import { t } from 'elysia';
import { inboxQueries, jobQueries } from '$backend/database/queries';
import { openTasksProgress, taskProgress } from '$backend/assistant/progress';
import { resolveInboxItem } from '$backend/assistant/inbox';
import { toInboxItem, toJob } from '$backend/assistant/mappers';
import { listMissions } from '$backend/assistant/missions';
import { runJob } from '$backend/jobs/runner';
import { describeTrigger, updateJob } from '$backend/jobs/service';
import type { Job } from '$shared/types/assistant';
import { defineAction } from '../define';
import { escapeMd } from './projects';
import { clearTimeline } from '$backend/assistant/timeline';
import { activeChat, createChat, currentSessionOf, ensureChatSession, listChats, MAIN_CHAT, setActiveChat } from '$backend/assistant/chats';
import { ensureAssistantProject } from '$backend/assistant/project';

const when = (job: Job) => describeTrigger(job);

export const showTasks = defineAction({
	id: 'tasks.list',
	group: 'task',
	title: 'Tasks',
	description: 'What Clopen is working on, and what repeats',
	args: t.Object({}),
	command: { name: 'tasks', menu: true },
	async run() {
		const progress = await openTasksProgress();
		const open = listMissions('open');
		const repeating = jobQueries.list().map(toJob).filter((job) => job.enabled);
		const lines = repeating.map((job) => `↻ **${escapeMd(job.name)}** · ${when(job)}`);
		return {
			text: [progress.text, lines.length ? lines.join('\n') : ''].filter(Boolean).join('\n\n'),
			files: progress.files,
			choices: [
				...open.slice(0, 8).map((task) => ({ label: task.title, detail: task.status, action: 'tasks.show', args: { taskId: task.id } })),
				...repeating.slice(0, 6).map((job) => ({ label: `↻ ${job.name}`, action: 'flows.show', args: { flowId: job.id } }))
			]
		};
	}
});

export const showTask = defineAction({
	id: 'tasks.show',
	group: 'task',
	title: 'Task progress',
	description: 'One task’s progress, with a screenshot when an agent is in the browser.',
	args: t.Object({ taskId: t.String({ minLength: 1 }) }),
	async run(_ctx, args) {
		const progress = await taskProgress(args.taskId);
		return { text: progress.text, files: progress.files };
	}
});

export const showInbox = defineAction({
	id: 'inbox.items',
	group: 'inbox',
	title: 'Inbox',
	description: 'What needs you',
	args: t.Object({}),
	command: { name: 'inbox' },
	async run() {
		const items = inboxQueries.list({ status: 'open', limit: 10 }).map(toInboxItem);
		if (!items.length) return { text: 'Nothing is waiting for you.' };
		return {
			text: items.map((item) => `• ${escapeMd(item.title)}`).join('\n'),
			choices: items.map((item) => ({ label: item.title, action: 'inbox.item', args: { itemId: item.id } }))
		};
	}
});

export const showInboxItem = defineAction({
	id: 'inbox.item',
	group: 'inbox',
	title: 'Inbox item',
	description: 'One item that needs you.',
	args: t.Object({ itemId: t.String({ minLength: 1 }) }),
	async run(_ctx, args) {
		const row = inboxQueries.getById(args.itemId);
		if (!row) throw new Error('That item no longer exists.');
		const item = toInboxItem(row);
		return {
			text: `**${escapeMd(item.title)}**${item.body ? `\n\n${item.body.slice(0, 3000)}` : ''}${item.kind === 'question' ? '\n\n_Reply to answer._' : ''}`,
			choices: item.status === 'open' ? [{ label: 'Done', action: 'inbox.done', args: { itemId: item.id } }] : []
		};
	}
});

export const settleInboxItem = defineAction({
	id: 'inbox.done',
	group: 'inbox',
	title: 'Mark done',
	description: 'Mark it done.',
	args: t.Object({ itemId: t.String({ minLength: 1 }) }),
	async run(_ctx, args) {
		const item = resolveInboxItem(args.itemId, 'resolved', { by: 'owner' });
		return { text: item ? '✓ Done.' : 'That item was already settled.' };
	}
});

export const showAutomations = defineAction({
	id: 'flows.list',
	group: 'automation',
	title: 'Repeating tasks',
	description: 'Every repeating task, on or off',
	args: t.Object({}),
	command: { name: 'flows' },
	async run() {
		const jobs = jobQueries.list().map(toJob);
		if (!jobs.length) return { text: 'Nothing repeats yet. Ask Clopen, e.g. “every morning at 7, check my site”.' };
		return {
			text: jobs.map((job) => `${job.enabled ? '●' : '○'} **${escapeMd(job.name)}** · ${when(job)}`).join('\n'),
			choices: jobs.slice(0, 10).map((job) => ({ label: job.name, detail: job.enabled ? 'on' : 'off', action: 'flows.show', args: { flowId: job.id } }))
		};
	}
});

export const showAutomation = defineAction({
	id: 'flows.show',
	group: 'automation',
	title: 'Repeating task',
	description: 'One repeating task, with its last run.',
	args: t.Object({ flowId: t.String({ minLength: 1 }) }),
	async run(_ctx, args) {
		const row = jobQueries.getById(args.flowId);
		if (!row) throw new Error('That flow no longer exists.');
		const job = toJob(row);
		const last = jobQueries.runsOf(job.id, 1)[0];
		const lastLine = last ? `\nLast run: ${last.status}${last.error ? ` · ${last.error}` : ''}` : '\nNot run yet.';
		return {
			text: `**${escapeMd(job.name)}** · ${job.enabled ? 'on' : 'off'}\n${when(job)}${lastLine}`,
			choices: [
				{ label: 'Run now', action: 'flows.run', args: { flowId: job.id } },
				{ label: job.enabled ? 'Turn off' : 'Turn on', action: 'flows.toggle', args: { flowId: job.id, enabled: !job.enabled } }
			]
		};
	}
});

export const runAutomation = defineAction({
	id: 'flows.run',
	group: 'automation',
	title: 'Run now',
	description: 'Run a flow now.',
	args: t.Object({ flowId: t.String({ minLength: 1 }) }),
	async run(_ctx, args) {
		const result = await runJob(args.flowId, 'manual');
		return { text: result.skipped ?? '▶️ Started.' };
	}
});

export const toggleAutomation = defineAction({
	id: 'flows.toggle',
	group: 'automation',
	title: 'Turn on or off',
	description: 'Turn a flow on or off.',
	args: t.Object({ flowId: t.String({ minLength: 1 }), enabled: t.Boolean() }),
	async run(_ctx, args) {
		const job = updateJob(args.flowId, { enabled: args.enabled });
		return { text: `${job.name} is ${job.enabled ? 'on' : 'off'}.` };
	}
});

export const clearChat = defineAction({
	id: 'clopen.clear',
	group: 'conversation',
	title: 'Clear chat',
	description: 'Start clean — Clopen still remembers everything',
	args: t.Object({}),
	command: { name: 'clear', menu: true },
	async run(ctx) {
		const project = ensureAssistantProject();
		const chatId = ctx.target.projectId === project.id ? activeChat() : MAIN_CHAT;
		clearTimeline(chatId);
		return { text: '🧹', target: { projectId: project.id, sessionId: currentSessionOf(chatId)?.id ?? null } };
	}
});

/**
 * Clopen's chats, to switch between: Main, the ones opened on the web or
 * here, and a new one. The chat app then shows that chat — the same as the
 * web does.
 */
export const listAssistantChats = defineAction({
	id: 'chats.list',
	group: 'conversation',
	title: 'Chats',
	description: 'Switch between your chats with Clopen',
	args: t.Object({}),
	command: { name: 'chats', menu: true },
	async run(ctx) {
		const project = ensureAssistantProject();
		const here = ctx.target.projectId === project.id ? activeChat() : null;
		return {
			text: '**💬 Chats**',
			choices: [
				...listChats().map((chat) => ({ label: chat.title, current: chat.id === here, action: 'chats.open', args: { chatId: chat.id } })),
				{ label: '＋ Start a new chat', action: 'chats.new', args: {} }
			]
		};
	}
});

export const openAssistantChat = defineAction({
	id: 'chats.open',
	group: 'conversation',
	title: 'Open chat',
	description: 'Continue one of your chats with Clopen.',
	args: t.Object({ chatId: t.String({ minLength: 1 }) }),
	async run(_ctx, args) {
		const project = ensureAssistantProject();
		const chat = listChats().find((entry) => entry.id === args.chatId);
		if (!chat) throw new Error('That chat is closed.');
		// The same chat on every screen: the web follows.
		await setActiveChat(chat.id, 'telegram');
		const session = await ensureChatSession(chat.id);
		if (!session) throw new Error('No AI model is set up yet.');
		return { text: `💬 **${escapeMd(chat.title)}**`, target: { projectId: project.id, sessionId: session.id } };
	}
});

export const newAssistantChat = defineAction({
	id: 'chats.new',
	group: 'conversation',
	title: 'New chat',
	description: 'Open a new chat with Clopen, beside Main.',
	args: t.Object({}),
	async run() {
		const project = ensureAssistantProject();
		const chat = createChat(null);
		await setActiveChat(chat.id, 'telegram');
		const session = await ensureChatSession(chat.id);
		if (!session) throw new Error('No AI model is set up yet.');
		return { text: '💬 **New chat**', target: { projectId: project.id, sessionId: session.id } };
	}
});

export const ASSISTANT_CONTROL_ACTIONS = [
	clearChat,
	listAssistantChats,
	openAssistantChat,
	newAssistantChat,
	showTasks,
	showTask,
	showInbox,
	showInboxItem,
	settleInboxItem,
	showAutomations,
	showAutomation,
	runAutomation,
	toggleAutomation
];

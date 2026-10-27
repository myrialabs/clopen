/**
 * Sessions: where am I, what is running, list, search, open, start, stop,
 * the queue, and delete.
 */

import { t } from 'elysia';
import { profileQueries, projectQueries, sessionQueries } from '$backend/database/queries';
import type { UnifiedMessage } from '$shared/types/unified';
import { isWaitingForInteractiveInput } from '$shared/utils/interactive-input';
import { streamManager } from '$backend/chat/stream-manager';
import { excerptMarkdown, lastTurnAnswer } from '$backend/chat/turn-answer';
import { defineAction } from '../define';
import { paged } from '../paging';
import { accessibleSession, isSessionBusy, modelOf, projectLabel, resolveTarget } from '../workspace';
import { sessionLink } from '../links';
import { escapeMd } from './projects';
import { engineName } from './models';

/** How much of a session's last answer opening it shows. */
const OPEN_EXCERPT = 900;

export function sessionTitle(session: { title?: string | null; head_title?: string | null }): string {
	return session.title || session.head_title || 'Untitled session';
}

interface QueueItem {
	id: string;
	userId: string;
	userName: string;
	text: string;
	attachmentCount: number;
}

export const sessionStatus = defineAction({
	id: 'sessions.status',
	group: 'sessions',
	title: 'Status',
	description: 'Where you are and what it is doing',
	access: 'member',
	args: t.Object({}),
	command: { name: 'status' },
	async run(ctx) {
		const { project, session } = resolveTarget(ctx.user.id, ctx.target);
		const model = modelOf(session);
		const lines = [`📁 **${escapeMd(projectLabel(project))}**`];
		lines.push(session ? `💬 ${escapeMd(sessionTitle(session))}` : '_No session yet. Your next message starts one here._');
		if (model) {
			const extras = [
				session?.reasoning_effort ? `reasoning ${session.reasoning_effort}` : null,
				session?.account_name ? `as ${escapeMd(session.account_name)}` : null
			].filter(Boolean);
			lines.push(`🤖 \`${model.modelName}\` · ${engineName(model.engine)}${extras.length ? ` · ${extras.join(' · ')}` : ''}`);
		}
		const profile = session?.profile_id ? profileQueries.getById(session.profile_id) : null;
		if (profile) lines.push(`🧰 Profile **${escapeMd(profile.name)}**`);
		lines.push(session && isSessionBusy(session) ? '⏳ Running now. /stop stops it.' : '💤 Idle.');

		if (session) {
			const { queue } = await ctx.call<{ queue: QueueItem[] }>('chat:composer-state', { chatSessionId: session.id }, { projectId: project.id });
			if (queue.length) lines.push(`🕒 ${queue.length} message${queue.length === 1 ? '' : 's'} queued. See /queue.`);
			const limit = model && session.account_id ? streamManager.getRateLimitForAccount(model.engine, session.account_id) : null;
			if (limit) {
				const resets = limit.resetsAt ? `, resets ${new Date(limit.resetsAt * 1000).toLocaleString()}` : '';
				lines.push(limit.status === 'rejected' ? `⛔ Rate limited${resets}.` : `⚠️ ${Math.round(limit.utilization * 100)}% of the rate limit used${resets}.`);
			}
		}
		const link = session ? sessionLink(project.id, session.id) : null;
		return { text: lines.join('\n'), ...(link ? { link: { label: 'Open in Clopen', url: link } } : {}) };
	}
});

export const newSession = defineAction({
	id: 'sessions.new',
	group: 'sessions',
	title: 'New session',
	description: 'Start a new session',
	access: 'member',
	args: t.Object({}),
	command: { name: 'new' },
	async run(ctx) {
		const { project } = resolveTarget(ctx.user.id, ctx.target);
		return { text: `✨ New session in **${escapeMd(projectLabel(project))}**. Type your message.`, target: { projectId: project.id, sessionId: null } };
	}
});

export const listSessions = defineAction({
	id: 'sessions.list',
	group: 'sessions',
	title: 'Sessions',
	description: 'Switch session in this project',
	access: 'member',
	args: t.Object({ page: t.Optional(t.Number({ minimum: 0 })) }),
	command: { name: 'sessions' },
	async run(ctx, args) {
		const { project, session: current } = resolveTarget(ctx.user.id, ctx.target);
		const sessions = sessionQueries
			.getByProjectId(project.id)
			.sort((a, b) => (b.last_message_at ?? b.started_at).localeCompare(a.last_message_at ?? a.started_at));
		if (sessions.length === 0) return { text: `No sessions in **${escapeMd(projectLabel(project))}** yet. Just type to start one.` };
		const { choices, range } = paged(
			sessions,
			args.page,
			(session) => ({
				label: `${isSessionBusy(session) ? '⏳ ' : ''}${sessionTitle(session)}`,
				detail: session.last_message_at ? new Date(session.last_message_at).toLocaleString() : undefined,
				current: session.id === current?.id,
				action: 'sessions.open',
				args: { sessionId: session.id }
			}),
			{ action: 'sessions.list' }
		);
		return { text: `**💬 Sessions in ${escapeMd(projectLabel(project))}**${range}`, choices };
	}
});

export const runningSessions = defineAction({
	id: 'sessions.running',
	group: 'sessions',
	title: 'Running',
	description: 'Sessions running or waiting for you, in all projects',
	access: 'member',
	args: t.Object({}),
	command: { name: 'running' },
	async run(ctx) {
		const rows = streamManager
			.getActiveStreams()
			.filter((stream) => stream.projectId && projectQueries.userHasProject(ctx.user.id, stream.projectId))
			.map((stream) => {
				const messages = stream.messages.map((event) => (event as { message?: UnifiedMessage }).message).filter((message): message is UnifiedMessage => Boolean(message));
				return { stream, session: sessionQueries.getById(stream.chatSessionId), waiting: isWaitingForInteractiveInput(messages) };
			})
			.filter((row) => row.session)
			// What needs you first, then the longest-running.
			.sort((a, b) => Number(b.waiting) - Number(a.waiting) || a.stream.startedAt.getTime() - b.stream.startedAt.getTime());
		if (rows.length === 0) return { text: '💤 Nothing is running in any of your projects.' };
		return {
			text: `**⏳ Running now** (${rows.length})`,
			choices: rows.map(({ stream, session, waiting }) => {
				const project = projectQueries.getById(session!.project_id);
				return {
					label: `${waiting ? '❓' : '⏳'} ${sessionTitle(session!)}`,
					detail: `${project ? projectLabel(project) : 'Unknown project'} · ${waiting ? 'waiting for your answer' : `running ${elapsed(stream.startedAt)}`}`,
					current: session!.id === ctx.target.sessionId,
					action: 'sessions.open',
					args: { sessionId: session!.id }
				};
			})
		};
	}
});

/** "3m", "1h 20m": how long something has been going. */
function elapsed(since: Date): string {
	const minutes = Math.max(0, Math.round((Date.now() - since.getTime()) / 60_000));
	if (minutes < 1) return 'under a minute';
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const searchSessions = defineAction({
	id: 'sessions.search',
	group: 'sessions',
	title: 'Search sessions',
	description: 'Find a session by what was said',
	access: 'member',
	args: t.Object({ query: t.String({ minLength: 1 }), page: t.Optional(t.Number({ minimum: 0 })) }),
	command: { name: 'search', argument: { keys: ['query'], hint: '<words>' } },
	async run(ctx, args) {
		const { sessions } = await ctx.call<{ sessions: Array<{ id: string; title?: string | null; project_id: string; matchSnippet?: string | null }> }>(
			'sessions:search-global',
			{ query: args.query.trim() }
		);
		if (sessions.length === 0) return { text: `Nothing matches “${escapeMd(args.query.trim())}”.` };
		const { choices, range } = paged(
			sessions,
			args.page,
			(session) => ({
				label: sessionTitle(session),
				detail: session.matchSnippet?.replace(/\s+/g, ' ').trim() || undefined,
				current: session.id === ctx.target.sessionId,
				action: 'sessions.open',
				args: { sessionId: session.id }
			}),
			{ action: 'sessions.search', args: { query: args.query } }
		);
		return { text: `**🔎 Sessions matching “${escapeMd(args.query.trim())}”**${range}`, choices };
	}
});

export const openSession = defineAction({
	id: 'sessions.open',
	group: 'sessions',
	title: 'Open session',
	description: 'Switch to a session; plain messages continue it.',
	access: 'member',
	args: t.Object({ sessionId: t.String({ minLength: 1 }) }),
	async run(ctx, args) {
		const found = accessibleSession(ctx.user.id, args.sessionId);
		if (!found) throw new Error('That session no longer exists.');
		const last = lastTurnAnswer(found.session.id).text;
		const busy = isSessionBusy(found.session) ? '\n\n⏳ It is running right now.' : '';
		const recap = last ? `\n\n**Last reply:**\n\n${excerptMarkdown(last, OPEN_EXCERPT)}` : '';
		return {
			text: `💬 Now in **${escapeMd(sessionTitle(found.session))}** (${escapeMd(projectLabel(found.project))}). Type to continue it.${busy}${recap}`,
			target: { projectId: found.project.id, sessionId: found.session.id }
		};
	}
});

export const stopSession = defineAction({
	id: 'sessions.stop',
	group: 'sessions',
	title: 'Stop',
	description: 'Stop the running turn',
	access: 'member',
	args: t.Object({}),
	command: { name: 'stop' },
	async run(ctx) {
		const found = accessibleSession(ctx.user.id, ctx.target.sessionId);
		const stream = found ? streamManager.getSessionStream(found.session.id, found.project.id) : undefined;
		if (!stream || stream.status !== 'active') return { text: 'Nothing is running.' };
		await streamManager.cancelStream(stream.streamId, 'user');
		return { text: '⏹ Stopped.' };
	}
});

export const showQueue = defineAction({
	id: 'sessions.queue',
	group: 'sessions',
	title: 'Queue',
	description: 'Messages waiting to run',
	access: 'member',
	args: t.Object({}),
	command: { name: 'queue' },
	async run(ctx) {
		const found = accessibleSession(ctx.user.id, ctx.target.sessionId);
		if (!found) return { text: 'Nothing is queued. There is no session yet.' };
		const { queue } = await ctx.call<{ queue: QueueItem[] }>('chat:composer-state', { chatSessionId: found.session.id }, { projectId: found.project.id });
		if (queue.length === 0) return { text: 'Nothing is queued.' };
		const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text) || '(attachment only)';
		return {
			text: `**🕒 Queued in ${escapeMd(sessionTitle(found.session))}**\n_They run in this order. Tap one of yours to drop it._`,
			choices: queue.map((item, index) => ({
				label: `${index + 1}. ${item.userId === ctx.user.id ? '✕ ' : ''}${clip(item.text.replace(/\s+/g, ' ').trim())}`,
				detail: `${item.userName}${item.attachmentCount ? ` · ${item.attachmentCount} file${item.attachmentCount === 1 ? '' : 's'}` : ''}`,
				action: 'sessions.unqueue',
				args: { sessionId: found.session.id, id: item.id }
			}))
		};
	}
});

export const dropQueued = defineAction({
	id: 'sessions.unqueue',
	group: 'sessions',
	title: 'Drop queued message',
	description: 'Remove one of your queued messages before it runs.',
	access: 'member',
	args: t.Object({ sessionId: t.String({ minLength: 1 }), id: t.String({ minLength: 1 }) }),
	async run(ctx, args) {
		const found = accessibleSession(ctx.user.id, args.sessionId);
		if (!found) throw new Error('That session no longer exists.');
		const { queue } = await ctx.call<{ queue: QueueItem[] }>('chat:composer-state', { chatSessionId: found.session.id }, { projectId: found.project.id });
		const item = queue.find((entry) => entry.id === args.id);
		if (!item) return { text: 'That message already ran or was dropped.' };
		if (item.userId !== ctx.user.id) throw new Error(`Only ${item.userName} can drop that message.`);
		await ctx.call('chat:queue-remove', { chatSessionId: found.session.id, id: args.id }, { projectId: found.project.id });
		return { text: '🗑️ Dropped from the queue.' };
	}
});

export const deleteSession = defineAction({
	id: 'sessions.delete',
	group: 'sessions',
	title: 'Delete session',
	description: 'Delete this session (files stay)',
	access: 'member',
	args: t.Object({}),
	command: { name: 'delete' },
	confirm(_args, ctx) {
		const found = accessibleSession(ctx.user.id, ctx.target.sessionId);
		return found ? `Delete “${sessionTitle(found.session)}” and all of its messages? This cannot be undone.` : null;
	},
	async run(ctx) {
		const found = accessibleSession(ctx.user.id, ctx.target.sessionId);
		if (!found) throw new Error('No session to delete.');
		await ctx.call('sessions:delete', { id: found.session.id }, { projectId: found.project.id });
		return { text: '🗑️ Session deleted.', target: { projectId: found.project.id, sessionId: null } };
	}
});

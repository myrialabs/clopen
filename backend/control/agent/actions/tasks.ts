/**
 * Tasks: create one, hand work to project sessions (each as a specialist),
 * read what came back, answer an agent's question, show progress, and close it
 * out.
 *
 * Internally a task is a `mission` row; every name an agent or the owner sees
 * says "task".
 */

import { t } from 'elysia';
import { sessionQueries, projectQueries } from '$backend/database/queries';
import { lastTurnAnswer, excerptMarkdown } from '$backend/chat/turn-answer';
import {
	answerAgentQuestion,
	createMission,
	dispatch,
	getMission,
	listMissions,
	missionTimeline,
	updateMission
} from '$backend/assistant/missions';
import { taskProgress } from '$backend/assistant/progress';
import { streamManager } from '$backend/chat/stream-manager';
import { defineAgentAction } from '../define';

function taskLine(task: ReturnType<typeof listMissions>[number]): string {
	const done = task.criteria.filter((item) => item.done).length;
	const working = task.sessions.filter((session) => session.busy);
	const busy = working.length ? ` · ${working.map((session) => session.role ?? 'agent').join(', ')} working` : '';
	return `- ${task.id} · ${task.status} · "${task.title}" · round ${task.iteration} · criteria ${done}/${task.criteria.length}${busy}`;
}

export const taskCreate = defineAgentAction({
	id: 'task.create',
	group: 'task',
	title: 'Create a task',
	description:
		'Start a background task: a goal with checkable criteria that you drive to done across project sessions. Returns its id. You are woken with a report every time an agent finishes a turn on it. Anything that takes more than a minute or two belongs in a task, not in this chat.',
	args: t.Object({
		title: t.String({ minLength: 1 }),
		goal: t.String({ minLength: 1 }),
		criteria: t.Optional(t.Array(t.String()))
	}),
	risk: 'write',
	scope: 'assistant',
	example: { title: 'Landing page for the café', goal: 'A responsive landing page with menu and contact form', criteria: ['Page renders', 'Contact form submits'] },
	async run(ctx, args) {
		const task = createMission({ ...args, assistantSessionId: ctx.target.sessionId });
		return { text: `Task ${task.id} created: "${task.title}".`, data: { taskId: task.id, task } };
	}
});

export const taskDispatch = defineAgentAction({
	id: 'task.dispatch',
	group: 'task',
	title: 'Hand work to a specialist',
	description:
		'Send a prompt to an agent in a project (by id, name or path) as part of a task. Name the specialist it works as in `role` ("Writer", "Developer", "Researcher", "Designer", "Tester"…) — the owner sees it as one status line. Reuses the task’s session for that role in that project unless newSession is true. Returns immediately; you get a report when the turn ends. Write the prompt as a complete brief: the role, goal, constraints, the owner’s rules, how to verify.',
	args: t.Object({
		taskId: t.String({ minLength: 1 }),
		project: t.String({ minLength: 1 }),
		prompt: t.String({ minLength: 1 }),
		role: t.Optional(t.String({ maxLength: 40 })),
		sessionId: t.Optional(t.String()),
		newSession: t.Optional(t.Boolean())
	}),
	risk: 'write',
	scope: 'assistant',
	example: { taskId: '$task.taskId', project: 'cafe-web', role: 'Developer', prompt: 'Build a landing page…' },
	async run(_ctx, args) {
		const sent = await dispatch({ ...args, missionId: args.taskId });
		return {
			text: `Sent to ${args.role ?? 'the agent'} in session ${sent.sessionId} (${sent.outcome === 'started' ? 'working now' : 'queued behind the running turn'}). You will be woken with its report.`,
			data: sent
		};
	}
});

export const taskList = defineAgentAction({
	id: 'task.list',
	group: 'task',
	title: 'List tasks',
	description: 'Open tasks (active, paused, stuck), or all with status "all".',
	args: t.Object({ status: t.Optional(t.Union([t.Literal('open'), t.Literal('all')])) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const tasks = listMissions(args.status ?? 'open');
		return { text: tasks.length ? tasks.map(taskLine).join('\n') : 'No tasks.', data: { tasks } };
	}
});

export const taskGet = defineAgentAction({
	id: 'task.get',
	group: 'task',
	title: 'Read a task',
	description: 'A task with its criteria, specialists and recent timeline.',
	args: t.Object({ taskId: t.String({ minLength: 1 }), events: t.Optional(t.Number({ minimum: 1, maximum: 200 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const task = getMission(args.taskId);
		if (!task) throw new Error(`There is no task ${args.taskId}.`);
		const events = missionTimeline(task.id).slice(-(args.events ?? 20));
		const criteria = task.criteria.map((item, index) => `  ${index}. [${item.done ? 'x' : ' '}] ${item.text}`).join('\n') || '  (none)';
		const timeline = events.map((event) => `  ${event.createdAt.slice(11, 19)} ${event.kind}: ${event.text.slice(0, 300).replace(/\n/g, ' ')}`).join('\n');
		return {
			text: `${taskLine(task)}\nGoal: ${task.goal}\nCriteria:\n${criteria}\nTimeline:\n${timeline || '  (empty)'}`,
			data: { task, events }
		};
	}
});

export const taskProgressAction = defineAgentAction({
	id: 'task.progress',
	group: 'task',
	title: 'Show a task’s progress',
	description:
		'A short progress note for the owner, with a screenshot of the browser tab an agent of the task is driving right now (when there is one). Use it when the owner asks how something is going.',
	args: t.Object({ taskId: t.String({ minLength: 1 }) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const progress = await taskProgress(args.taskId);
		return { text: progress.text, files: progress.files, data: { task: progress.mission, screenshot: progress.files[0]?.path ?? null } };
	}
});

export const taskUpdate = defineAgentAction({
	id: 'task.update',
	group: 'task',
	title: 'Update a task',
	description: 'Tick criteria off (by index), rewrite them, or retitle. ',
	args: t.Object({
		taskId: t.String({ minLength: 1 }),
		done: t.Optional(t.Array(t.Number({ minimum: 0 }))),
		criteria: t.Optional(t.Array(t.String())),
		title: t.Optional(t.String())
	}),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const task = getMission(args.taskId);
		if (!task) throw new Error(`There is no task ${args.taskId}.`);
		let criteria = args.criteria ? args.criteria.map((text) => ({ text, done: false })) : task.criteria;
		if (args.done) criteria = criteria.map((item, index) => (args.done!.includes(index) ? { ...item, done: true } : item));
		const updated = updateMission(task.id, { criteria, title: args.title });
		return { text: taskLine(updated), data: { task: updated } };
	}
});

function closer(id: 'task.complete' | 'task.fail', status: 'completed' | 'failed', description: string) {
	return defineAgentAction({
		id,
		group: 'task',
		title: status === 'completed' ? 'Complete a task' : 'Give up on a task',
		description,
		args: t.Object({ taskId: t.String({ minLength: 1 }), summary: t.String({ minLength: 1 }) }),
		risk: 'write',
		scope: 'assistant',
		async run(_ctx, args) {
			const task = updateMission(args.taskId, { status, summary: args.summary });
			return { text: `Task ${task.id} ${status}. The owner was sent your summary.`, data: { task } };
		}
	});
}

export const taskComplete = closer(
	'task.complete',
	'completed',
	'Close a task whose goal you verified is met. The summary goes to the owner as is — a few plain sentences: what was done, where, how you checked it. Consider saving the procedure as a skill (skill.save) if it is likely to be needed again.'
);

export const taskFail = closer(
	'task.fail',
	'failed',
	'Close a task that cannot be finished, with why and what information you would need from the owner to finish it.'
);

function steer(id: 'task.pause' | 'task.resume' | 'task.cancel', status: 'paused' | 'active' | 'cancelled', description: string) {
	return defineAgentAction({
		id,
		group: 'task',
		title: description,
		description,
		args: t.Object({ taskId: t.String({ minLength: 1 }) }),
		risk: 'write',
		scope: 'assistant',
		async run(_ctx, args) {
			const task = updateMission(args.taskId, { status });
			return { text: `Task ${task.id} is ${task.status}.`, data: { task } };
		}
	});
}

export const taskPause = steer('task.pause', 'paused', 'Pause a task: reports stop waking you until it is resumed.');
export const taskResume = steer('task.resume', 'active', 'Resume a paused or stuck task.');
export const taskCancel = steer('task.cancel', 'cancelled', 'Cancel a task that is no longer wanted.');

export const taskReadSession = defineAgentAction({
	id: 'task.read-session',
	group: 'task',
	title: 'Read a session',
	description: 'What a project session last answered, whether it is still working, and its project — to answer the owner about it.',
	args: t.Object({ sessionId: t.String({ minLength: 1 }), maxChars: t.Optional(t.Number({ minimum: 200, maximum: 30000 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const session = sessionQueries.getById(args.sessionId);
		if (!session) throw new Error('That session does not exist.');
		const project = projectQueries.getById(session.project_id);
		const busy = streamManager.getSessionStream(session.id, session.project_id)?.status === 'active';
		const answer = lastTurnAnswer(session.id);
		const text = excerptMarkdown(answer.text, args.maxChars ?? 8000);
		return {
			text: `Session ${session.id} in ${project?.name ?? 'unknown project'} · ${busy ? 'working' : 'idle'}\n${answer.error ? `Error: ${answer.error}\n` : ''}Last answer:\n${text || '(none)'}`,
			data: { sessionId: session.id, projectId: session.project_id, busy, answer: text, error: answer.error }
		};
	}
});

export const taskAnswer = defineAgentAction({
	id: 'task.answer',
	group: 'task',
	title: 'Answer an agent’s question',
	description: 'Answer the question an agent is waiting on (AskUserQuestion). `answers` maps each question text to the chosen option label or a free answer.',
	args: t.Object({
		sessionId: t.String({ minLength: 1 }),
		toolUseId: t.String({ minLength: 1 }),
		answers: t.Record(t.String(), t.String())
	}),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const handled = answerAgentQuestion(args);
		return {
			text: handled ? 'Answered; the agent continues.' : 'That question is no longer waiting (it was answered or the turn ended).',
			data: { handled }
		};
	}
});

/**
 * Clopen hands work out with `task.delegate` and follows it here. It does not
 * write prompts into project chats or judge their results itself: the crew's
 * recipe drives and checks the work (see `backend/recipes/crews.ts`).
 */
export const TASK_ACTIONS = [
	taskList,
	taskGet,
	taskProgressAction,
	taskUpdate,
	taskPause,
	taskResume,
	taskCancel,
	taskReadSession,
	taskAnswer
];

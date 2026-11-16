/**
 * Flows, delegation and talking to the owner — the actions behind Clopen's
 * intent tools (`delegate`, `automate`, `remind`, `connect`, `send`, `ask`,
 * `status`), also usable in a `run` batch.
 *
 * Arguments are flat and forgiving on purpose: a recipe may be text or JSON,
 * a time is plain English ("every day at 07:00", "in 10 minutes") or a cron.
 * Usage showed small models failing on nested unions, not on the work.
 */

import { t } from 'elysia';
import { jobQueries, missionQueries } from '$backend/database/queries';
import { createJob, deleteJob, describeTrigger, getJob, jobRuns, listJobs, revertRecipe, triggerFromWhen, updateJob, WHEN_EXAMPLES } from '$backend/jobs/service';
import { runJob, stopFlowRuns } from '$backend/jobs/runner';
import { delegate } from '$backend/assistant/crew';
import { connectService } from '$backend/assistant/connect';
import { tellOwner } from '$backend/assistant/notify';
import { raiseCard } from '$backend/assistant/cards';
import { judge } from '$backend/assistant/think';
import { shareLink } from '$backend/assistant/share';
import { listMissions } from '$backend/assistant/missions';
import { inboxQueries } from '$backend/database/queries';
import { toInboxItem } from '$backend/assistant/mappers';
import { resolveProject } from '$backend/assistant/missions';
import type { Job } from '$shared/types/assistant';
import { recipeToText } from '$shared/utils/recipe-text';
import { describeAt, parseWhen } from '$backend/jobs/when';
import { defineAgentAction } from '../define';

function flowLine(job: Job): string {
	return `- ${job.id} · ${job.enabled ? 'on' : 'off'} · "${job.name}" · ${describeTrigger(job)}${job.nextRunAt && job.enabled ? ` · next ${describeAt(new Date(job.nextRunAt))}` : ''} · v${job.version}`;
}

export const RECIPE_HELP = `recipe: text, one numbered step per line, nested by indentation. Verbs: Do (an AI agent; "(as Role in project)"), Run (a saved script), HTTP GET <url>, Use <service>.<tool>: {json}, Tell, Ask [a | b], Approve, If (then Else:), Choose (Case <label>:, Otherwise:), For each $list, In parallel (Branch:), Repeat until, Review $x by Role, Role: criteria, Flow <name>, Wait N min. "→ $name" names a result; use it later as $name or $name.field.`;

const triggerArgs = {
	when: t.Optional(t.String({ description: `When it runs, in English: ${WHEN_EXAMPLES}` })),
	watchUrl: t.Optional(t.String({ description: 'Run when this page changes (checked every everyMinutes).' })),
	watchFile: t.Optional(t.String({ description: 'Run when this file changes.' })),
	everyMinutes: t.Optional(t.Number({ minimum: 1 })),
	onEvent: t.Optional(t.String({ description: 'Run on a connected integration\'s webhook, "provider" or "provider:event" (e.g. "github:issues").' })),
	manual: t.Optional(t.Boolean({ description: 'Only when asked.' }))
};

function triggerOf(args: { when?: string; watchUrl?: string; watchFile?: string; everyMinutes?: number; onEvent?: string; manual?: boolean }) {
	if (args.watchUrl) return { triggerType: 'watch' as const, trigger: { target: { kind: 'url', url: args.watchUrl }, everyMinutes: args.everyMinutes ?? 15 } };
	if (args.watchFile) return { triggerType: 'watch' as const, trigger: { target: { kind: 'file', path: args.watchFile }, everyMinutes: args.everyMinutes ?? 5 } };
	if (args.onEvent) {
		const [provider, event] = args.onEvent.split(':');
		return { triggerType: 'event' as const, trigger: { provider, ...(event ? { event } : {}) } };
	}
	if (args.when) return triggerFromWhen(args.when);
	if (args.manual) return { triggerType: 'manual' as const, trigger: {} };
	return null;
}

const deliveryArg = t.Optional(t.Union([t.Literal('always'), t.Literal('changes'), t.Literal('failures')], { description: 'always · changes (only when the result differs from last time) · failures (only when it breaks)' }));

// ── Delegating ─────────────────────────────────────────────────────────────

export const taskDelegate = defineAgentAction({
	id: 'task.delegate',
	group: 'task',
	title: 'Delegate project work',
	description:
		'Hand project work — building or changing software or a website, writing a document or report into a folder, anything that makes or changes files — to agents working in a project, in the background. The team is sized to the request and tests its own work; you never verify it. Returns at once; the owner is told when it ends. Not for one-off actions you can do yourself (a screenshot, a lookup, a message, a calendar entry, a note in a connected service).',
	args: t.Object({
		goal: t.String({ minLength: 1, description: 'What the owner wants, in their words.' }),
		detail: t.Optional(t.String({ description: 'Anything else that matters: constraints, accounts, taste, deadlines.' })),
		project: t.Optional(t.String({ description: 'An existing project to work in; omit to let Clopen create one when needed.' })),
		recipe: t.Optional(t.String({ description: 'Only to override the crew: a recipe in text form.' })),
		continues: t.Optional(t.String({ description: 'The id of a task this changes or continues; the change goes into that task.' }))
	}),
	risk: 'write',
	scope: 'assistant',
	example: { goal: 'Build a PCOS meal-plan website', detail: 'Indonesian food, mobile first' },
	async run(ctx, args) {
		const recipe = args.recipe ? (await import('$backend/jobs/service')).toRecipe(args.recipe, args.goal.slice(0, 60)) : null;
		const started = await delegate({ goal: args.goal, detail: args.detail, project: args.project ?? null, assistantSessionId: ctx.target.sessionId, recipe, continues: args.continues ?? null });
		if (started.continued) {
			return {
				text:
					started.continued === 'answered'
						? `That answered the question task "${started.task.title}" was waiting on; it continues. Acknowledge in a few words.`
						: `Task "${started.task.title}" takes the change, in the same project. Acknowledge in a few words; they will hear when it is done.`,
				data: { taskId: started.task.id, projectId: started.project.id, continued: started.continued }
			};
		}
		return {
			text: `Started task "${started.task.title}" (${started.task.id}) in ${started.project.name}. Tell the owner it is under way in one short sentence; they will hear when it ends. Do not check on it yourself.`,
			data: { taskId: started.task.id, projectId: started.project.id, plan: started.plan }
		};
	}
});

// ── Flows ──────────────────────────────────────────────────────────────────

export const flowList = defineAgentAction({
	id: 'flow.list',
	group: 'automation',
	title: 'List flows',
	description: 'Every flow with its trigger, next run and version.',
	args: t.Object({}),
	risk: 'read',
	scope: 'assistant',
	async run() {
		const flows = listJobs();
		return { text: flows.map(flowLine).join('\n') || 'No flows yet.', data: { flows: flows.map(({ recipe: _recipe, ...rest }) => rest) } };
	}
});

export const flowGet = defineAgentAction({
	id: 'flow.get',
	group: 'automation',
	title: 'Read a flow',
	description: 'A flow with its recipe (text), notes, and recent runs.',
	args: t.Object({ flowId: t.String({ minLength: 1 }) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const job = getJob(args.flowId);
		if (!job) throw new Error('That flow does not exist.');
		const runs = jobRuns(job.id, 3);
		return {
			text: [
				flowLine(job),
				recipeToText(job.recipe),
				job.notes.length ? `Notes:\n${job.notes.map((note) => `- ${note}`).join('\n')}` : '',
				runs.length ? `Recent runs:\n${runs.map((run) => `- ${run.startedAt.slice(0, 16)} ${run.status}${run.error ? ` — ${run.error}` : ''}`).join('\n')}` : ''
			]
				.filter(Boolean)
				.join('\n\n'),
			data: { flow: job, runs }
		};
	}
});

export const flowCreate = defineAgentAction({
	id: 'flow.create',
	group: 'automation',
	title: 'Create a flow',
	description: `Make work start on its own: a recipe plus a trigger. Prefer Run (scripts) and Use (connected services) for fixed steps — they cost no tokens; use Do only where judgement is needed. Say the schedule back in plain words. Flows run only while Clopen is running. ${RECIPE_HELP}`,
	args: t.Object({
		name: t.String({ minLength: 1 }),
		recipe: t.Union([t.String(), t.Array(t.Unknown()), t.Record(t.String(), t.Unknown())]),
		...triggerArgs,
		project: t.Optional(t.String()),
		delivery: deliveryArg,
		overlap: t.Optional(t.Union([t.Literal('skip'), t.Literal('wait')])),
		budgetUsd: t.Optional(t.Number({ minimum: 0, description: 'Spend cap per day.' }))
	}),
	risk: 'write',
	scope: 'assistant',
	example: { name: 'USD/IDR every morning', when: 'every day at 07:00', recipe: '1. HTTP GET https://open.er-api.com/v6/latest/USD → $rates\n2. Tell: USD/IDR is $rates.rates.IDR' },
	async run(_ctx, args) {
		const trigger = triggerOf(args) ?? { triggerType: 'manual' as const, trigger: {} };
		const job = createJob({
			name: args.name,
			...trigger,
			recipe: args.recipe,
			projectId: args.project ? resolveProject(args.project).id : null,
			delivery: args.delivery,
			overlapPolicy: args.overlap,
			budgetUsd: args.budgetUsd ?? null,
			createdBy: 'assistant'
		});
		return { text: `Created flow ${job.id}: "${job.name}", ${describeTrigger(job)}.`, data: { flowId: job.id, flow: job } };
	}
});

export const flowUpdate = defineAgentAction({
	id: 'flow.update',
	group: 'automation',
	title: 'Change a flow',
	description: `Rename it, change when it runs, its recipe (a new version — give the whole recipe), delivery, budget, or turn it on/off. ${RECIPE_HELP}`,
	args: t.Object({
		flowId: t.String({ minLength: 1 }),
		name: t.Optional(t.String()),
		enabled: t.Optional(t.Boolean()),
		recipe: t.Optional(t.Union([t.String(), t.Array(t.Unknown()), t.Record(t.String(), t.Unknown())])),
		note: t.Optional(t.String({ description: 'Why the recipe changed (kept with the version).' })),
		...triggerArgs,
		delivery: deliveryArg,
		overlap: t.Optional(t.Union([t.Literal('skip'), t.Literal('wait')])),
		budgetUsd: t.Optional(t.Number({ minimum: 0 }))
	}),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		if (!getJob(args.flowId)) throw new Error('That flow does not exist.');
		const trigger = triggerOf(args);
		const job = updateJob(args.flowId, {
			name: args.name,
			enabled: args.enabled,
			...(trigger ?? {}),
			...(args.recipe !== undefined ? { recipe: args.recipe, recipeNote: args.note ?? 'Changed by Clopen', createdBy: 'assistant' as const } : {}),
			delivery: args.delivery,
			overlapPolicy: args.overlap,
			budgetUsd: args.budgetUsd
		});
		return { text: flowLine(job), data: { flow: job } };
	}
});

export const flowDelete = defineAgentAction({
	id: 'flow.delete',
	group: 'automation',
	title: 'Delete a flow',
	description: 'Delete a flow, its versions and its run history.',
	args: t.Object({ flowId: t.String({ minLength: 1 }) }),
	risk: 'irreversible',
	scope: 'assistant',
	async run(_ctx, args) {
		stopFlowRuns(args.flowId);
		deleteJob(args.flowId);
		return { text: 'Flow deleted.', data: { deleted: args.flowId } };
	}
});

export const flowRun = defineAgentAction({
	id: 'flow.run',
	group: 'automation',
	title: 'Run a flow now',
	description: 'Run a flow immediately, outside its trigger — to test it. Returns at once; read flow.runs for the result.',
	args: t.Object({ flowId: t.String({ minLength: 1 }) }),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const result = await runJob(args.flowId, 'manual');
		return { text: result.skipped ? `Not started: ${result.skipped}` : `Started run ${result.runId}.`, data: result };
	}
});

export const flowRuns = defineAgentAction({
	id: 'flow.runs',
	group: 'automation',
	title: 'Flow history',
	description: 'The latest runs of a flow, with what each step did.',
	args: t.Object({ flowId: t.String({ minLength: 1 }), limit: t.Optional(t.Number({ minimum: 1, maximum: 20 })) }),
	risk: 'read',
	scope: 'assistant',
	async run(_ctx, args) {
		const runs = jobRuns(args.flowId, args.limit ?? 3);
		return {
			text:
				runs
					.map((run) =>
						[
							`- ${run.startedAt.slice(0, 16)} · ${run.status} · ${run.reason}${run.costUsd ? ` · $${run.costUsd.toFixed(3)}` : ''}${run.error ? ` · ${run.error}` : ''}`,
							...run.trace.map((entry) => `    ${entry.path} [${entry.status}] ${entry.label.slice(0, 80)}${entry.error ? ` — ${entry.error.slice(0, 160)}` : ''}`)
						].join('\n')
					)
					.join('\n') || 'No runs yet.',
			data: { runs }
		};
	}
});

export const flowRevert = defineAgentAction({
	id: 'flow.revert',
	group: 'automation',
	title: 'Revert a flow',
	description: 'Put a flow\'s recipe back to an earlier version (flow.get shows the current version).',
	args: t.Object({ flowId: t.String({ minLength: 1 }), version: t.Number({ minimum: 1 }) }),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const job = revertRecipe(args.flowId, args.version);
		return { text: flowLine(job), data: { flow: job } };
	}
});

export const flowNote = defineAgentAction({
	id: 'flow.note',
	group: 'automation',
	title: 'Teach a flow',
	description: 'Add a lesson the flow\'s AI steps read on every run ("the owner wants prices in IDR", "skip weekends").',
	args: t.Object({ flowId: t.String({ minLength: 1 }), note: t.String({ minLength: 1, maxLength: 300 }) }),
	risk: 'write',
	scope: 'assistant',
	async run(_ctx, args) {
		const job = getJob(args.flowId);
		if (!job) throw new Error('That flow does not exist.');
		jobQueries.setNotes(job.id, [...job.notes, args.note.trim()]);
		return { text: 'Noted.', data: { flowId: job.id } };
	}
});

// ── Reminders ──────────────────────────────────────────────────────────────

export const remindOwner = defineAgentAction({
	id: 'owner.remind',
	group: 'automation',
	title: 'Remind the owner',
	description: `Send the owner a message at a time (once), or on a schedule. ${WHEN_EXAMPLES}`,
	args: t.Object({ text: t.String({ minLength: 1 }), when: t.String({ minLength: 1 }) }),
	risk: 'write',
	scope: 'assistant',
	example: { text: 'DSU meeting in 5 minutes', when: 'today at 13:55' },
	async run(_ctx, args) {
		const when = parseWhen(args.when);
		const trigger = when.kind === 'cron' ? { triggerType: 'schedule' as const, trigger: { cron: when.cron } } : { triggerType: 'once' as const, trigger: { at: when.at.toISOString() } };
		// Asked twice (or said again in other words): one reminder, the newer wording.
		const same = await sameReminder(args.text, trigger);
		if (same) {
			const job = updateJob(same.id, { name: `Reminder: ${args.text.slice(0, 60)}`, ...trigger, recipe: { title: 'Reminder', steps: [{ kind: 'tell', text: `⏰ ${args.text}` }] }, recipeNote: 'Same reminder, said again', createdBy: 'assistant' });
			return { text: `Reminder already set: ${describeTrigger(job)}.`, data: { flowId: job.id } };
		}
		const job = createJob({
			name: `Reminder: ${args.text.slice(0, 60)}`,
			...(when.kind === 'cron' ? { triggerType: 'schedule' as const, trigger: { cron: when.cron } } : { triggerType: 'once' as const, trigger: { at: when.at.toISOString() } }),
			recipe: { title: 'Reminder', steps: [{ kind: 'tell', text: `⏰ ${args.text}` }] },
			delivery: 'failures',
			createdBy: 'assistant'
		});
		return { text: `Reminder set: ${describeTrigger(job)}.`, data: { flowId: job.id } };
	}
});

/** An existing reminder at the same moment (or on the same schedule) about the same thing. */
async function sameReminder(text: string, trigger: { triggerType: 'schedule' | 'once'; trigger: Record<string, unknown> }): Promise<Job | null> {
	const NEAR_MS = 10 * 60_000;
	const candidates = listJobs().filter((job) => {
		if (!job.enabled || !job.name.startsWith('Reminder:') || job.trigger.type !== trigger.triggerType) return false;
		if (job.trigger.type === 'schedule') return job.trigger.config.cron === trigger.trigger.cron;
		return job.trigger.type === 'once' && Math.abs(new Date(job.trigger.config.at).getTime() - new Date(String(trigger.trigger.at)).getTime()) <= NEAR_MS;
	});
	for (const job of candidates) {
		const existing = job.name.replace(/^Reminder:\s*/, '');
		if (existing.trim().toLowerCase() === text.trim().toLowerCase().slice(0, 60)) return job;
		const verdict = await judge('Are these two reminders about the same thing?', `A: ${existing}\nB: ${text}`).catch(() => ({ answer: false }));
		if (verdict.answer) return job;
	}
	return null;
}

// ── The owner ──────────────────────────────────────────────────────────────

export const sendToOwner = defineAgentAction({
	id: 'owner.send',
	group: 'inbox',
	title: 'Send to the owner',
	description: 'Send the owner a message and/or files (screenshots, images, documents — absolute paths) where they are: the chat app they are using, and Clopen. Use it to deliver a file; your normal reply already reaches them.',
	args: t.Object({ text: t.Optional(t.String()), files: t.Optional(t.Array(t.String())) }),
	risk: 'read',
	scope: 'any',
	example: { text: 'Here is the page', files: ['/Users/me/Projects/cafe/shot.png'] },
	async run(ctx, args) {
		if (!args.text?.trim() && !args.files?.length) throw new Error('Nothing to send.');
		// Inside a task the owner hears once, at the end, with every file — not a draft, then a final, then the report.
		const task = ctx.target.sessionId ? missionQueries.openMissionForSession(ctx.target.sessionId) : null;
		if (task) {
			if (args.files?.length) missionQueries.addEvent({ missionId: task.id, kind: 'note', text: 'Files for the owner', data: { deliver: args.files } });
			return { text: 'Kept: the owner gets these files with the task result, once. Do not send anything else; finish your handoff report.' };
		}
		const told = await tellOwner({ text: args.text?.trim() || '', files: args.files ?? [], refs: { sessionId: ctx.target.sessionId, projectId: ctx.target.projectId } });
		return {
			text: `Sent${told.files.length ? ` ${told.files.length} file${told.files.length === 1 ? '' : 's'}` : ''}.${told.skipped.length ? ` Not sent: ${told.skipped.join('; ')}` : ''}`,
			data: { files: told.files }
		};
	}
});

export const askOwner = defineAgentAction({
	id: 'owner.ask',
	group: 'inbox',
	title: 'Ask the owner',
	description:
		'Ask the owner something only they can answer — a password or key (secret: true; the value is stored in the vault, never shown to you — read it after with secret.get), a choice, or missing information. Never use it to hand them a task you could do yourself.',
	args: t.Object({
		question: t.String({ minLength: 1 }),
		options: t.Optional(t.Array(t.String())),
		secret: t.Optional(t.String({ description: 'Ask for a password/key and save it under this name (e.g. "gmail-password").' }))
	}),
	risk: 'read',
	scope: 'any',
	async run(ctx, args) {
		if (ctx.target.sessionId && missionQueries.openMissionForSession(ctx.target.sessionId)) {
			throw new Error(
				'Inside a task you do not ask the owner. Choose a sensible default, say which in your handoff report, and carry on. If the work truly cannot go on without them, say exactly what is missing in your report — Clopen asks them once.'
			);
		}
		const refs = { sessionId: ctx.target.sessionId, projectId: ctx.target.projectId };
		const card = args.secret
			? raiseCard({
					card: 'secret',
					title: args.question,
					fields: [{ name: 'value', label: args.secret, secret: true }],
					target: { type: 'secret', secret: args.secret },
					refs
				})
			: raiseCard({ card: 'ask', title: args.question, options: args.options, refs });
		return { text: `Asked the owner (card ${card.id}). Their answer comes to this chat; carry on with what does not depend on it.`, data: { cardId: card.id } };
	}
});

// ── Services and links ─────────────────────────────────────────────────────

export const connectAction = defineAgentAction({
	id: 'service.connect',
	group: 'assistant',
	title: 'Connect a service',
	description:
		'Connect a service by name (Notion, Linear, GitHub, Gmail…): Clopen installs its connector and, when it needs a sign-in or a key, sends the owner a card to do exactly that. Never send the owner to Settings. You are told "[Clopen · connected]" when it is ready.',
	args: t.Object({ service: t.String({ minLength: 1 }) }),
	risk: 'write',
	scope: 'assistant',
	example: { service: 'notion' },
	async run(ctx, args) {
		const result = await connectService(args.service, { sessionId: ctx.target.sessionId });
		return { text: result.text, data: result };
	}
});

export const shareLinkAction = defineAgentAction({
	id: 'share.link',
	group: 'files',
	title: 'Share a link',
	description:
		'A public HTTPS link to show something that was built — a running app (port) or a site folder — instead of a local path or localhost. Anyone with the link can open it. Never for moving files: a file from a page comes down with the browser download action, and files reach the owner with owner.send.',
	args: t.Object({ port: t.Optional(t.Number({ minimum: 1, maximum: 65535 })), folder: t.Optional(t.String()) }),
	risk: 'write',
	scope: 'any',
	example: { port: 5173 },
	async run(_ctx, args) {
		const link = await shareLink(args);
		return { text: `Public link: ${link.url} (local: ${link.localUrl})`, data: link };
	}
});

// ── Status ─────────────────────────────────────────────────────────────────

export const clopenStatus = defineAgentAction({
	id: 'clopen.status',
	group: 'assistant',
	title: 'What is going on',
	description: 'Tasks under way, upcoming flows, and what is waiting for the owner.',
	args: t.Object({}),
	risk: 'read',
	scope: 'assistant',
	async run() {
		const tasks = listMissions('open');
		const flows = listJobs().filter((job) => job.enabled && job.nextRunAt).sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''));
		const waiting = inboxQueries.list({ status: 'open', limit: 20 }).map(toInboxItem).filter((item) => ['question', 'approval', 'stalled'].includes(item.kind));
		const lines = [
			tasks.length ? `Tasks:\n${tasks.map((task) => `- ${task.title} · ${task.status}${task.sessions.filter((session) => session.busy).map((session) => ` · ${session.role ?? 'agent'} working`).join('')}`).join('\n')}` : 'No tasks running.',
			flows.length ? `Next flows:\n${flows.slice(0, 5).map((job) => `- ${job.name} · ${describeAt(new Date(job.nextRunAt!))}`).join('\n')}` : 'No flows scheduled.',
			waiting.length ? `Waiting for the owner:\n${waiting.map((item) => `- ${item.title}`).join('\n')}` : 'Nothing waiting for the owner.'
		];
		return { text: lines.join('\n\n'), data: { tasks: tasks.length, flows: flows.length, waiting: waiting.length } };
	}
});

export const FLOW_ACTIONS = [
	taskDelegate,
	flowList,
	flowGet,
	flowCreate,
	flowUpdate,
	flowDelete,
	flowRun,
	flowRuns,
	flowRevert,
	flowNote,
	remindOwner,
	sendToOwner,
	askOwner,
	connectAction,
	shareLinkAction,
	clopenStatus
];

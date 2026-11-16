/**
 * Delegating project work to a crew.
 *
 * `delegate` lands here: the request is planned (`planCrew`, sized to what it
 * asks), it gets a project — the one named, or a new folder under ~/Projects
 * — the crew's recipe is built (`crewRecipe`) and run in the background.
 * Clopen's chat is free at once; the owner hears one message when it ends,
 * in the language they asked in, saying honestly how it ended: done, needs
 * them, unfinished, or impossible as asked.
 *
 * Stopping or pausing the task stops its crew.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { missionQueries, projectQueries } from '$backend/database/queries';
import { callRouteAs } from '$backend/control/invoke';
import { getOwner } from '$backend/auth/auth-service';
import type { Mission } from '$shared/types/assistant';
import type { Project } from '$shared/types/database/schema';
import type { Recipe } from '$shared/types/recipe';
import { debug } from '$shared/utils/logger';
import { isAssistantProject } from '$shared/utils/assistant-project';
import { runRecipe } from '$backend/recipes/engine';
import { crewRecipe, crewResultVar, planCrew, reviseRecipe, type CrewPlan } from '$backend/recipes/crews';
import { answerCardWithText, isAwaited } from './cards';
import { inboxQueries, settingsQueries } from '$backend/database/queries';
import { toInboxItem } from './mappers';
import { stringify } from '$backend/recipes/refs';
import { inOwnersLanguage, think } from './think';
import { notifyAssistantChanged } from './events';
import { createMission, getMission, updateMission } from './missions';
import { tellOwner } from './notify';
import { toMission } from './mappers';

/** Crews running now, by task. */
const running = new Map<string, AbortController>();

function projectsDir(): string {
	return join(homedir(), 'Projects');
}

async function projectFor(plan: Pick<CrewPlan, 'title' | 'projectName'>, requested?: string | null): Promise<Project> {
	const listed = projectQueries.getListed().filter((project) => !isAssistantProject(project));
	if (requested?.trim()) {
		const ref = requested.trim().toLowerCase();
		const found = listed.find((project) => project.id === requested || project.name.toLowerCase() === ref || project.path === requested);
		if (found) return found;
	}
	const existing = listed.find((project) => project.name.toLowerCase() === plan.projectName.toLowerCase());
	if (existing) return existing;
	const owner = getOwner();
	if (!owner) throw new Error('Clopen has no owner yet.');
	let path = join(projectsDir(), plan.projectName);
	for (let n = 2; existsSync(path) && n < 100; n++) path = join(projectsDir(), `${plan.projectName}-${n}`);
	mkdirSync(path, { recursive: true });
	const created = await callRouteAs<Project>(owner, 'projects:create', { name: plan.title.slice(0, 60) || plan.projectName, path });
	rememberCreatedProject(created.id);
	return created;
}

const CREATED_KEY = 'assistant:created-projects';

/** Projects Clopen made for a task — shown apart from the owner's own in the sidebar. */
export function createdProjectIds(): string[] {
	try {
		return JSON.parse(settingsQueries.get(CREATED_KEY)?.value ?? '[]') as string[];
	} catch {
		return [];
	}
}

function rememberCreatedProject(id: string): void {
	settingsQueries.set(CREATED_KEY, JSON.stringify([...new Set([...createdProjectIds(), id])]));
}

/** Tasks from this chat a new message could be about: open, or ended in the last two days. */
/**
 * Recent tasks, from any of Clopen's chats: the owner is one person, and a
 * change typed in another chat (or after Clopen moved to a fresh session) is
 * still about the same work.
 */
function candidateTasks(): Mission[] {
	const since = Date.now() - 48 * 3600_000;
	return missionQueries
		.list({ limit: 30 })
		.map(toMission)
		.filter((task) => task.recipe && task.status !== 'cancelled')
		.filter((task) => ['active', 'paused', 'stalled'].includes(task.status) || new Date(task.updatedAt).getTime() > since)
		.slice(0, 8);
}

/**
 * Is this request a change to, or the answer for, a task already under way —
 * "ok, use the defaults", "make it realistic"? A model decides (no word lists);
 * when unsure, it is new work.
 */
async function followUpOf(request: string): Promise<Mission | null> {
	const tasks = candidateTasks();
	if (!tasks.length) return null;
	const pick = await think<{ task: number }>(
		[
			'The owner asked for the request below. Is it a change to, a continuation of, or an answer for one of these earlier tasks (reply with its number), or new work (reply 0)? Changing how something that task makes looks or works ("make it 8-bit", "now in 3D", "add dark mode") is a change to it. Only a different thing altogether is new work.',
			`Request: ${request.slice(0, 1500)}`,
			'',
			...tasks.map((task, index) => `${index + 1}. "${task.title}" (${task.status}): ${task.goal.slice(0, 300)}${task.summary ? ` — result: ${task.summary.slice(0, 200)}` : ''}`)
		].join('\n'),
		{ type: 'object', additionalProperties: false, properties: { task: { type: 'integer' } }, required: ['task'] }
	).catch(() => ({ task: 0 }));
	return tasks[pick.task - 1] ?? null;
}

/**
 * Carry a follow-up into its task: answer the question it is waiting on, or
 * run the change as a revision with the same crew, project and chats.
 */
async function continueTask(task: Mission, request: string): Promise<'answered' | 'revised'> {
	const waiting = inboxQueries
		.list({ status: 'open', limit: 50 })
		.map(toInboxItem)
		.find((item) => item.missionId === task.id && (item.data.card === 'ask' || item.kind === 'approval'));
	if (waiting && isAwaited(waiting.id)) {
		await answerCardWithText(waiting.id, request, { inTurn: true });
		return 'answered';
	}
	stopCrews(task.id);
	const projectId = missionQueries.sessionsOf(task.id)[0]?.project_id ?? null;
	if (!projectId || !task.recipe) throw new Error('That task has no project to continue in.');
	const previous = task.summary ?? '';
	missionQueries.setRecipe(task.id, reviseRecipe(task.recipe, request, previous, projectId));
	missionQueries.setTrace(task.id, []);
	missionQueries.addEvent({ missionId: task.id, kind: 'note', text: `Change: ${request}`, projectId });
	if (task.status === 'active') {
		missionQueries.update(task.id, { summary: null });
		startCrew(task.id, projectId);
	} else {
		updateMission(task.id, { status: 'active', summary: null });
	}
	return 'revised';
}

/** Start a task with its crew. Returns once it is under way. */
export async function delegate(input: {
	goal: string;
	detail?: string;
	project?: string | null;
	assistantSessionId?: string | null;
	recipe?: Recipe | null;
	/** The task this changes, when Clopen knows it — no guessing then. */
	continues?: string | null;
}): Promise<{ task: Mission; project: Project; plan: CrewPlan | null; continued?: 'answered' | 'revised' }> {
	if (!input.recipe && !input.project) {
		const named = input.continues ? getMission(input.continues) : null;
		const earlier = named && named.recipe && named.status !== 'cancelled' ? named : await followUpOf([input.goal, input.detail].filter(Boolean).join('\n\n'));
		if (earlier) {
			const continued = await continueTask(earlier, [input.goal, input.detail].filter(Boolean).join('\n\n'));
			const projectId = missionQueries.sessionsOf(earlier.id)[0]?.project_id ?? null;
			const project = projectId ? projectQueries.getById(projectId) : null;
			if (project) return { task: getMission(earlier.id)!, project, plan: null, continued };
		}
	}
	const plan = input.recipe ? null : await planCrew(input.goal, input.detail);
	const title = plan?.title ?? input.recipe!.title;
	const project = await projectFor({ title, projectName: plan?.projectName ?? title.toLowerCase().replace(/[^\w-]+/g, '-').slice(0, 40) }, input.project);
	const recipe = input.recipe ?? crewRecipe(plan!, input.goal, input.detail, project.id);
	const task = createMission({
		title,
		goal: [input.goal, input.detail].filter(Boolean).join('\n\n'),
		criteria: plan?.criteria ?? [],
		assistantSessionId: input.assistantSessionId ?? null
	});
	missionQueries.setRecipe(task.id, recipe);
	missionQueries.addEvent({ missionId: task.id, kind: 'note', text: `Working in ${project.name}`, projectId: project.id });
	startCrew(task.id, project.id);
	return { task: getMission(task.id)!, project, plan };
}

const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;

/**
 * At most two pictures go with a result (screenshots are evidence, not the
 * deliverable); every other file — the PDF, the document, the archive the
 * owner asked for — always goes.
 */
function pick(paths: string[]): string[] {
	const images = paths.filter((path) => IMAGE.test(path)).slice(-2);
	return [...paths.filter((path) => !IMAGE.test(path)), ...images];
}

/** The files that go to the owner with the result: what agents set aside for them, else files the report names. */
function filesFor(taskId: string, report: string): string[] {
	const kept = new Set<string>();
	for (const event of missionQueries.eventsOf(taskId)) {
		try {
			const data = JSON.parse(event.data ?? '{}') as { deliver?: string[] };
			for (const path of data.deliver ?? []) if (existsSync(path)) kept.add(path);
		} catch {
			// Not a delivery.
		}
	}
	if (kept.size) return pick([...kept]);
	const found = new Set<string>();
	for (const match of report.matchAll(/(\/[^\s`'"()<>]+\.(?:png|jpe?g|webp|gif|pdf|docx?|xlsx?|pptx?|csv|zip))/gi)) if (existsSync(match[1])) found.add(match[1]);
	return pick([...found]);
}

/** Links a report mentions, so the owner's message keeps them. */
function linksIn(text: string): string[] {
	return [...new Set([...text.matchAll(/https?:\/\/[^\s`'"()<>]+/g)].map((match) => match[0].replace(/[.,;]+$/, '')))].slice(0, 3);
}

/** One or two sentences for the owner, in their language, from the crew's final report. */
async function summarise(goal: string, report: string, outcome: string): Promise<string> {
	const links = linksIn(report);
	try {
		const result = await think<{ text: string }>(
			[
				`Tell the owner the result of their request, in one or two short sentences, in the language of the request. Outcome: ${outcome}. Say only what they got and anything they must know about it — never how it was made, which tools or services were used, who worked on it, or that it was sent or delivered (it arrives with this message). Include every link below exactly. No headings, no lists, no file paths.`,
				`Request: ${goal.slice(0, 600)}`,
				links.length ? `Links: ${links.join(' ')}` : '',
				`Final report:\n<<<\n${report.slice(0, 8000)}\n>>>`
			].join('\n\n'),
			{ type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] }
		);
		const text = result.text.trim();
		return links.every((link) => text.includes(link)) ? text : `${text}\n${links.filter((link) => !text.includes(link)).join('\n')}`;
	} catch {
		return [report.split('\n').find((line) => line.trim())?.slice(0, 300) ?? '', ...links].filter(Boolean).join('\n');
	}
}

/**
 * Run (or resume) a task's crew in the background.
 *
 * A run owns the task only while it is the one registered for it. A run
 * that was stopped — paused, or replaced because the owner changed the task
 * mid-way — still unwinds after the new one started; it must then touch
 * nothing: not the trace (the new run's), not the status (it once set an
 * active task to "paused" while the new crew kept working under it).
 */
export function startCrew(taskId: string, projectId: string | null): void {
	const row = missionQueries.getById(taskId);
	if (!row?.recipe || running.has(taskId)) return;
	const task = toMission(row);
	const controller = new AbortController();
	running.set(taskId, controller);
	const owns = () => running.get(taskId) === controller;
	const progress = throttled(() => notifyAssistantChanged('tasks', task.id), 1000);
	void (async () => {
		const result = await runRecipe(
			task.recipe!,
			{ kind: 'task', title: task.title, ownerId: task.id, projectId, notes: [], sessionId: task.assistantSessionId },
			{
				signal: controller.signal,
				onProgress: (trace) => {
					if (!owns()) return;
					missionQueries.setTrace(task.id, trace);
					progress();
				}
			}
		);
		if (!owns()) {
			notifyAssistantChanged('tasks', taskId);
			return;
		}
		running.delete(taskId);
		missionQueries.setTrace(task.id, result.trace);
		const current = missionQueries.getById(taskId);
		if (!current || ['cancelled', 'paused', 'completed', 'failed'].includes(current.status)) {
			notifyAssistantChanged('tasks', taskId);
			return;
		}
		if (result.outcome === 'cancelled') {
			updateMission(taskId, { status: 'paused' });
			return;
		}
		const report = stringify(result.vars.get(crewResultVar(task.recipe!)) ?? result.output);
		const refs = { missionId: taskId, sessionId: task.assistantSessionId };
		if (result.outcome === 'done') {
			const text = await summarise(task.goal, report, 'done');
			updateMission(taskId, { status: 'completed', summary: text });
			await tellOwner({ text, files: filesFor(taskId, report), title: task.title, refs });
			return;
		}
		if (result.outcome === 'impossible' || result.outcome === 'declined') {
			const text = await inOwnersLanguage(`I stopped "${task.title}": ${result.error}`, task.goal);
			updateMission(taskId, { status: 'failed', summary: text });
			await tellOwner({ text, title: task.title, refs });
			return;
		}
		// Unfinished or failed: say what is done and what is not, and wait for the owner.
		const text =
			result.outcome === 'unfinished'
				? await summarise(task.goal, `${report}\n\nNot finished: ${result.error}`, 'not finished — say what works so far and what is still open, then ask whether to keep going')
				: await inOwnersLanguage(`"${task.title}" stopped: ${result.error}. Reply to continue or to change the plan.`, task.goal);
		updateMission(taskId, { status: 'stalled', summary: text });
		await tellOwner({ text, files: filesFor(taskId, report), title: task.title, refs });
	})().catch((error) => {
		if (owns()) running.delete(taskId);
		debug.warn('assistant', `The crew of ${taskId} failed:`, error);
	});
}

/** At most one call per `ms`, the last one always made — a step that starts right after another ended is still told. */
function throttled(fn: () => void, ms: number): () => void {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	return () => {
		const wait = last + ms - Date.now();
		if (wait <= 0) {
			last = Date.now();
			fn();
			return;
		}
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			last = Date.now();
			fn();
		}, wait);
	};
}

/** After a restart: every task still marked as working gets its crew back. */
export function resumeCrews(): number {
	let resumed = 0;
	for (const row of missionQueries.listOpen()) {
		if (row.status !== 'active' || !row.recipe || running.has(row.id)) continue;
		const projectId = missionQueries.sessionsOf(row.id)[0]?.project_id ?? null;
		if (!projectId) continue;
		startCrew(row.id, projectId);
		resumed += 1;
	}
	if (resumed) debug.log('assistant', `Resumed ${resumed} crew(s) after a restart`);
	return resumed;
}

export function isCrewRunning(taskId: string): boolean {
	return running.has(taskId);
}

/** Stop a task's crew (or every crew). Returns how many were stopped. */
export function stopCrews(taskId?: string): number {
	let stopped = 0;
	for (const [id, controller] of running) {
		if (taskId && id !== taskId) continue;
		controller.abort();
		running.delete(id);
		stopped += 1;
	}
	return stopped;
}

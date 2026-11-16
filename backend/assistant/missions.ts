/**
 * Missions — the Clopen assistant driving work to done.
 *
 * A mission is a goal with criteria. The assistant hands work to project
 * sessions (`dispatch`), and is woken — not polled — when a session's turn
 * ends: Clopen reads what the turn answered and changed, records it on the
 * mission's timeline, and sends the assistant a report in its own chat. The
 * assistant then judges it against the criteria and either corrects the agent
 * or completes the mission.
 *
 * There is no cap on iterations or time: a mission runs for as long as it is
 * making progress. What stops it is the absence of progress — the same answer
 * with no file changes, or the same error, several turns in a row — which marks
 * it stalled and asks the owner through the Inbox.
 *
 * Questions an agent asks mid-turn (AskUserQuestion) go to the assistant when
 * the mission is autonomous, and to the owner's Inbox when it asks first.
 */

import {
	missionQueries,
	projectQueries,
	sessionQueries,
	inboxQueries,
	jobQueries,
	type MissionRow
} from '$backend/database/queries';
import { streamManager } from '$backend/chat/stream-manager';
import { lastTurnAnswer, excerptMarkdown } from '$backend/chat/turn-answer';
import { callRouteAs } from '$backend/control/invoke';
import { getOwner } from '$backend/auth/auth-service';
import { isAssistantProject, ASSISTANT_NAME } from '$shared/utils/assistant-project';
import type { AssistantAutonomy, Mission, MissionCriterion, MissionEvent, MissionStatus } from '$shared/types/assistant';
import type { AskUserQuestion, StreamEvent } from '$shared/types/unified';
import type { ChatSession, Project } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';
import { notifyAssistantChanged } from './events';
import { raiseInboxItem } from './inbox';
import { toMission, toMissionEvent } from './mappers';
import { ensureAssistantProject } from './project';
import { getAssistantSettings } from './settings';
import { sendPromptAsOwner, type ModelChoice } from './prompt';
import { pickAssistantModel } from './model';
import { journal } from './journal';

/** Turns in a row without progress before a mission counts as stalled. */
export const STALL_LIMIT = 3;
/** How much of an agent's answer a report carries to the assistant. */
const REPORT_EXCERPT = 4000;

// ── Reading ────────────────────────────────────────────────────────────────

export function getMission(id: string): Mission | null {
	const row = missionQueries.getById(id);
	return row ? toMission(row) : null;
}

export function listMissions(filter: 'open' | 'all' = 'open'): Mission[] {
	return (filter === 'open' ? missionQueries.listOpen() : missionQueries.list()).map(toMission);
}

/**
 * Tasks as a list shows them — without each one's plan and what every step
 * did, which only the open task needs (a busy task's trace runs to megabytes).
 */
export function listMissionsLight(filter: 'open' | 'all' = 'open'): Mission[] {
	return listMissions(filter).map((mission) => ({ ...mission, recipe: null, trace: [], summary: mission.summary ? mission.summary.slice(0, 300) : null }));
}

export function missionTimeline(id: string): MissionEvent[] {
	return missionQueries.eventsOf(id).map(toMissionEvent);
}

function requireMission(id: string): MissionRow {
	const row = missionQueries.getById(id);
	if (!row) throw new Error(`There is no task ${id}.`);
	return row;
}

// ── Creating and steering ──────────────────────────────────────────────────

export function createMission(input: {
	title: string;
	goal: string;
	criteria?: string[];
	autonomy?: AssistantAutonomy;
	assistantSessionId?: string | null;
	jobId?: string | null;
}): Mission {
	const criteria: MissionCriterion[] = (input.criteria ?? []).filter((text) => text.trim()).map((text) => ({ text: text.trim(), done: false }));
	const row = missionQueries.create({
		title: input.title.trim() || 'Untitled task',
		goal: input.goal.trim(),
		criteria,
		autonomy: input.autonomy ?? getAssistantSettings().autonomy,
		assistantSessionId: input.assistantSessionId ?? null,
		jobId: input.jobId ?? null
	});
	missionQueries.addEvent({ missionId: row.id, kind: 'created', text: row.goal, data: { criteria } });
	journal('task', `Started task "${row.title}": ${row.goal}`, { missionId: row.id });
	notifyAssistantChanged('tasks', row.id);
	return toMission(row);
}

export function updateMission(
	id: string,
	patch: { status?: MissionStatus; summary?: string | null; criteria?: MissionCriterion[]; title?: string }
): Mission {
	const before = requireMission(id);
	const row = missionQueries.update(id, {
		status: patch.status,
		summary: patch.summary,
		criteria: patch.criteria,
		title: patch.title,
		...(patch.status === 'active' ? { stallCount: 0 } : {})
	})!;
	if (patch.status && ['paused', 'cancelled', 'completed', 'failed'].includes(patch.status) && before.recipe) {
		void import('./crew').then(({ stopCrews }) => stopCrews(id));
	}
	if (patch.status === 'active' && before.status !== 'active' && before.recipe) {
		void import('./crew').then(({ startCrew }) => startCrew(id, missionQueries.sessionsOf(id)[0]?.project_id ?? null));
	}
	if (patch.status && patch.status !== before.status) {
		missionQueries.addEvent({ missionId: id, kind: 'status', text: `${before.status} → ${patch.status}`, data: { summary: patch.summary ?? null } });
		if (['completed', 'failed', 'cancelled'].includes(patch.status)) {
			journal('task', `Task "${row.title}" ${patch.status}${patch.summary ? `: ${patch.summary}` : ''}`, { missionId: id });
			// Through the one way a card closes: the web, the owner's Telegram and anything waiting on it all hear.
			const open = inboxQueries.list({ status: 'open', limit: 200 }).filter((item) => item.mission_id === id && ['question', 'stalled', 'approval'].includes(item.kind));
			if (open.length) void import('./cards').then(({ cancelCards }) => cancelCards(open.map((item) => item.id)));
			// A crew reports for itself (one message, with files); only recipe-less tasks are reported here.
			if (patch.status !== 'cancelled' && !before.recipe) {
				raiseInboxItem({
					kind: 'report',
					title: `${patch.status === 'completed' ? '✅' : '❌'} ${row.title}`,
					body: patch.summary ?? '',
					missionId: id
				});
			}
		}
	}
	notifyAssistantChanged('tasks', id);
	return toMission(row);
}

/** Resolve the project a dispatch targets: an id, an exact name, or a path. */
export function resolveProject(ref: string): Project {
	const byId = projectQueries.getById(ref);
	const all = projectQueries.getListed();
	const project = byId ?? all.find((entry) => entry.name.toLowerCase() === ref.toLowerCase()) ?? all.find((entry) => entry.path === ref);
	if (!project || !projectQueries.isListed(project.id)) throw new Error(`There is no project "${ref}". List projects first, or add the folder as a project.`);
	if (isAssistantProject(project)) throw new Error(`Work is dispatched to project sessions, not to ${ASSISTANT_NAME}'s own chat.`);
	return project;
}

/**
 * Hand a prompt to a project session on behalf of a mission. Reuses the
 * mission's latest session in that project unless `newSession` is set or a
 * specific session is named.
 */
export async function dispatch(input: {
	missionId: string;
	project: string;
	prompt: string;
	sessionId?: string | null;
	newSession?: boolean;
	model?: ModelChoice | null;
	/** The specialist this chat works as ("Writer", "Developer"…). */
	role?: string | null;
}): Promise<{ sessionId: string; projectId: string; outcome: 'started' | 'queued' }> {
	const mission = requireMission(input.missionId);
	if (!['active', 'stalled', 'paused'].includes(mission.status)) throw new Error(`Task "${mission.title}" is ${mission.status}.`);
	const role = input.role?.trim() || null;
	const project = resolveProject(input.project);

	let session: ChatSession | null = null;
	if (input.sessionId) {
		session = sessionQueries.getById(input.sessionId);
		if (!session || session.project_id !== project.id) throw new Error('That session is not in this project.');
	} else if (!input.newSession) {
		const linked = missionQueries
			.sessionsOf(mission.id)
			.filter((link) => link.project_id === project.id && (!role || !link.role || link.role.toLowerCase() === role.toLowerCase()))
			.map((link) => sessionQueries.getById(link.session_id))
			.filter((row): row is ChatSession => Boolean(row));
		session = linked[linked.length - 1] ?? null;
	}

	const isNew = !session;
	const text = role && isNew ? `You work on this as the ${role}.\n\n${input.prompt}` : input.prompt;
	const sent = await sendPromptAsOwner({ project, session, text, model: input.model, title: role ? `${role} · ${mission.title}` : mission.title });
	missionQueries.linkSession(mission.id, sent.session.id, project.id, role);
	const iteration = mission.iteration + 1;
	missionQueries.update(mission.id, {
		iteration,
		...(mission.status !== 'active' ? { status: 'active' as const, stallCount: 0 } : {})
	});
	missionQueries.addEvent({
		missionId: mission.id,
		kind: 'prompt',
		text: input.prompt,
		data: { iteration, outcome: sent.outcome },
		sessionId: sent.session.id,
		projectId: project.id
	});
	notifyAssistantChanged('tasks', mission.id);
	return { sessionId: sent.session.id, projectId: project.id, outcome: sent.outcome };
}

/** Answer a question a mission's agent is waiting on. */
export function answerAgentQuestion(input: { sessionId: string; toolUseId: string; answers: Record<string, string> }): boolean {
	const session = sessionQueries.getById(input.sessionId);
	if (!session) throw new Error('That session does not exist.');
	const handled = streamManager.resolveUserAnswer(session.id, session.project_id, input.toolUseId, input.answers);
	const mission = missionQueries.openMissionForSession(session.id);
	if (handled && mission) {
		missionQueries.addEvent({
			missionId: mission.id,
			kind: 'answer',
			text: Object.entries(input.answers)
				.map(([question, answer]) => `${question} → ${answer}`)
				.join('\n'),
			sessionId: session.id,
			projectId: session.project_id
		});
		const open = inboxQueries.findOpen('question', { sessionId: session.id });
		if (open) inboxQueries.resolve(open.id, 'resolved', { answeredBy: 'assistant' });
		notifyAssistantChanged('tasks', mission.id);
	}
	return handled;
}

// ── Waking the assistant ───────────────────────────────────────────────────

/**
 * Send the assistant a message in the mission's own assistant session — or a
 * new one, when the mission has none yet (a job started it).
 */
export async function wakeAssistant(missionId: string, text: string): Promise<void> {
	const mission = requireMission(missionId);
	const project = ensureAssistantProject();
	let session = mission.assistant_session_id ? sessionQueries.getById(mission.assistant_session_id) : null;
	if (session && session.project_id !== project.id) session = null;
	try {
		const model = session ? null : await pickAssistantModel();
		const sent = await sendPromptAsOwner({ project, session, text, model, title: mission.title });
		if (!session) missionQueries.update(mission.id, { assistantSessionId: sent.session.id });
	} catch (error) {
		debug.warn('assistant', `Waking the assistant for mission ${mission.id} failed:`, error);
		raiseInboxItem({
			kind: 'stalled',
			title: `${ASSISTANT_NAME} could not continue: ${mission.title}`,
			body: error instanceof Error ? error.message : String(error),
			missionId: mission.id
		});
	}
}

// ── Reacting to project sessions ───────────────────────────────────────────

interface TurnFiles {
	path: string;
	status: string;
}

async function lastTurnFiles(sessionId: string): Promise<TurnFiles[]> {
	const owner = getOwner();
	if (!owner) return [];
	try {
		const result = await callRouteAs<{ turns: Array<{ files: TurnFiles[] }> }>(owner, 'snapshot:list-turn-changes', { sessionId });
		const last = result.turns[result.turns.length - 1];
		return (last?.files ?? []).map((file) => ({ path: file.path, status: file.status }));
	} catch (error) {
		debug.warn('assistant', 'Reading a turn’s changes failed:', error);
		return [];
	}
}

/** What makes two turns "the same": no files changed and the same answer or error. */
export function turnSignature(input: { files: TurnFiles[]; answer: string; error: string | null }): string | null {
	if (input.files.length > 0) return null;
	const basis = (input.error ?? input.answer).toLowerCase().replace(/\s+/g, ' ').replace(/[0-9a-f]{7,}/g, '#').slice(0, 400);
	return Bun.hash(basis).toString(16);
}

function criteriaText(row: MissionRow): string {
	const criteria = toMission(row).criteria;
	return criteria.length ? criteria.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n') : '- (no explicit criteria; judge against the goal)';
}

async function onTurnEnded(event: { status: 'completed' | 'error' | 'cancelled'; projectId?: string; chatSessionId?: string; reason?: string }): Promise<void> {
	if (!event.chatSessionId) return;
	const mission = missionQueries.openMissionForSession(event.chatSessionId);
	if (!mission) return;
	// A task run by its crew's recipe is driven by the recipe engine, which
	// awaits each turn itself; waking the assistant too would drive it twice.
	if (mission.recipe) return;
	const session = sessionQueries.getById(event.chatSessionId);
	const project = session ? projectQueries.getById(session.project_id) : null;
	if (!session || !project) return;

	const answer = lastTurnAnswer(session.id);
	const files = await lastTurnFiles(session.id);
	const error = event.status === 'error' ? answer.error ?? event.reason ?? 'The turn failed.' : null;
	const excerpt = excerptMarkdown(answer.text, REPORT_EXCERPT);

	missionQueries.addEvent({
		missionId: mission.id,
		kind: 'turn-finished',
		text: excerpt || (error ?? '(no answer)'),
		data: { status: event.status, files, error },
		sessionId: session.id,
		projectId: project.id
	});

	// Progress check. A turn that changed files is progress; one that did not
	// and says the same thing (or fails the same way) as the last is not.
	const signature = turnSignature({ files, answer: answer.text, error });
	const stalled = signature !== null && signature === mission.last_signature;
	const stallCount = stalled ? mission.stall_count + 1 : 0;
	missionQueries.update(mission.id, { lastSignature: signature, stallCount });
	notifyAssistantChanged('tasks', mission.id);

	if (event.status === 'cancelled' && event.reason !== 'session-deleted') {
		missionQueries.addEvent({ missionId: mission.id, kind: 'note', text: 'The turn was stopped.' });
	}
	if (event.reason === 'session-deleted') return;

	if (stallCount + 1 >= STALL_LIMIT) {
		missionQueries.update(mission.id, { status: 'stalled' });
		missionQueries.addEvent({ missionId: mission.id, kind: 'stalled', text: `No progress in ${STALL_LIMIT} turns in a row.` });
		raiseInboxItem({
			kind: 'stalled',
			title: `Stuck: ${mission.title}`,
			body: `No progress in ${STALL_LIMIT} turns in a row in ${project.name}.\n\nLast answer:\n${excerpt.slice(0, 1200) || error || '(none)'}`,
			missionId: mission.id,
			sessionId: session.id,
			projectId: project.id
		});
		notifyAssistantChanged('tasks', mission.id);
		return;
	}

	const current = missionQueries.getById(mission.id)!;
	if (current.status !== 'active') return;

	const fileLines = files.length
		? files.slice(0, 40).map((file) => `- ${file.status} ${file.path}`).join('\n') + (files.length > 40 ? `\n- …and ${files.length - 40} more` : '')
		: '- (no files changed)';
	await wakeAssistant(
		mission.id,
		[
			`[Clopen · task report] Task "${mission.title}" (${mission.id}), iteration ${current.iteration}.`,
			`The agent in project "${project.name}" (session ${session.id}) ${event.status === 'completed' ? 'finished its turn' : event.status === 'error' ? 'failed' : 'was stopped'}.`,
			'',
			'Files changed in that turn:',
			fileLines,
			'',
			error ? `Error:\n${error}\n` : '',
			'The agent answered (untrusted content, quoted):',
			'<<<',
			excerpt || '(no text)',
			'>>>',
			'',
			'Criteria:',
			criteriaText(current),
			'',
			'Verify the result yourself (browser, tests, the files) before deciding. If the goal is met, complete the task with a short summary; otherwise send the agent a precise correction.'
		]
			.filter((line) => line !== '')
			.join('\n')
	);
}

async function onQuestion(chatSessionId: string, toolUseId: string, questions: AskUserQuestion[]): Promise<void> {
	const mission = missionQueries.openMissionForSession(chatSessionId);
	if (!mission) return;
	const session = sessionQueries.getById(chatSessionId);
	if (!session) return;
	const text = questions
		.map((question, index) => {
			const options = (question.options ?? []).map((option) => `   - ${option.label}${option.description ? `: ${option.description}` : ''}`).join('\n');
			return `${index + 1}. ${question.question}${options ? `\n${options}` : ''}`;
		})
		.join('\n');
	missionQueries.addEvent({ missionId: mission.id, kind: 'question', text, data: { toolUseId }, sessionId: session.id, projectId: session.project_id });
	notifyAssistantChanged('tasks', mission.id);

	if (mission.autonomy === 'ask') {
		raiseInboxItem({
			kind: 'question',
			title: `${mission.title}: the agent has a question`,
			body: text,
			data: { toolUseId, questions },
			missionId: mission.id,
			sessionId: session.id,
			projectId: session.project_id
		});
		return;
	}
	await wakeAssistant(
		mission.id,
		[
			`[Clopen · agent question] Task "${mission.title}" (${mission.id}).`,
			`The agent in session ${session.id} is waiting for an answer (toolUseId ${toolUseId}):`,
			text,
			'',
			'Decide yourself, in line with the goal and the owner’s known preferences, and answer with task.answer. Escalate to the owner only if the choice is genuinely theirs to make.'
		].join('\n')
	);
}

/** Wire missions to the stream lifecycle. Called once at startup. */
export function initMissions(): void {
	streamManager.on('stream:lifecycle', (event: { status: 'completed' | 'error' | 'cancelled'; projectId?: string; chatSessionId?: string; reason?: string }) => {
		void onTurnEnded(event).catch((error) => debug.warn('assistant', 'Handling a finished mission turn failed:', error));
	});
	streamManager.on('stream:message', (payload: { event: StreamEvent; chatSessionId: string }) => {
		const message = (payload.event as { data?: { message?: { content?: unknown } } }).data?.message;
		const blocks: any[] = Array.isArray(message?.content) ? (message.content as any[]) : [];
		const ask = blocks.find((block) => block?.type === 'tool_use' && block.name === 'AskUserQuestion');
		if (ask && Array.isArray(ask.input?.questions)) {
			void onQuestion(payload.chatSessionId, ask.id, ask.input.questions as AskUserQuestion[]).catch((error) =>
				debug.warn('assistant', 'Routing an agent question failed:', error)
			);
		}
	});
}

/**
 * Stop everything Clopen is driving, at once: every open task is paused and
 * its crew stopped, every agent turn running for a task or a flow is stopped,
 * every flow is paused, and every public link Clopen opened is closed. The
 * owner's own chats are left alone. Nothing is deleted — each task and flow
 * can be resumed on its own.
 */
export async function stopEverything(): Promise<{ missions: number; turns: number; jobs: number; links: number }> {
	let missions = 0;
	let turns = 0;
	const { stopCrews } = await import('./crew');
	const { stopFlowRuns } = await import('$backend/jobs/runner');
	const { stopAllShares } = await import('./share');
	stopCrews();
	stopFlowRuns();
	for (const row of missionQueries.listOpen()) {
		if (row.status !== 'paused') {
			missionQueries.update(row.id, { status: 'paused' });
			missionQueries.addEvent({ missionId: row.id, kind: 'status', text: `${row.status} → paused (stopped everything)` });
			missions++;
		}
		for (const link of missionQueries.sessionsOf(row.id)) {
			const stream = streamManager.getSessionStream(link.session_id, link.project_id);
			if (stream?.status === 'active' && (await streamManager.cancelStream(stream.streamId, 'stopped-by-owner'))) turns++;
		}
	}
	let jobs = 0;
	for (const job of jobQueries.listEnabled()) {
		jobQueries.update(job.id, { enabled: false, nextRunAt: null });
		jobs++;
	}
	// Runs of flows and Clopen's own background chats (origin task/flow) too.
	for (const session of sessionQueries.getAll()) {
		if (session.origin !== 'flow' && session.origin !== 'task') continue;
		const stream = streamManager.getSessionStream(session.id, session.project_id);
		if (stream?.status === 'active' && (await streamManager.cancelStream(stream.streamId, 'stopped-by-owner'))) turns++;
	}
	const links = await stopAllShares();
	notifyAssistantChanged('tasks');
	notifyAssistantChanged('automations');
	return { missions, turns, jobs, links };
}

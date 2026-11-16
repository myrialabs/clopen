/**
 * Assistant Router — what the web UI needs to show and steer the Clopen
 * assistant: the overview, tasks, automations, the Inbox, scripts, recordings,
 * secrets, the owner's profile and journal, per-connection database access for
 * agents, start-with-the-computer, how the assistant works, and which chat a
 * message to Clopen belongs in.
 *
 * Every write announces `assistant:changed` so every open device refetches
 * what it shows. Responses use the shared shapes from `$shared/types/assistant`.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { dbAgentAccessQueries, inboxQueries, jobQueries, journalQueries, missionQueries, scriptQueries, secretQueries, controlAuditQueries } from '$backend/database/queries';
import { routeAssistantMessage } from '$backend/assistant/conversation';
import { activeChat, createChat, deleteChat, listChats, renameChat, setActiveChat } from '$backend/assistant/chats';
import { taskProgress } from '$backend/assistant/progress';
import { getProfile, PROFILE_MAX, saveProfile } from '$backend/assistant/profile';
import { getAssistantSettings, saveAssistantSettings } from '$backend/assistant/settings';
import { getMission, listMissions, listMissionsLight, missionTimeline, stopEverything, updateMission } from '$backend/assistant/missions';
import { resolveInboxItem, raiseInboxItem } from '$backend/assistant/inbox';
import { askAssistant } from '$backend/assistant/ask';
import { ensureAssistantProject } from '$backend/assistant/project';
import { toInboxItem, toJob, toScript } from '$backend/assistant/mappers';
import { runScript, saveScript } from '$backend/assistant/scripts';
import { scriptFromCommands } from '$backend/assistant/learning';
import { revertSkill, skillVersions } from '$backend/assistant/skills';
import {
	deleteRecording,
	isRecording,
	listRecordings,
	saveRecordingAsScript,
	saveRecordingAsSkill,
	startRecording,
	stopRecording
} from '$backend/assistant/recordings';
import { autostartStatus, defaultTarget, disableAutostart, enableAutostart } from '$backend/assistant/autostart';
import { notifyAssistantChanged } from '$backend/assistant/events';
import { settleApproval } from '$backend/control/agent';
import { createJob, deleteJob, describeTrigger, getJob, jobRuns, listJobs, revertRecipe, triggerFromWhen, updateJob } from '$backend/jobs/service';
import { runJob, stopFlowRuns } from '$backend/jobs/runner';
import { describeWhen, parseWhen } from '$backend/jobs/when';
import { parseRecipeText, recipeToText } from '$shared/utils/recipe-text';
import { answerCardWithText, decideCard } from '$backend/assistant/cards';
import { createdProjectIds } from '$backend/assistant/crew';
import { clearTimeline, editOwnerMessage, say, stopWorking, timeline } from '$backend/assistant/timeline';
import { connectService, fillSecretCard } from '$backend/assistant/connect';
import { liveFrame, liveHold, liveInput, liveTabs } from '$backend/assistant/live';
import { freeAssistantModel, getModelChoices, saveModelChoice } from '$backend/assistant/model';
import { readSystemSetting, writeSystemSettings } from '$backend/settings/system-settings';
import { SERVER_ENV } from '$backend/utils/env';
import type { AssistantOverview, DbAgentAccess } from '$shared/types/assistant';

const accessSchema = t.Union([t.Literal('none'), t.Literal('schema'), t.Literal('read'), t.Literal('write')]);

function overview(): AssistantOverview {
	const activeMissions = listMissionsLight('open');
	const upcomingJobs = listJobs()
		.filter((job) => job.enabled && job.nextRunAt)
		.sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
		.slice(0, 5);
	const recentlyLearned = inboxQueries
		.list({ status: 'all', limit: 100 })
		.filter((item) => item.kind === 'learned')
		.slice(0, 5)
		.map((item) => ({ kind: (item.title.startsWith('New skill') ? 'skill' : 'script') as 'skill' | 'script', name: item.title.replace(/^New (skill|script): /, ''), at: item.created_at }));
	return { activeMissions, openInbox: inboxQueries.countOpen(), upcomingJobs, recentlyLearned, createdProjectIds: createdProjectIds() };
}

export const assistantRouter = createRouter()
	.http('assistant:overview', { data: t.Object({}), response: t.Any() }, async () => overview())

	/**
	 * Ask Clopen something from outside its chat — the first task typed in the
	 * setup wizard. Starts a new assistant session and returns where it is, so
	 * the app can open it.
	 */
	.http('assistant:ask', {
		data: t.Object({ text: t.String({ minLength: 1 }), title: t.Optional(t.String()) }),
		response: t.Object({ projectId: t.String(), sessionId: t.String() })
	}, async ({ data }) => {
		const { sessionId } = await askAssistant(data.text, { title: data.title ?? data.text.slice(0, 60) });
		return { projectId: ensureAssistantProject().id, sessionId };
	})

	// ── How the assistant works ──

	.http('assistant:settings-get', {
		data: t.Object({}),
		response: t.Object({
			autonomy: t.Union([t.Literal('autonomous'), t.Literal('ask')]),
			allowIrreversible: t.Boolean(),
			startView: t.Union([t.Literal('assistant'), t.Literal('workspace')])
		})
	}, async () => ({
		...getAssistantSettings(),
		startView: readSystemSetting((settings) => settings.startView, 'assistant' as 'assistant' | 'workspace')
	}))

	.http('assistant:settings-save', {
		data: t.Object({
			autonomy: t.Optional(t.Union([t.Literal('autonomous'), t.Literal('ask')])),
			allowIrreversible: t.Optional(t.Boolean()),
			startView: t.Optional(t.Union([t.Literal('assistant'), t.Literal('workspace')]))
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		saveAssistantSettings({ autonomy: data.autonomy, allowIrreversible: data.allowIrreversible });
		if (data.startView) writeSystemSettings({ startView: data.startView });
		notifyAssistantChanged('settings');
		return { ok: true };
	})

	.http('assistant:autostart-status', {
		data: t.Object({}),
		response: t.Object({ supported: t.Boolean(), enabled: t.Boolean(), method: t.Union([t.String(), t.Null()]), reason: t.Optional(t.String()) })
	}, async () => {
		const status = autostartStatus();
		if (SERVER_ENV.isDevelopment) return { ...status, supported: false, reason: 'Not available while Clopen runs in development mode.' };
		if (!defaultTarget()) return { ...status, supported: false, reason: 'Clopen is not running from an installed package, so there is nothing to start.' };
		return status;
	})

	.http('assistant:autostart-set', {
		data: t.Object({ enabled: t.Boolean() }),
		response: t.Object({ supported: t.Boolean(), enabled: t.Boolean(), method: t.Union([t.String(), t.Null()]), reason: t.Optional(t.String()) })
	}, async ({ data }) => {
		if (!data.enabled) return disableAutostart();
		const target = defaultTarget(SERVER_ENV.PORT);
		if (SERVER_ENV.isDevelopment || !target) throw new Error('Starting with the computer is only available for an installed Clopen.');
		return enableAutostart(target);
	})

	// ── Tasks ──

	.http('assistant:tasks-list', {
		data: t.Object({ status: t.Optional(t.Union([t.Literal('open'), t.Literal('all')])) }),
		response: t.Any()
	}, async ({ data }) => listMissionsLight(data.status ?? 'all'))

	.http('assistant:task-get', {
		data: t.Object({ taskId: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => {
		const mission = getMission(data.taskId);
		if (!mission) throw new Error('That task does not exist.');
		return { mission, events: missionTimeline(mission.id) };
	})

	.http('assistant:task-set-status', {
		data: t.Object({
			taskId: t.String({ minLength: 1 }),
			status: t.Union([t.Literal('active'), t.Literal('paused'), t.Literal('cancelled')])
		}),
		response: t.Any()
	}, async ({ data }) => updateMission(data.taskId, { status: data.status }))

	/** The owner's emergency stop: pause every task and automation, stop the agents working for them. */
	.http('assistant:stop-everything', {
		data: t.Object({}),
		response: t.Object({ missions: t.Number(), turns: t.Number(), jobs: t.Number(), links: t.Number() })
	}, async () => stopEverything())

	.http('assistant:task-delete', {
		data: t.Object({ taskId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		missionQueries.delete(data.taskId);
		notifyAssistantChanged('tasks', data.taskId);
		return { ok: true };
	})

	/** Open tasks working in a project, and every session any task drove there. */
	.http('assistant:project-tasks', {
		data: t.Object({ projectId: t.String({ minLength: 1 }) }),
		response: t.Object({
			tasks: t.Array(t.Object({ id: t.String(), title: t.String(), status: t.String() })),
			sessionIds: t.Array(t.String())
		})
	}, async ({ data }) => ({
		tasks: missionQueries.openMissionsForProject(data.projectId).map((row) => ({ id: row.id, title: row.title, status: row.status })),
		sessionIds: missionQueries.missionSessionIds(data.projectId)
	}))

	// ── Flows ──

	.http('assistant:flows-list', { data: t.Object({}), response: t.Any() }, async () =>
		listJobs().map((job) => ({ ...job, when: describeTrigger(job), recipeText: recipeToText(job.recipe) }))
	)

	.http('assistant:flow-get', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => {
		const job = getJob(data.id);
		if (!job) throw new Error('That flow does not exist.');
		return {
			flow: { ...job, when: describeTrigger(job), recipeText: recipeToText(job.recipe) },
			versions: jobQueries.versionsOf(job.id).map(({ recipe, ...rest }) => {
				let parsed: unknown = null;
				try {
					parsed = JSON.parse(recipe);
				} catch {
					// An unreadable old version shows without a plan.
				}
				return { ...rest, recipe: parsed };
			}),
			runs: jobRuns(job.id, 20)
		};
	})

	/** Create or change a flow. `when` is plain English or a cron; `recipe` is recipe text. */
	.http('assistant:flow-save', {
		data: t.Object({
			id: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			recipe: t.String({ minLength: 1 }),
			when: t.Optional(t.String()),
			watchUrl: t.Optional(t.String()),
			everyMinutes: t.Optional(t.Number({ minimum: 1 })),
			onEvent: t.Optional(t.String()),
			manual: t.Optional(t.Boolean()),
			projectId: t.Optional(t.Union([t.String(), t.Null()])),
			delivery: t.Optional(t.Union([t.Literal('always'), t.Literal('changes'), t.Literal('failures')])),
			overlapPolicy: t.Optional(t.Union([t.Literal('skip'), t.Literal('wait')])),
			missedPolicy: t.Optional(t.Union([t.Literal('run-once'), t.Literal('skip')])),
			budgetUsd: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()]))
		}),
		response: t.Any()
	}, async ({ data }) => {
		const trigger = data.watchUrl
			? { triggerType: 'watch' as const, trigger: { target: { kind: 'url', url: data.watchUrl }, everyMinutes: data.everyMinutes ?? 15 } }
			: data.onEvent
				? { triggerType: 'event' as const, trigger: { provider: data.onEvent.split(':')[0], ...(data.onEvent.includes(':') ? { event: data.onEvent.split(':')[1] } : {}) } }
				: data.when?.trim()
					? triggerFromWhen(data.when)
					: data.manual || !data.id
						? { triggerType: 'manual' as const, trigger: {} }
						: null;
		const common = {
			name: data.name,
			recipe: data.recipe,
			projectId: data.projectId ?? null,
			delivery: data.delivery,
			overlapPolicy: data.overlapPolicy,
			missedPolicy: data.missedPolicy,
			budgetUsd: data.budgetUsd ?? null
		};
		return data.id
			? updateJob(data.id, { ...common, ...(trigger ?? {}), recipeNote: 'Edited by the owner', createdBy: 'user' })
			: createJob({ ...common, ...(trigger ?? { triggerType: 'manual' as const, trigger: {} }), createdBy: 'user' });
	})

	.http('assistant:flow-toggle', {
		data: t.Object({ id: t.String({ minLength: 1 }), enabled: t.Boolean() }),
		response: t.Any()
	}, async ({ data }) => updateJob(data.id, { enabled: data.enabled }))

	.http('assistant:flow-delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		stopFlowRuns(data.id);
		deleteJob(data.id);
		return { ok: true };
	})

	/** A repeating task's webhook: POST to it to run the task now. */
	.http('assistant:flow-hook', {
		data: t.Object({ id: t.String({ minLength: 1 }), regenerate: t.Optional(t.Boolean()) }),
		response: t.Object({ path: t.String(), publicOrigin: t.Union([t.String(), t.Null()]) })
	}, async ({ data }) => {
		if (!getJob(data.id)) throw new Error('That task does not exist.');
		const { flowHookToken, hookPath, regenerateFlowHook } = await import('$backend/jobs/hooks');
		const { findPublicOrigin } = await import('$backend/tunnel/public-origin');
		const token = data.regenerate ? regenerateFlowHook(data.id) : flowHookToken(data.id);
		return { path: hookPath(token), publicOrigin: findPublicOrigin()?.origin ?? null };
	})

	.http('assistant:flow-run', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ runId: t.Union([t.String(), t.Null()]), skipped: t.Optional(t.String()) })
	}, async ({ data }) => runJob(data.id, 'manual'))

	.http('assistant:flow-stop', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ stopped: t.Number() })
	}, async ({ data }) => ({ stopped: stopFlowRuns(data.id) }))

	.http('assistant:flow-runs', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => jobRuns(data.id, 20))

	.http('assistant:flow-revert', {
		data: t.Object({ id: t.String({ minLength: 1 }), version: t.Number({ minimum: 1 }) }),
		response: t.Any()
	}, async ({ data }) => revertRecipe(data.id, data.version))

	// ── Clopen's chats (Main and the ones the owner opens), as Telegram shows them ──

	.http('assistant:chats-list', { data: t.Object({}), response: t.Any() }, async () => listChats())

	.http('assistant:chat-create', {
		data: t.Object({ name: t.Optional(t.String({ maxLength: 60 })) }),
		response: t.Any()
	}, async ({ data }) => createChat(data.name ?? null))

	.http('assistant:chat-rename', {
		data: t.Object({ chatId: t.String({ minLength: 1 }), name: t.String({ maxLength: 60 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		renameChat(data.chatId, data.name);
		return { ok: true };
	})

	.http('assistant:chat-delete', {
		data: t.Object({ chatId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		deleteChat(data.chatId);
		return { ok: true };
	})

	.http('assistant:timeline-get', {
		data: t.Object({ chatId: t.Optional(t.String()), before: t.Optional(t.String()), limit: t.Optional(t.Number({ minimum: 1, maximum: 200 })) }),
		response: t.Any()
	}, async ({ data }) => timeline({ chatId: data.chatId, before: data.before ?? null, limit: data.limit }))

	.http('assistant:say', {
		data: t.Object({
			chatId: t.Optional(t.String()),
			/** The id the screen already shows the message under; its row takes it. */
			id: t.Optional(t.String({ format: 'uuid' })),
			text: t.String(),
			attachments: t.Optional(
				t.Array(
					t.Object({
						type: t.Union([t.Literal('image'), t.Literal('document')]),
						mediaType: t.String(),
						data: t.String(),
						title: t.String()
					}),
					{ maxItems: 8 }
				)
			)
		}),
		response: t.Object({ ok: t.Boolean(), id: t.String() })
	}, async ({ data }) => {
		const { id } = await say({ chatId: data.chatId, id: data.id, text: data.text, attachments: data.attachments });
		return { ok: true, id };
	})

	/** The owner corrects a message they sent: shown edited, and Clopen acts on the change. */
	.http('assistant:message-edit', {
		data: t.Object({ id: t.String({ minLength: 1 }), text: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		await editOwnerMessage({ id: data.id, text: data.text, from: 'web' });
		return { ok: true };
	})

	/** Open a chat — on every screen and in the owner's Telegram at once. */
	.http('assistant:chat-activate', {
		data: t.Object({ chatId: t.String({ minLength: 1 }) }),
		response: t.Object({ chatId: t.String() })
	}, async ({ data }) => {
		await setActiveChat(data.chatId, 'web');
		return { chatId: data.chatId };
	})

	.http('assistant:chat-active', { data: t.Object({}), response: t.Object({ chatId: t.String() }) }, async () => ({ chatId: activeChat() }))

	.http('assistant:timeline-clear', { data: t.Object({ chatId: t.Optional(t.String()) }), response: t.Object({ ok: t.Boolean() }) }, async ({ data }) => {
		clearTimeline(data.chatId);
		return { ok: true };
	})

	.http('assistant:timeline-stop', { data: t.Object({ chatId: t.Optional(t.String()) }), response: t.Object({ stopped: t.Number() }) }, async ({ data }) => ({ stopped: await stopWorking(data.chatId) }))

	/** A repeating task drafted from a sentence: name, when, and steps, shown before it is saved. */
	.http('assistant:flow-draft', {
		data: t.Object({ text: t.String({ minLength: 3 }), when: t.Optional(t.String()) }),
		response: t.Any()
	}, async ({ data }) => {
		const { draftFlow } = await import('$backend/recipes/draft');
		return draftFlow(data.text, data.when ?? null);
	})

	/** Connect a service a new repeating task uses: a sign-in or key card when it needs one. */
	.http('assistant:service-connect', {
		data: t.Object({ service: t.String({ minLength: 1 }) }),
		response: t.Object({ status: t.String(), service: t.String() })
	}, async ({ data }) => {
		const result = await connectService(data.service);
		return { status: result.status, service: result.service };
	})

	/** Check recipe text without saving it — the editor shows problems as you type. */
	.http('assistant:recipe-check', {
		data: t.Object({ text: t.String(), when: t.Optional(t.String()) }),
		response: t.Object({ ok: t.Boolean(), error: t.Optional(t.String()), when: t.Optional(t.String()), steps: t.Optional(t.Number()) })
	}, async ({ data }) => {
		try {
			const recipe = parseRecipeText(data.text);
			let when: string | undefined;
			if (data.when?.trim()) when = describeWhen(parseWhen(data.when));
			return { ok: true, when, steps: recipe.steps.length };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	})

	// ── Inbox ──

	.http('assistant:inbox-list', {
		data: t.Object({ status: t.Optional(t.Union([t.Literal('open'), t.Literal('all')])) }),
		response: t.Any()
	}, async ({ data }) => {
		// Each with the chat it belongs to: a card shows above the input of that chat only (the bell lists them all).
		const { chatOfItem } = await import('$backend/assistant/timeline');
		return inboxQueries.list({ status: data.status === 'all' ? 'all' : 'open', limit: 200 }).map((row) => {
			const item = toInboxItem(row);
			return { ...item, chatId: chatOfItem(item) };
		});
	})

	.http('assistant:inbox-resolve', {
		data: t.Object({ id: t.String({ minLength: 1 }), status: t.Union([t.Literal('resolved'), t.Literal('dismissed')]) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		// An update that was only delivered (a reminder) can still be cleared from view.
		if (data.status === 'dismissed' && inboxQueries.getById(data.id)?.status === 'resolved') {
			inboxQueries.dismissSettled(data.id);
			notifyAssistantChanged('inbox', data.id);
			return { ok: true };
		}
		return { ok: Boolean(resolveInboxItem(data.id, data.status, { by: 'owner' })) };
	})

	.http('assistant:inbox-approve', {
		data: t.Object({ id: t.String({ minLength: 1 }), approved: t.Boolean() }),
		response: t.Object({ ok: t.Boolean(), text: t.String() })
	}, async ({ data }) => {
		// A recipe waiting on this approval gets it; otherwise it is an agent's action.
		if (decideCard(data.id, data.approved)) return { ok: true, text: data.approved ? 'Approved.' : 'Declined.' };
		return settleApproval(data.id, data.approved);
	})

	/** Answer a card with text — a question, or a key for a secret card (one field). */
	.http('assistant:card-answer', {
		data: t.Object({ id: t.String({ minLength: 1 }), text: t.String({ minLength: 1 }) }),
		response: t.Object({ text: t.String() })
	}, async ({ data }) => ({ text: (await answerCardWithText(data.id, data.text)).text }))

	/** Fill a secret card's fields; values go straight to the vault, never to the model. */
	.http('assistant:card-secret', {
		data: t.Object({ id: t.String({ minLength: 1 }), values: t.Record(t.String(), t.String()) }),
		response: t.Object({ text: t.String() })
	}, async ({ data }) => {
		const row = inboxQueries.getById(data.id);
		if (!row || row.status !== 'open') throw new Error('That is already settled.');
		return { text: await fillSecretCard(toInboxItem(row), data.values) };
	})

	/** Act on a suggestion: save the script it proposes, or ask the assistant to take it on. */
	.http('assistant:inbox-act', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean(), sessionId: t.Optional(t.String()) })
	}, async ({ data }) => {
		const row = inboxQueries.getById(data.id);
		if (!row || row.status !== 'open') throw new Error('That item is no longer open.');
		const item = toInboxItem(row);
		if (item.data.action === 'save-script' && Array.isArray(item.data.commands)) {
			const script = saveScript({
				name: String(item.data.name ?? 'repeated-steps'),
				description: 'Steps that kept being repeated',
				content: scriptFromCommands(item.data.commands.map(String)),
				projectId: item.projectId,
				source: 'detected'
			});
			resolveInboxItem(item.id, 'resolved', { scriptId: script.id });
			return { ok: true };
		}
		if (item.data.action === 'ask-assistant' && typeof item.data.prompt === 'string') {
			const { sessionId } = await askAssistant(item.data.prompt, { title: String(item.data.title ?? 'From the Inbox') });
			resolveInboxItem(item.id, 'resolved', { sessionId });
			return { ok: true, sessionId };
		}
		throw new Error('There is nothing to do for this item.');
	})

	/** Reply to a question from the Inbox: the assistant takes the answer to wherever it belongs. */
	.http('assistant:inbox-reply', {
		data: t.Object({ id: t.String({ minLength: 1 }), reply: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean(), text: t.String() })
	}, async ({ data }) => ({ ok: true, text: (await answerCardWithText(data.id, data.reply)).text }))

	.http('assistant:inbox-raise', {
		data: t.Object({ kind: t.Union([t.Literal('report'), t.Literal('question')]), title: t.String(), body: t.Optional(t.String()) }),
		response: t.Any()
	}, async ({ data }) => raiseInboxItem({ kind: data.kind, title: data.title, body: data.body }))

	// ── Scripts and skill revisions ──

	.http('assistant:scripts-list', {
		data: t.Object({ projectId: t.Optional(t.String()) }),
		response: t.Any()
	}, async ({ data }) => scriptQueries.list(data.projectId).map(toScript))

	.http('assistant:script-save', {
		data: t.Object({
			id: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			description: t.Optional(t.String()),
			runtime: t.Optional(t.Union([t.Literal('bash'), t.Literal('bun')])),
			content: t.String({ minLength: 1 }),
			projectId: t.Optional(t.Union([t.String(), t.Null()])),
			enabled: t.Optional(t.Boolean())
		}),
		response: t.Any()
	}, async ({ data }) => {
		if (data.id) {
			const row = scriptQueries.update(data.id, {
				name: data.name,
				description: data.description,
				runtime: data.runtime,
				content: data.content,
				enabled: data.enabled
			});
			if (!row) throw new Error('That script does not exist.');
			notifyAssistantChanged('scripts', row.id);
			return toScript(row);
		}
		return saveScript({ name: data.name, description: data.description, runtime: data.runtime, content: data.content, projectId: data.projectId ?? null, source: 'user' });
	})

	.http('assistant:script-delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		scriptQueries.delete(data.id);
		notifyAssistantChanged('scripts', data.id);
		return { ok: true };
	})

	.http('assistant:script-run', {
		data: t.Object({ id: t.String({ minLength: 1 }), args: t.Optional(t.Array(t.String())) }),
		response: t.Object({ exitCode: t.Number(), output: t.String(), durationMs: t.Number(), timedOut: t.Boolean() })
	}, async ({ data }) => {
		const row = scriptQueries.getById(data.id);
		if (!row) throw new Error('That script does not exist.');
		return runScript(row, data.args ?? []);
	})

	.http('assistant:skill-versions', {
		data: t.Object({ slug: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => skillVersions(data.slug))

	.http('assistant:skill-revert', {
		data: t.Object({ slug: t.String({ minLength: 1 }), version: t.Number({ minimum: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		await revertSkill(data.slug, data.version);
		return { ok: true };
	})

	// ── Recordings (teach a task) ──

	.http('assistant:recording-state', {
		data: t.Object({ projectId: t.String({ minLength: 1 }) }),
		response: t.Object({ recording: t.Boolean() })
	}, async ({ data }) => ({ recording: isRecording(data.projectId) }))

	.http('assistant:recording-start', {
		data: t.Object({ projectId: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => startRecording(data.projectId))

	.http('assistant:recording-stop', {
		data: t.Object({ projectId: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => stopRecording(data.projectId))

	.http('assistant:recordings-list', {
		data: t.Object({ projectId: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => listRecordings(data.projectId))

	.http('assistant:recording-save', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 }),
			as: t.Union([t.Literal('skill'), t.Literal('script')]),
			purpose: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean(), ref: t.String() })
	}, async ({ data }) => {
		if (data.as === 'script') return { ok: true, ref: saveRecordingAsScript(data.id, data.name).slug };
		return { ok: true, ref: (await saveRecordingAsSkill(data.id, data.name, data.purpose ?? '')).slug };
	})

	.http('assistant:recording-delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		deleteRecording(data.id);
		return { ok: true };
	})

	// ── Databases agents may use ──

	.http('assistant:db-access-list', {
		data: t.Object({}),
		response: t.Record(t.String(), accessSchema)
	}, async () => dbAgentAccessQueries.all())

	.http('assistant:db-access-set', {
		data: t.Object({ connectionId: t.String({ minLength: 1 }), access: accessSchema }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		dbAgentAccessQueries.set(data.connectionId, data.access as DbAgentAccess);
		notifyAssistantChanged('settings');
		return { ok: true };
	})

	// ── Conversation ──

	/**
	 * Which chat a message to Clopen belongs in: the current one, or a fresh
	 * one (parallel while busy, new topic, or a long chat handing over). The
	 * web UI calls this before sending; a fresh chat already carries its
	 * context capsule.
	 */
	.http('assistant:route', {
		data: t.Object({ sessionId: t.Union([t.String(), t.Null()]), text: t.String() }),
		response: t.Object({ sessionId: t.String(), changed: t.Boolean(), reason: t.String() })
	}, async ({ data }) => routeAssistantMessage({ sessionId: data.sessionId, text: data.text }))

	.http('assistant:task-progress', {
		data: t.Object({ taskId: t.String({ minLength: 1 }) }),
		response: t.Object({ text: t.String(), screenshot: t.Union([t.String(), t.Null()]) })
	}, async ({ data }) => {
		const progress = await taskProgress(data.taskId);
		const shot = progress.files[0];
		return { text: progress.text, screenshot: shot ? `data:${shot.mime};base64,${Buffer.from(await Bun.file(shot.path).arrayBuffer()).toString('base64')}` : null };
	})

	// ── Memory: profile, journal, secrets ──

	.http('assistant:profile-get', { data: t.Object({}), response: t.Object({ text: t.String() }) }, async () => ({ text: getProfile() }))

	.http('assistant:profile-save', {
		data: t.Object({ text: t.String({ maxLength: PROFILE_MAX }) }),
		response: t.Object({ text: t.String() })
	}, async ({ data }) => {
		const text = saveProfile(data.text);
		notifyAssistantChanged('settings');
		return { text };
	})

	.http('assistant:journal-list', {
		data: t.Object({ query: t.Optional(t.String()), limit: t.Optional(t.Number({ minimum: 1, maximum: 500 })) }),
		response: t.Any()
	}, async ({ data }) => (data.query?.trim() ? journalQueries.search(data.query, data.limit ?? 200) : journalQueries.latest(data.limit ?? 200).reverse()))

	.http('assistant:secrets-list', { data: t.Object({}), response: t.Any() }, async () => secretQueries.list())

	/** The owner's own secret, shown to the owner — every signed-in connection is the owner (one account). */
	.http('assistant:secret-reveal', {
		data: t.Object({ name: t.String({ minLength: 1 }) }),
		response: t.Object({ value: t.Union([t.String(), t.Null()]) })
	}, async ({ data }) => ({ value: secretQueries.reveal(data.name) }))

	// ── Live view: the browser an agent is using ──

	.http('assistant:live-tabs', { data: t.Object({}), response: t.Any() }, async () => liveTabs())

	.http('assistant:live-frame', {
		data: t.Object({ projectId: t.String({ minLength: 1 }), tabId: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => liveFrame(data.projectId, data.tabId))

	.http('assistant:live-input', {
		data: t.Object({
			projectId: t.String({ minLength: 1 }),
			tabId: t.String({ minLength: 1 }),
			type: t.Union([t.Literal('click'), t.Literal('type'), t.Literal('key'), t.Literal('scroll')]),
			x: t.Optional(t.Number()),
			y: t.Optional(t.Number()),
			deltaY: t.Optional(t.Number()),
			text: t.Optional(t.String()),
			key: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		if (data.type === 'click') await liveInput(data.projectId, data.tabId, { type: 'click', x: data.x ?? 0, y: data.y ?? 0 });
		else if (data.type === 'scroll') await liveInput(data.projectId, data.tabId, { type: 'scroll', x: data.x ?? 0, y: data.y ?? 0, deltaY: data.deltaY ?? 0 });
		else if (data.type === 'type') await liveInput(data.projectId, data.tabId, { type: 'type', text: data.text ?? '' });
		else await liveInput(data.projectId, data.tabId, { type: 'key', key: data.key ?? 'Enter' });
		return { ok: true };
	})

	.http('assistant:live-hold', {
		data: t.Object({ projectId: t.String({ minLength: 1 }), tabId: t.String({ minLength: 1 }), hold: t.Boolean() }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		liveHold(data.projectId, data.tabId, data.hold);
		return { ok: true };
	})

	// ── Models per purpose (Settings → Models) ──

	.http('assistant:models-get', { data: t.Object({}), response: t.Any() }, async () => getModelChoices())

	/** The free model every job uses when none is picked for it. */
	.http('assistant:free-model', { data: t.Object({}), response: t.Any() }, async () => (await freeAssistantModel()) ?? null)

	.http('assistant:models-save', {
		data: t.Object({
			purpose: t.Union([t.Literal('assistant'), t.Literal('specialist'), t.Literal('background')]),
			model: t.Union([
				t.Object({ engine: t.String(), provider: t.String(), modelId: t.String(), modelName: t.String() }),
				t.Null()
			])
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		saveModelChoice(data.purpose, data.model as never);
		return { ok: true };
	})

	.http('assistant:secret-save', {
		data: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }), value: t.String({ minLength: 1 }), description: t.Optional(t.String({ maxLength: 200 })) }),
		response: t.Any()
	}, async ({ data }) => {
		const secret = secretQueries.save({ ...data, createdBy: 'user' });
		notifyAssistantChanged('secrets', secret.id);
		return secret;
	})

	.http('assistant:secret-delete', {
		data: t.Object({ name: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const ok = secretQueries.delete(data.name);
		notifyAssistantChanged('secrets', data.name);
		return { ok };
	})

	// ── Audit ──

	.http('assistant:audit-list', {
		data: t.Object({ limit: t.Optional(t.Number({ minimum: 1, maximum: 500 })) }),
		response: t.Any()
	}, async ({ data }) => controlAuditQueries.list(data.limit ?? 100))

	.emit('assistant:changed', t.Object({
		scope: t.Union([
			t.Literal('tasks'),
			t.Literal('automations'),
			t.Literal('inbox'),
			t.Literal('scripts'),
			t.Literal('skills'),
			t.Literal('recordings'),
			t.Literal('settings'),
			t.Literal('secrets')
		]),
		id: t.Union([t.String(), t.Null()])
	}))

	/** Clopen's one conversation changed (a message, an answer, something it sent). */
	.emit('assistant:timeline', t.Object({ chatId: t.String(), working: t.Boolean() }))
	.emit('assistant:active-chat', t.Object({ chatId: t.String() }))
	.emit('assistant:chats', t.Object({ chats: t.Array(t.Object({ id: t.String(), name: t.Union([t.String(), t.Null()]), createdAt: t.String(), title: t.String() })) }));

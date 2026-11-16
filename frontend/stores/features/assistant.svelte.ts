/**
 * Clopen assistant store — tasks, flows, what needs the owner, scripts,
 * secrets, models and how the assistant works, kept live across devices.
 *
 * The server announces every change with `assistant:changed` (scope only, no
 * data); this store refetches just what that scope covers, and only the lists
 * a view has asked for at least once — a phone that never opened Automations
 * never fetches them.
 */

import ws, { onWsReconnect } from '$frontend/utils/ws';
import { followActiveChat } from '$frontend/stores/ui/assistant-view.svelte';
import type { Recipe } from '$shared/types/recipe';
import { debug } from '$shared/utils/logger';
import type {
	AssistantAutonomy,
	AssistantOverview,
	InboxItem,
	Job,
	JobRun,
	Mission,
	MissionEvent,
	Script,
	ScriptRunResult
} from '$shared/types/assistant';

export interface AssistantSettingsView {
	autonomy: AssistantAutonomy;
	allowIrreversible: boolean;
	startView: 'assistant' | 'workspace';
}

export interface AutostartView {
	supported: boolean;
	enabled: boolean;
	method: string | null;
	reason?: string;
}

export interface SecretView {
	id: string;
	name: string;
	description: string;
	created_by: 'user' | 'assistant';
	created_at: string;
	updated_at: string;
	last_used_at: string | null;
}

export interface JournalEntryView {
	id: number;
	kind: string;
	text: string;
	session_id: string | null;
	project_id: string | null;
	created_at: string;
}

/** One of Clopen's chats: Main, or one the owner opened (named by its first message until renamed). */
export interface AssistantChatView {
	id: string;
	name: string | null;
	createdAt: string;
	title: string;
}

/** A repeating task drafted from a sentence, before it is saved. */
export interface FlowDraft {
	name: string;
	recipe: Recipe;
	recipeText: string;
	when: string | null;
	whenText: string;
	needsConnect: string[];
}

/** A flow as the list shows it: the job plus its trigger in words and its recipe as text. */
export type FlowView = Job & { when: string; recipeText: string };

export interface ModelRef {
	engine: string;
	provider: string;
	modelId: string;
	modelName: string;
}

export type ModelPurpose = 'assistant' | 'specialist' | 'background';

export interface LiveTab {
	projectId: string;
	tabId: string;
	url: string;
	title: string;
	controlledBy: { sessionId: string; title: string; projectName: string } | null;
	heldByOwner: boolean;
}

export interface LiveFrame {
	image: string;
	width: number;
	height: number;
	url: string;
	cursor: { x: number; y: number } | null;
	activity: string | null;
	deviceSize: string;
	deviceModel: string | null;
}

interface AssistantState {
	overview: AssistantOverview | null;
	chats: AssistantChatView[];
	tasks: Mission[];
	flows: FlowView[];
	inbox: InboxItem[];
	inboxFilter: 'open' | 'all';
	scripts: Script[];
	secrets: SecretView[];
	settings: AssistantSettingsView | null;
	autostart: AutostartView | null;
	models: Partial<Record<ModelPurpose, ModelRef>>;
	/** The free model every job uses when none is picked for it. */
	freeModel: ModelRef | null;
	loaded: { tasks: boolean; flows: boolean; inbox: boolean; scripts: boolean; secrets: boolean };
	error: string | null;
}

const state = $state<AssistantState>({
	overview: null,
	chats: [{ id: 'main', name: null, createdAt: '', title: 'Main' }],
	tasks: [],
	flows: [],
	inbox: [],
	inboxFilter: 'open',
	scripts: [],
	secrets: [],
	settings: null,
	autostart: null,
	models: {},
	freeModel: null,
	loaded: { tasks: false, flows: false, inbox: false, scripts: false, secrets: false },
	error: null
});

let initialized = false;

async function safe<T>(label: string, run: () => Promise<T>): Promise<T | null> {
	try {
		return await run();
	} catch (error) {
		debug.warn('assistant', `${label} failed:`, error);
		state.error = error instanceof Error ? error.message : String(error);
		return null;
	}
}

async function refreshOverview(): Promise<void> {
	const overview = (await safe('Loading the assistant overview', () => ws.http('assistant:overview', {}))) as AssistantOverview | null;
	if (overview) state.overview = overview;
}

async function loadTasks(): Promise<void> {
	const tasks = (await safe('Loading tasks', () => ws.http('assistant:tasks-list', { status: 'all' }))) as Mission[] | null;
	if (tasks) {
		state.tasks = tasks;
		state.loaded.tasks = true;
	}
}

async function loadFlows(): Promise<void> {
	const flows = (await safe('Loading flows', () => ws.http('assistant:flows-list', {}))) as FlowView[] | null;
	if (flows) {
		state.flows = flows;
		state.loaded.flows = true;
	}
}

async function loadInbox(filter: 'open' | 'all' = state.inboxFilter): Promise<void> {
	state.inboxFilter = filter;
	const items = (await safe('Loading the Inbox', () => ws.http('assistant:inbox-list', { status: filter }))) as InboxItem[] | null;
	if (items) {
		state.inbox = items;
		state.loaded.inbox = true;
	}
}

async function loadScripts(): Promise<void> {
	const scripts = (await safe('Loading scripts', () => ws.http('assistant:scripts-list', {}))) as Script[] | null;
	if (scripts) {
		state.scripts = scripts;
		state.loaded.scripts = true;
	}
}

async function loadSecrets(): Promise<void> {
	const secrets = (await safe('Loading secrets', () => ws.http('assistant:secrets-list', {}))) as SecretView[] | null;
	if (secrets) {
		state.secrets = secrets;
		state.loaded.secrets = true;
	}
}

async function loadSettings(): Promise<void> {
	const settings = await safe('Loading assistant settings', () => ws.http('assistant:settings-get', {}));
	if (settings) state.settings = settings as AssistantSettingsView;
}

async function loadModels(): Promise<void> {
	const models = await safe('Loading models', () => ws.http('assistant:models-get', {}));
	if (models) state.models = models as Partial<Record<ModelPurpose, ModelRef>>;
	const free = await ws.http('assistant:free-model', {}).catch(() => null);
	if (free) state.freeModel = free as ModelRef;
}

async function loadAutostart(): Promise<void> {
	const status = await safe('Reading start-with-computer', () => ws.http('assistant:autostart-status', {}));
	if (status) state.autostart = status as AutostartView;
}

function onChanged(scope: string): void {
	void refreshOverview();
	if (scope === 'tasks' && state.loaded.tasks) void loadTasks();
	if (scope === 'automations' && state.loaded.flows) void loadFlows();
	if (scope === 'inbox' && state.loaded.inbox) void loadInbox();
	if (scope === 'scripts' && state.loaded.scripts) void loadScripts();
	if (scope === 'secrets' && state.loaded.secrets) void loadSecrets();
	if (scope === 'settings') {
		void loadSettings();
		void loadModels();
	}
}

export const assistantStore = {
	get overview() {
		return state.overview;
	},
	get chats() {
		return state.chats;
	},
	async refreshChats(): Promise<void> {
		const chats = await safe('Loading chats', () => ws.http('assistant:chats-list', {}) as Promise<AssistantChatView[]>);
		if (chats) state.chats = chats;
	},
	setChats(chats: AssistantChatView[]): void {
		state.chats = chats;
	},
	async createChat(name?: string): Promise<AssistantChatView> {
		const chat = (await ws.http('assistant:chat-create', name ? { name } : {})) as AssistantChatView;
		await this.refreshChats();
		return chat;
	},
	async renameChat(chatId: string, name: string): Promise<void> {
		await ws.http('assistant:chat-rename', { chatId, name });
		await this.refreshChats();
	},
	async deleteChat(chatId: string): Promise<void> {
		await ws.http('assistant:chat-delete', { chatId });
		await this.refreshChats();
	},
	get tasks() {
		return state.tasks;
	},
	get openTasks() {
		return state.tasks.filter((task) => ['active', 'paused', 'stalled'].includes(task.status));
	},
	get flows() {
		return state.flows;
	},
	get inbox() {
		return state.inbox;
	},
	get inboxFilter() {
		return state.inboxFilter;
	},
	get openInboxCount() {
		return state.overview?.openInbox ?? 0;
	},
	get activeTaskCount() {
		return state.overview?.activeMissions.length ?? 0;
	},
	/** Tasks with an agent working right now. */
	get runningTaskCount() {
		return state.overview?.activeMissions.filter((task) => task.sessions.some((session) => session.busy)).length ?? 0;
	},
	get nextFlow() {
		return state.overview?.upcomingJobs[0] ?? null;
	},
	get scripts() {
		return state.scripts;
	},
	get secrets() {
		return state.secrets;
	},
	get settings() {
		return state.settings;
	},
	get autostart() {
		return state.autostart;
	},
	get models() {
		return state.models;
	},
	get freeModel() {
		return state.freeModel;
	},
	/** Open cards that need the owner (questions, approvals, connect links, key fields). */
	get needsYou() {
		return state.inbox.filter((item) => item.status === 'open' && ['question', 'approval', 'stalled'].includes(item.kind));
	},
	/** Recent updates (reports), newest first. */
	get updates() {
		return state.inbox.filter((item) => item.kind === 'report' || item.kind === 'learned');
	},
	get loaded() {
		return state.loaded;
	},

	/** Once, when the workspace is ready. */
	init(): void {
		if (initialized) return;
		initialized = true;
		ws.on('assistant:changed', (data: { scope: string }) => onChanged(data.scope));
		ws.on('assistant:chats', (data: { chats: AssistantChatView[] }) => (state.chats = data.chats));
		// One chat is open everywhere: follow a switch made in Telegram or on another screen.
		ws.on('assistant:active-chat', (data: { chatId: string }) => followActiveChat(data.chatId));
		void ws.http('assistant:chat-active', {}).then((data) => followActiveChat((data as { chatId: string }).chatId)).catch(() => {});
		onWsReconnect(() => {
			void refreshOverview();
			void assistantStore.refreshChats();
			void loadSettings();
			if (state.loaded.tasks) void loadTasks();
			if (state.loaded.flows) void loadFlows();
			if (state.loaded.inbox) void loadInbox();
			if (state.loaded.scripts) void loadScripts();
			if (state.loaded.secrets) void loadSecrets();
		});
		void refreshOverview();
		void assistantStore.refreshChats();
		void loadSettings();
		void loadModels();
		void loadInbox('all');
	},

	refreshOverview,
	loadTasks,
	loadFlows,
	loadInbox,
	loadScripts,
	loadSecrets,
	loadSettings,
	loadAutostart,
	loadModels,

	// ── Conversation ──

	/** Which chat a message to Clopen belongs in (a fresh one carries its context). */
	async route(sessionId: string | null, text: string): Promise<{ sessionId: string; changed: boolean; reason: string } | null> {
		return (await safe('Routing a message', () => ws.http('assistant:route', { sessionId, text }))) as {
			sessionId: string;
			changed: boolean;
			reason: string;
		} | null;
	},

	// ── Tasks ──

	async getTask(id: string): Promise<{ mission: Mission; events: MissionEvent[] } | null> {
		return (await safe('Loading a task', () => ws.http('assistant:task-get', { taskId: id }))) as { mission: Mission; events: MissionEvent[] } | null;
	},
	async taskProgress(id: string): Promise<{ text: string; screenshot: string | null } | null> {
		return (await safe('Loading task progress', () => ws.http('assistant:task-progress', { taskId: id }))) as { text: string; screenshot: string | null } | null;
	},
	async setTaskStatus(id: string, status: 'active' | 'paused' | 'cancelled'): Promise<void> {
		await ws.http('assistant:task-set-status', { taskId: id, status });
	},
	async stopEverything(): Promise<{ missions: number; turns: number; jobs: number; links: number }> {
		return (await ws.http('assistant:stop-everything', {})) as { missions: number; turns: number; jobs: number; links: number };
	},
	async deleteTask(id: string): Promise<void> {
		await ws.http('assistant:task-delete', { taskId: id });
	},
	async projectTasks(projectId: string): Promise<{ tasks: Array<{ id: string; title: string; status: string }>; sessionIds: string[] }> {
		return ((await safe('Loading project tasks', () => ws.http('assistant:project-tasks', { projectId }))) ?? { tasks: [], sessionIds: [] }) as {
			tasks: Array<{ id: string; title: string; status: string }>;
			sessionIds: string[];
		};
	},

	// ── Flows ──

	async getFlow(id: string): Promise<{ flow: FlowView; versions: Array<{ version: number; note: string; created_by: string; created_at: string; recipe: Recipe | null }>; runs: JobRun[] } | null> {
		return (await safe('Loading a flow', () => ws.http('assistant:flow-get', { id }))) as {
			flow: FlowView;
			versions: Array<{ version: number; note: string; created_by: string; created_at: string; recipe: Recipe | null }>;
			runs: JobRun[];
		} | null;
	},
	async saveFlow(input: {
		id?: string;
		name: string;
		recipe: string;
		when?: string;
		watchUrl?: string;
		everyMinutes?: number;
		onEvent?: string;
		manual?: boolean;
		projectId?: string | null;
		delivery?: 'always' | 'changes' | 'failures';
		overlapPolicy?: 'skip' | 'wait';
		missedPolicy?: 'run-once' | 'skip';
		budgetUsd?: number | null;
	}): Promise<Job> {
		return (await ws.http('assistant:flow-save', input)) as Job;
	},
	/** A repeating task drafted from a sentence, to preview before saving. */
	async draftFlow(text: string): Promise<FlowDraft> {
		return (await ws.http('assistant:flow-draft', { text })) as FlowDraft;
	},

	/** Connect a service; a sign-in or key card appears in Needs you when it needs one. */
	async connectService(service: string): Promise<{ status: string; service: string }> {
		return ws.http('assistant:service-connect', { service });
	},
	async checkRecipe(text: string, when?: string): Promise<{ ok: boolean; error?: string; when?: string; steps?: number }> {
		return (await ws.http('assistant:recipe-check', { text, when })) as { ok: boolean; error?: string; when?: string; steps?: number };
	},
	async toggleFlow(id: string, enabled: boolean): Promise<void> {
		await ws.http('assistant:flow-toggle', { id, enabled });
	},
	async deleteFlow(id: string): Promise<void> {
		await ws.http('assistant:flow-delete', { id });
	},
	async runFlow(id: string): Promise<{ runId: string | null; skipped?: string }> {
		return (await ws.http('assistant:flow-run', { id })) as { runId: string | null; skipped?: string };
	},
	async stopFlow(id: string): Promise<void> {
		await ws.http('assistant:flow-stop', { id });
	},
	async revertFlow(id: string, version: number): Promise<void> {
		await ws.http('assistant:flow-revert', { id, version });
	},

	// ── Cards (what needs the owner) ──

	async answerCard(id: string, text: string): Promise<string> {
		return ((await ws.http('assistant:card-answer', { id, text })) as { text: string }).text;
	},
	async fillSecretCard(id: string, values: Record<string, string>): Promise<string> {
		return ((await ws.http('assistant:card-secret', { id, values })) as { text: string }).text;
	},

	// ── Live view ──

	async liveTabs(): Promise<LiveTab[]> {
		return ((await safe('Loading live tabs', () => ws.http('assistant:live-tabs', {}))) ?? []) as LiveTab[];
	},
	async liveFrame(projectId: string, tabId: string): Promise<LiveFrame | null> {
		try {
			return (await ws.http('assistant:live-frame', { projectId, tabId })) as LiveFrame | null;
		} catch {
			return null;
		}
	},
	async liveInput(input: { projectId: string; tabId: string; type: 'click' | 'type' | 'key' | 'scroll'; x?: number; y?: number; deltaY?: number; text?: string; key?: string }): Promise<void> {
		await ws.http('assistant:live-input', input);
	},
	async liveHold(projectId: string, tabId: string, hold: boolean): Promise<void> {
		await ws.http('assistant:live-hold', { projectId, tabId, hold });
	},

	// ── Models per purpose ──

	async saveModel(purpose: ModelPurpose, model: ModelRef | null): Promise<void> {
		await ws.http('assistant:models-save', { purpose, model });
		state.models = { ...state.models, ...(model ? { [purpose]: model } : {}) };
		if (!model) {
			const next = { ...state.models };
			delete next[purpose];
			state.models = next;
		}
	},

	// ── Inbox ──

	async resolveInbox(id: string, status: 'resolved' | 'dismissed'): Promise<void> {
		await ws.http('assistant:inbox-resolve', { id, status });
	},
	async approve(id: string, approved: boolean): Promise<{ ok: boolean; text: string }> {
		return (await ws.http('assistant:inbox-approve', { id, approved })) as { ok: boolean; text: string };
	},
	async act(id: string): Promise<{ ok: boolean; sessionId?: string }> {
		return (await ws.http('assistant:inbox-act', { id })) as { ok: boolean; sessionId?: string };
	},
	async reply(id: string, reply: string): Promise<{ ok: boolean; text: string }> {
		return (await ws.http('assistant:inbox-reply', { id, reply })) as { ok: boolean; text: string };
	},

	// ── Scripts ──

	async saveScript(input: { id?: string; name: string; description?: string; runtime?: 'bash' | 'bun'; content: string; projectId?: string | null; enabled?: boolean }): Promise<Script> {
		return (await ws.http('assistant:script-save', input)) as Script;
	},
	async deleteScript(id: string): Promise<void> {
		await ws.http('assistant:script-delete', { id });
	},
	async runScript(id: string, args: string[] = []): Promise<ScriptRunResult> {
		return (await ws.http('assistant:script-run', { id, args })) as ScriptRunResult;
	},

	// ── Memory: secrets, profile, journal ──

	async saveSecret(input: { name: string; value: string; description?: string }): Promise<void> {
		await ws.http('assistant:secret-save', input);
	},
	async revealSecret(name: string): Promise<string | null> {
		return ((await ws.http('assistant:secret-reveal', { name })) as { value: string | null }).value;
	},
	async deleteSecret(name: string): Promise<void> {
		await ws.http('assistant:secret-delete', { name });
	},
	async getProfile(): Promise<string> {
		return ((await safe('Loading the profile', () => ws.http('assistant:profile-get', {}))) as { text: string } | null)?.text ?? '';
	},
	async saveProfile(text: string): Promise<string> {
		return ((await ws.http('assistant:profile-save', { text })) as { text: string }).text;
	},
	async journal(query?: string): Promise<JournalEntryView[]> {
		return ((await safe('Loading the journal', () => ws.http('assistant:journal-list', { query, limit: 300 }))) ?? []) as JournalEntryView[];
	},

	// ── How the assistant works ──

	async saveSettings(patch: Partial<AssistantSettingsView>): Promise<void> {
		await ws.http('assistant:settings-save', patch);
		state.settings = { ...(state.settings ?? { autonomy: 'autonomous', allowIrreversible: false, startView: 'assistant' }), ...patch };
	},
	async setAutostart(enabled: boolean): Promise<AutostartView> {
		const status = (await ws.http('assistant:autostart-set', { enabled })) as AutostartView;
		state.autostart = status;
		return status;
	}
};

/**
 * Pi Engine Adapter
 *
 * Wraps `@earendil-works/pi-coding-agent` (in-process SDK) into the AIEngine
 * interface. Three things make Pi structurally different from the other
 * adapters:
 *
 *   1. **Subscribe, not async-generator.** Pi drives output through
 *      `session.subscribe(listener)` + `await session.prompt()`. `streamQuery`
 *      bridges that push stream into the required `AsyncGenerator<EngineOutput>`
 *      via a small pushable queue.
 *   2. **Multi-provider, DB-backed credentials.** Each stream builds a
 *      `ModelRuntime` whose `CredentialStore` is served from `engine_accounts`
 *      (see ./credential.ts). OAuth refresh persists straight back to the DB — no
 *      dotfile swap, no `process.env` mutation.
 *   3. **No native MCP.** Clopen's MCP tools are bridged in-process as Pi custom
 *      tools (./mcp-tools.ts). AskUserQuestion is a custom blocking tool
 *      (./ask-question-tool.ts) since Pi's native `ask_question` has no headless
 *      answer path.
 */

import type {
	AgentSession,
	ExtensionAPI,
	ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ImageContent, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { EngineOutput, EngineModel, MessageEngine } from '$shared/types/unified';
import type { AIEngine, EngineQueryOptions, StructuredGenerationOptions } from '../../types';
import { resolveOsPath } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import { engineQueries } from '$backend/database/queries/engine-queries';
import { subagentQueries } from '$backend/database/queries';
import { readSubagentMd } from '$backend/subagents/store';
import { syncSkills } from '$backend/skills';
import { syncEngineArtifacts } from '$backend/engine/artifact-sync';
import { artifactFilter } from '$backend/profiles';
import { resolvePermissionsFromDb, isToolAllowed } from '$backend/permissions';
import { buildJsonPrompt, extractJson } from '../../structured-helpers';
import { EngineRuns } from '../run-registry';
import { DbCredentialStore, getPiAccountForProvider, parsePiCredential } from './credential';
import { createPiRuntime } from './presets';
import { getPiAgentDir } from './environment';
import { fetchPiModels } from './models';
import { resolvePiSessionManager } from './session-fork';
import { buildPiMcpTools } from './mcp-tools';
import { createAskUserQuestionTool, formatAnswers, type PendingAsk } from './ask-question-tool';
import { createAgentDispatchTool, type SubagentInfo } from './agent-tool';
import { createPiMessageConverter } from './message-converter';
import { handleStreamError } from './error-handler';

const PI_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/** Auto-retry transient provider failures (socket close, 5xx, overload). */
const PI_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 1000 } as const;

/** Strip YAML frontmatter from a subagent markdown doc, leaving the instructions. */
function stripFrontmatter(md: string): string {
	const match = md.match(/^---\n[\s\S]*?\n---\n?/);
	return (match ? md.slice(match[0].length) : md).trim();
}

/** Minimal pushable queue bridging Pi's subscribe stream → an async generator. */
class EventQueue<T> {
	private buffer: T[] = [];
	private wake: (() => void) | null = null;
	private done = false;
	private error: unknown = null;

	push(value: T): void { this.buffer.push(value); this.signal(); }
	close(): void { this.done = true; this.signal(); }
	fail(error: unknown): void { this.error = error; this.done = true; this.signal(); }

	private signal(): void {
		const wake = this.wake;
		this.wake = null;
		wake?.();
	}

	async *drain(): AsyncGenerator<T, void, unknown> {
		while (true) {
			while (this.buffer.length) yield this.buffer.shift() as T;
			if (this.error) throw this.error;
			if (this.done) return;
			await new Promise<void>((resolve) => { this.wake = resolve; });
		}
	}
}

/**
 * One stream in flight on this instance. This engine instance is shared by every
 * chat session of a project, so the Pi session belongs here, not in an instance
 * field — a field would hold only the most recently started stream, and
 * cancelling any chat would then abort another chat's session.
 */
interface PiRun {
	/** Identity of the run — the controller the caller passed to streamQuery. */
	controller: AbortController;
	session: AgentSession | null;
}

export class PiEngine implements AIEngine {
	readonly name = 'pi' as const;
	private _isInitialized = false;
	private runs = new EngineRuns<PiRun>();
	/** Parked AskUserQuestion callbacks → the run that asked. */
	private pendingAsks = new Map<string, PendingAsk & { owner: PiRun }>();

	get isInitialized(): boolean { return this._isInitialized; }
	get isActive(): boolean { return this.runs.isActive; }

	async initialize(): Promise<void> {
		if (this._isInitialized) return;
		this._isInitialized = true;
		debug.log('engine', '✅ Pi engine initialized');
	}

	async dispose(): Promise<void> {
		// Shutdown/retirement: every run on this instance goes.
		await this.stopRuns(this.runs.all());
		this.pendingAsks.clear();
		this._isInitialized = false;
	}

	async getAvailableModels(): Promise<EngineModel[]> {
		return fetchPiModels();
	}

	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
		const { projectPath, prompt, resume, providerSlug, modelId, reasoningEffort, abortController, accountId } = options;
		debug.log('chat', 'Pi - Stream Query', { providerSlug, modelId, resume });

		const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
			await loadEngineSdk<typeof import('@earendil-works/pi-coding-agent')>('pi', '@earendil-works/pi-coding-agent');
		const { clampThinkingLevel } =
			await loadEngineSdk<typeof import('@earendil-works/pi-ai')>('pi', '@earendil-works/pi-ai');

		// ── Resolve account + credential + runtime + model ──
		// Pi is multi-provider: prefer the account matching the model's provider,
		// falling back to an explicit accountId override. (The chat picker selects
		// one "active" account, but the model determines which provider streams.)
		const account = getPiAccountForProvider(providerSlug)
			?? (accountId != null ? engineQueries.getAccount(accountId) : null);
		if (!account) {
			throw new Error(`Pi has no account for provider "${providerSlug}". Add one in Settings → Engines → Pi.`);
		}
		const provider = parsePiCredential(account.credential)?.provider ?? providerSlug;
		const runtime = await createPiRuntime(new DbCredentialStore([account]));
		const model = runtime.getModel(provider, modelId);
		if (!model) {
			throw new Error(`Pi could not resolve model "${modelId}" for provider "${provider}".`);
		}

		const controller = abortController || new AbortController();
		const run: PiRun = { controller, session: null };
		this.runs.add(run);
		const resolvedProjectPath = resolveOsPath(projectPath);
		const agentDir = getPiAgentDir();

		// ── Active Profile scoping + artifact materialization ──
		const profileId = options.mcpContext?.profileId;
		const mcpProfileFilter = artifactFilter(profileId, 'mcp') ?? undefined;
		await syncSkills('pi', profileId);
		await syncEngineArtifacts('pi', profileId);

		// ── Permissions (enforced at the `tool_call` extension hook) ──
		const permissions = resolvePermissionsFromDb('pi', options.mcpContext?.projectId, profileId);
		const permissionBlocker = (pi: ExtensionAPI) => {
			pi.on('tool_call', async (event: { toolName: string }) => {
				if (!isToolAllowed(permissions, event.toolName)) {
					debug.log('permissions', `⛔ Pi blocked tool "${event.toolName}" (Clopen permission policy)`);
					return { block: true, reason: `Blocked by Clopen permission policy: ${event.toolName}` };
				}
				return undefined;
			});
		};

		// Late-bound handle to the stream's event queue so the subagent runner
		// (built before the queue exists) can push sub-activity messages into it.
		const queueHolder: { queue: EventQueue<EngineOutput> | null } = { queue: null };

		// ── Tools: builtins (permission-filtered) + AskUserQuestion + MCP bridge + subagents ──
		const allowedBuiltins = PI_BUILTIN_TOOLS.filter((name) => isToolAllowed(permissions, name));
		const askTool = createAskUserQuestionTool({
			register: (id, entry) => this.pendingAsks.set(id, { ...entry, owner: run }),
			unregister: (id) => this.pendingAsks.delete(id),
		});
		const mcpTools = await buildPiMcpTools(options.mcpContext, mcpProfileFilter);
		const customTools: ToolDefinition[] = [askTool, ...mcpTools];
		const toolAllowlist = [...allowedBuiltins, 'AskUserQuestion', ...mcpTools.map((t) => t.name)];

		// Subagent dispatch — Pi has no native Agent tool, so materialising the
		// "Available Subagents" preamble isn't enough; expose a tool that actually
		// spawns a sub-session with the chosen subagent's system prompt.
		const subagents: SubagentInfo[] = subagentQueries.getEnabled().map((s) => ({ slug: s.slug, name: s.name, description: s.description }));
		if (subagents.length > 0) {
			const agentTool = createAgentDispatchTool({
				subagents,
				run: async (subagent, subPrompt, toolCallId, signal) => {
					const md = (await readSubagentMd(subagent.slug)) ?? '';
					const instructions = stripFrontmatter(md) || `You are the ${subagent.name} subagent. ${subagent.description}`;
					// APPEND the subagent instructions to Pi's base coding prompt —
					// replacing it wholesale strips the tool-use scaffolding and the
					// sub-agent then produces nothing. Keep the sub-session bounded:
					// no nested skills/prompts/context-files/subagents.
					const subLoader = new DefaultResourceLoader({
						cwd: resolvedProjectPath,
						agentDir,
						appendSystemPromptOverride: (base) => [...base, `# Subagent: ${subagent.name}\n\n${instructions}`],
						agentsFilesOverride: () => ({ agentsFiles: [] }),
						skillsOverride: () => ({ skills: [], diagnostics: [] }),
						promptsOverride: () => ({ prompts: [], diagnostics: [] }),
					});
					await subLoader.reload();
					const { session: sub } = await createAgentSession({
						cwd: resolvedProjectPath,
						agentDir,
						model,
						modelRuntime: runtime,
						thinkingLevel: 'off',
						resourceLoader: subLoader,
						tools: allowedBuiltins,
						sessionManager: SessionManager.inMemory(resolvedProjectPath),
						settingsManager: SettingsManager.inMemory({ retry: PI_RETRY, compaction: { enabled: false } }),
					});
					// Convert the sub-agent's events and route its messages into the
					// parent Agent block as sub-activities (parent.toolUseId = the
					// Agent tool_use id). Drop transient events so the sub-agent's
					// live typing / result never leaks into the main turn.
					const subConverter = createPiMessageConverter({
						engine: { type: 'pi', provider, model: { id: modelId, name: model.name || modelId }, account: { id: account.id, name: account.name } },
						sessionId: sub.sessionId,
					});
					let text = '';
					const unsub = sub.subscribe((ev) => {
						for (const out of subConverter.convert(ev)) {
							if (out.type === 'stream_event' || out.type === 'result' || out.type === 'system_init' || out.type === 'notification') continue;
							if (out.type === 'assistant' || out.type === 'user' || out.type === 'reasoning') {
								out.parent = { messageId: null, sessionId: null, toolUseId: toolCallId };
							}
							if (out.type === 'assistant') {
								const t = out.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('');
								if (t.trim()) text = t;
							}
							queueHolder.queue?.push(out);
						}
					});
					const onSubAbort = () => { void sub.abort(); };
					signal?.addEventListener('abort', onSubAbort, { once: true });
					try {
						await sub.prompt(subPrompt);
					} finally {
						signal?.removeEventListener('abort', onSubAbort);
						unsub();
						try { sub.dispose(); } catch { /* already disposed */ }
					}
					return text;
				},
			});
			customTools.push(agentTool);
			toolAllowlist.push('Agent');
		}

		// ── Resource loader (discovers synced skills/prompts/AGENTS.md) ──
		const resourceLoader = new DefaultResourceLoader({
			cwd: resolvedProjectPath,
			agentDir,
			extensionFactories: [permissionBlocker],
		});
		await resourceLoader.reload();

		const sessionManager = await resolvePiSessionManager(resolvedProjectPath, resume);

		const { session } = await createAgentSession({
			cwd: resolvedProjectPath,
			agentDir,
			model,
			modelRuntime: runtime,
			thinkingLevel: reasoningEffort
				? clampThinkingLevel(model, reasoningEffort as ModelThinkingLevel)
				: (model.reasoning ? 'medium' : 'off'),
			resourceLoader,
			tools: toolAllowlist,
			customTools,
			excludeTools: ['ask_question'],
			sessionManager,
			settingsManager: SettingsManager.inMemory({ retry: PI_RETRY }),
		});
		run.session = session;

		const engineMeta: MessageEngine = {
			type: 'pi',
			provider,
			model: { id: modelId, name: model.name || modelId },
			account: { id: account.id, name: account.name },
		};
		const converter = createPiMessageConverter({ engine: engineMeta, sessionId: session.sessionId });
		const queue = new EventQueue<EngineOutput>();
		queueHolder.queue = queue;
		const unsubscribe = session.subscribe((event) => {
			try {
				for (const out of converter.convert(event)) queue.push(out);
			} catch (error) {
				queue.fail(error);
				return;
			}
			if (event.type === 'agent_end') queue.close();
		});

		// Abort wiring: cancelling the stream aborts the Pi session.
		const onAbort = () => { void session.abort(); };
		controller.signal.addEventListener('abort', onAbort, { once: true });

		// Prompt text + image attachments.
		const promptText = prompt.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
		const images: ImageContent[] = prompt.content
			.filter((b): b is Extract<typeof b, { type: 'image' }> => b.type === 'image')
			.map((b) => ({ type: 'image', data: b.data, mimeType: b.mediaType }));

		// system_init first — model + enabled tools (Pi bridges MCP as custom tools).
		yield {
			type: 'system_init',
			sessionId: session.sessionId,
			model: modelId,
			engine: 'pi',
			tools: toolAllowlist,
			mcpServers: [],
		};

		// Close the queue when prompt() settles even if no `agent_end` ever fires
		// (e.g. a slash command Pi rejects at preflight, or an empty expansion) —
		// otherwise the drain loop would block forever and the stream would hang.
		const promptOptions = {
			...(images.length ? { images } : {}),
			preflightResult: (success: boolean) => {
				if (!success) {
					queue.push({
						type: 'notification',
						sessionId: session.sessionId,
						level: 'warning',
						title: 'Prompt not accepted',
						message: 'Pi did not accept this input (unknown command or empty prompt).',
					});
				}
			},
		};
		const promptPromise = session.prompt(promptText, promptOptions)
			.then(() => queue.close())
			.catch((error) => queue.fail(error));

		try {
			for await (const out of queue.drain()) yield out;
			await promptPromise;
		} catch (error) {
			handleStreamError(error);
		} finally {
			controller.signal.removeEventListener('abort', onAbort);
			unsubscribe();
			try { session.dispose(); } catch { /* already disposed */ }
			// Retire THIS run only — another chat session of the same project may
			// still be streaming on this instance.
			this.forgetRun(run);
		}
	}

	/** Drop a finished run and the asks only it could answer. */
	private forgetRun(run: PiRun): void {
		this.runs.remove(run);
		for (const [id, pending] of this.pendingAsks) {
			if (pending.owner === run) this.pendingAsks.delete(id);
		}
		run.session = null;
	}

	/**
	 * Cancel the run whose AbortController is `owner`, and only that run.
	 */
	async cancel(owner: AbortController): Promise<void> {
		await this.stopRuns(this.runs.select(owner));
	}

	/**
	 * Tear down the given runs. `cancel` passes the one run it was asked to
	 * stop; `dispose` passes them all. Nothing else may reach this.
	 */
	private async stopRuns(targets: PiRun[]): Promise<void> {
		for (const run of targets) {
			if (!run.controller.signal.aborted) run.controller.abort();
			const session = run.session;
			// Drop only this run's parked asks; another run's are still live.
			this.forgetRun(run);
			if (session) {
				try { await session.abort(); } catch { /* may already be idle */ }
			}
		}
	}

	async interrupt(owner: AbortController): Promise<void> {
		const targets = this.runs.select(owner);
		for (const run of targets) {
			if (run.session) {
				try { await run.session.abort(); } catch { /* ignore */ }
			}
		}
	}

	resolveUserAnswer(toolUseId: string, answers: Record<string, string>): boolean {
		const pending = this.pendingAsks.get(toolUseId);
		if (!pending) {
			debug.warn('engine', `Pi resolveUserAnswer: no pending question for ${toolUseId}`);
			return false;
		}
		const result: AgentToolResult<unknown> = {
			content: [{ type: 'text', text: formatAnswers(pending.questions, answers) }],
			details: {},
		};
		pending.resolve(result);
		this.pendingAsks.delete(toolUseId);
		return true;
	}

	/**
	 * One-shot structured JSON generation via prompt engineering (Pi has no native
	 * JSON-schema output mode). Runs a tool-less in-memory session and parses the
	 * final assistant text.
	 */
	async generateStructured<T = unknown>(options: StructuredGenerationOptions): Promise<T> {
		const { prompt, providerSlug, modelId, schema, projectPath, accountId } = options;

		const { createAgentSession, SessionManager, SettingsManager } =
			await loadEngineSdk<typeof import('@earendil-works/pi-coding-agent')>('pi', '@earendil-works/pi-coding-agent');

		const account = getPiAccountForProvider(providerSlug)
			?? (accountId != null ? engineQueries.getAccount(accountId) : null);
		if (!account) throw new Error(`Pi has no account for provider "${providerSlug}".`);
		const provider = parsePiCredential(account.credential)?.provider ?? providerSlug;
		const runtime = await createPiRuntime(new DbCredentialStore([account]));
		const model = runtime.getModel(provider, modelId);
		if (!model) throw new Error(`Pi could not resolve model "${modelId}" for provider "${provider}".`);

		const resolvedProjectPath = resolveOsPath(projectPath);
		const { session } = await createAgentSession({
			cwd: resolvedProjectPath,
			agentDir: getPiAgentDir(),
			model,
			modelRuntime: runtime,
			thinkingLevel: 'off',
			noTools: 'all',
			sessionManager: SessionManager.inMemory(resolvedProjectPath),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		});

		let resultText = '';
		const unsubscribe = session.subscribe((event) => {
			if (event.type === 'message_end' && (event.message as { role?: string })?.role === 'assistant') {
				const content = (event.message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
				resultText = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
			}
		});

		try {
			await session.prompt(buildJsonPrompt(prompt, schema));
		} finally {
			unsubscribe();
			try { session.dispose(); } catch { /* ignore */ }
		}

		if (!resultText.trim()) throw new Error('Pi returned no structured output');
		return extractJson<T>(resultText);
	}
}

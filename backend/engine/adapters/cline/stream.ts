/**
 * Cline Engine Adapter
 *
 * Wraps `@cline/sdk` into the AIEngine interface. Structurally close to the Pi
 * adapter, with three deliberate choices:
 *
 *   1. **Stateless `Agent`, not `ClineCore`.** Clopen already owns session
 *      persistence (stream-manager + DB), and `ClineCore` derives its storage
 *      root from `$HOME/.cline` with no redirect env var — which would collide
 *      with the user's real Cline data. The stateless `Agent` writes nothing to
 *      disk; we bring the built-in coding tools in via `createBuiltinTools`.
 *   2. **Subscribe, not async-generator.** `Agent.subscribe(listener)` +
 *      `agent.run()` drive output. `streamQuery` bridges that push stream into
 *      the required `AsyncGenerator<EngineOutput>` via a small pushable queue.
 *   3. **Multi-provider, DB-backed credentials.** Each stream resolves the
 *      account matching the model's provider from `engine_accounts` and feeds its
 *      api-key (or refreshed OAuth token) into the provider-form `Agent` config.
 *
 * MCP tools + AskUserQuestion are bridged as in-process custom tools (Cline has
 * no headless MCP/ask path for the stateless loop). Resume keeps context within
 * the running server via `restore()` of the prior transcript.
 */

import type { Agent, AgentTool, ToolPolicy } from '@cline/sdk';
import type { AgentMessage, AgentMessagePart, AgentRunResult } from '@cline/agents';
import type { EngineOutput, EngineModel, MessageEngine } from '$shared/types/unified';
import type { AIEngine, EngineQueryOptions, StructuredGenerationOptions } from '../../types';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import { resolveOsPath } from '$backend/utils/paths';
import { debug } from '$shared/utils/logger';
import { engineQueries } from '$backend/database/queries/engine-queries';
import { syncSkills } from '$backend/skills';
import { syncEngineArtifacts, buildArtifactsPromptContext } from '$backend/engine/artifact-sync';
import { artifactFilter } from '$backend/profiles';
import { resolvePermissionsFromDb, isToolAllowed } from '$backend/permissions';
import { buildJsonPrompt, extractJson } from '../../structured-helpers';
import { EngineRuns } from '../run-registry';
import { subagentQueries } from '$backend/database/queries';
import { readSubagentMd } from '$backend/subagents/store';
import { getClineAccountForProvider, parseClineCredential, resolveClineAuth } from './credential';
import { fetchClineModels } from './models';
import { buildClineMcpTools } from './mcp-tools';
import { createAskUserQuestionTool, formatAnswers, type PendingAsk } from './ask-question-tool';
import { createAgentDispatchTool, type SubagentInfo } from './agent-tool';
import { createClineMessageConverter } from './message-converter';
import { handleStreamError } from './error-handler';

/** Cline built-in coding tools (createBuiltinTools defaults; ask/submit are off). */
const CLINE_BUILTIN_TOOLS = ['read_files', 'search_codebase', 'run_commands', 'fetch_web_content', 'apply_patch', 'editor', 'skills'];

/** Max per-turn transcripts kept in memory before FIFO eviction (branch history). */
const MAX_TRACKED_SESSIONS = 500;

type ClineAgent = Agent;

/** Strip YAML frontmatter from a subagent markdown doc, leaving the instructions. */
function stripFrontmatter(md: string): string {
	const match = md.match(/^---\n[\s\S]*?\n---\n?/);
	return (match ? md.slice(match[0].length) : md).trim();
}

/** Minimal pushable queue bridging Cline's subscribe stream → an async generator. */
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
 * chat session of a project, so the agent belongs here, not in an instance field
 * — a field would hold only the most recently started stream, and cancelling any
 * chat would then abort another chat's agent.
 */
interface ClineRun {
	/** Identity of the run — the controller the caller passed to streamQuery. */
	controller: AbortController;
	agent: ClineAgent | null;
}

export class ClineEngine implements AIEngine {
	readonly name = 'cline' as const;
	private _isInitialized = false;
	private runs = new EngineRuns<ClineRun>();
	/** Parked AskUserQuestion callbacks → the run that asked. */
	private pendingAsks = new Map<string, PendingAsk & { owner: ClineRun }>();
	/**
	 * In-memory transcript keyed by the SDK session id EMITTED for each turn.
	 * Every turn stores its resulting transcript under a fresh id and never
	 * mutates an existing entry — so a checkpoint fork (undo + continue) resumes
	 * from the exact ancestor branch instead of whatever was written last. See
	 * the branch-awareness note in `streamQuery`.
	 */
	private sessions = new Map<string, AgentMessage[]>();

	get isInitialized(): boolean { return this._isInitialized; }
	get isActive(): boolean { return this.runs.isActive; }

	async initialize(): Promise<void> {
		if (this._isInitialized) return;
		this._isInitialized = true;
		debug.log('engine', '✅ Cline engine initialized');
	}

	async dispose(): Promise<void> {
		await this.stopRuns(this.runs.all());
		this.pendingAsks.clear();
		this.sessions.clear();
		this._isInitialized = false;
	}

	async getAvailableModels(): Promise<EngineModel[]> {
		return fetchClineModels();
	}

	private async buildSystemPrompt(cwd: string, providerId: string, profileId?: number): Promise<string> {
		const { getClineDefaultSystemPrompt } = await loadEngineSdk<typeof import('@cline/sdk')>('cline', '@cline/sdk');
		let base: string;
		try {
			base = getClineDefaultSystemPrompt({ cwd, workspaceRoot: cwd, providerId, platform: process.platform });
		} catch {
			base = 'You are Cline, a highly skilled software engineer. Use the available tools to complete the user\'s coding task.';
		}
		const artifacts = buildArtifactsPromptContext(profileId);
		return artifacts ? `${base}\n\n${artifacts}` : base;
	}

	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
		const { projectPath, prompt, resume, providerSlug, modelId, abortController, accountId } = options;
		debug.log('chat', 'Cline - Stream Query', { providerSlug, modelId, resume });

		// ── Resolve account + credential for the model's provider ──
		const account = getClineAccountForProvider(providerSlug)
			?? (accountId != null ? engineQueries.getAccount(accountId) : null);
		if (!account) {
			throw new Error(`Cline has no account for provider "${providerSlug}". Add one in Settings → Engines → Cline.`);
		}
		const provider = parseClineCredential(account.credential)?.provider ?? providerSlug;
		const auth = await resolveClineAuth(account);

		const controller = abortController || new AbortController();
		const run: ClineRun = { controller, agent: null };
		this.runs.add(run);
		const resolvedProjectPath = resolveOsPath(projectPath);

		// ── Active Profile scoping + artifact materialization ──
		const profileId = options.mcpContext?.profileId;
		const mcpProfileFilter = artifactFilter(profileId, 'mcp') ?? undefined;
		await syncSkills('cline', profileId);
		await syncEngineArtifacts('cline', profileId);

		// ── Permissions → toolPolicies (denied builtins are hidden from the model) ──
		const permissions = resolvePermissionsFromDb('cline', options.mcpContext?.projectId, profileId);

		// Late-bound handle to the stream's event queue so the subagent runner
		// (built before the queue exists) can push its sub-activity messages into it.
		const queueHolder: { queue: EventQueue<EngineOutput> | null } = { queue: null };

		// ── Tools: builtins + AskUserQuestion + MCP bridge ──
		const { Agent, createBuiltinTools, getClineDefaultSystemPrompt } = await loadEngineSdk<typeof import('@cline/sdk')>('cline', '@cline/sdk');
		const builtinTools = createBuiltinTools({
			cwd: resolvedProjectPath,
			enableAskQuestion: false,
			enableSubmitAndExit: false,
		});
		const askTool = await createAskUserQuestionTool({
			register: (id, entry) => this.pendingAsks.set(id, { ...entry, owner: run }),
			unregister: (id) => this.pendingAsks.delete(id),
		});
		const mcpTools = await buildClineMcpTools(options.mcpContext, mcpProfileFilter);
		const tools: AgentTool[] = [...builtinTools, askTool, ...mcpTools];

		const toolPolicies: Record<string, ToolPolicy> = {};
		for (const name of CLINE_BUILTIN_TOOLS) {
			toolPolicies[name] = isToolAllowed(permissions, name) ? { autoApprove: true } : { enabled: false };
		}
		toolPolicies.AskUserQuestion = { autoApprove: true };
		for (const t of mcpTools) toolPolicies[t.name] = { autoApprove: true };

		// ── Subagents: Cline's stateless Agent has no native Agent/Task tool, so the
		// "Available Subagents" preamble alone can't be invoked. Expose an `Agent`
		// tool that actually spawns a bounded sub-`Agent` with the chosen subagent's
		// system prompt and returns its final text. ──
		const subagents: SubagentInfo[] = subagentQueries.getEnabled().map(s => ({ slug: s.slug, name: s.name, description: s.description }));
		if (subagents.length > 0) {
			const agentTool = await createAgentDispatchTool({
				subagents,
				run: async (subagent, subPrompt, toolCallId, signal) => {
					const md = (await readSubagentMd(subagent.slug)) ?? '';
					const instructions = stripFrontmatter(md) || `You are the ${subagent.name} subagent. ${subagent.description}`;
					// APPEND the subagent instructions to Cline's base coding prompt (a
					// bare instruction strips the tool-use scaffolding). The sub-Agent gets
					// the permission-filtered builtins ONLY — no AskUserQuestion, no MCP,
					// and no nested Agent tool — so delegation stays bounded.
					let base: string;
					try {
						base = getClineDefaultSystemPrompt({ cwd: resolvedProjectPath, workspaceRoot: resolvedProjectPath, providerId: provider, platform: process.platform });
					} catch {
						base = 'You are Cline, a highly skilled software engineer.';
					}
					const subAgent = new Agent({
						providerId: provider,
						modelId,
						...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
						...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
						...(auth.options ? { options: auth.options } : {}),
						systemPrompt: `${base}\n\n# Subagent: ${subagent.name}\n\n${instructions}`,
						tools: builtinTools,
						toolPolicies,
						maxIterations: 30,
					});

					// Route the sub-agent's persisted messages into the PARENT stream as
					// sub-activities: tag each with `parent.toolUseId = <Agent block id>`
					// so the frontend folds them under the Agent tool. Only tool_use
					// steps (+ their tool_result) are surfaced — the collapsed sub-agent
					// view is a tool trail; the sub-agent's prose is already returned as
					// the Agent tool's result (its `outputText`). So we drop transient
					// events, reasoning, and text-only assistant messages.
					const subConverter = createClineMessageConverter({
						engine: { type: 'cline', provider, model: { id: modelId, name: modelId }, account: { id: account.id, name: account.name } },
						sessionId: crypto.randomUUID(),
					});
					const unsub = subAgent.subscribe((ev) => {
						for (const out of subConverter.convert(ev)) {
							if (out.type === 'user') {
								// tool_result messages — carry the sub-agent's tool outputs.
							} else if (out.type === 'assistant' && out.content.some(b => b.type === 'tool_use')) {
								// tool_use step — keep.
							} else {
								continue; // drop stream/result/init/notification/reasoning/text-only
							}
							out.parent = { messageId: null, sessionId: null, toolUseId: toolCallId };
							queueHolder.queue?.push(out);
						}
					});

					const onSubAbort = () => { try { subAgent.abort('Parent cancelled'); } catch { /* ignore */ } };
					signal?.addEventListener('abort', onSubAbort, { once: true });
					try {
						const result = await subAgent.run(subPrompt);
						return result.outputText ?? '';
					} finally {
						signal?.removeEventListener('abort', onSubAbort);
						unsub();
					}
				},
			});
			tools.push(agentTool);
			toolPolicies.Agent = { autoApprove: true };
		}

		const toolNames = tools.filter(t => toolPolicies[t.name]?.enabled !== false).map(t => t.name);

		// ── Resume / fork (branch-aware) ──
		// `resume` is the parent branch's per-turn session id (stream-manager
		// derives it from the prompt's `parent.sessionId`). We ALWAYS mint a fresh
		// id for this turn and copy the parent's transcript forward — so two turns
		// that share the same parent (a checkpoint fork: A→B→C vs A→B1→C1) each get
		// an independent history and never leak the sibling branch's messages.
		const priorMessages = resume ? this.sessions.get(resume) : undefined;
		const sessionId = crypto.randomUUID();

		const systemPrompt = await this.buildSystemPrompt(resolvedProjectPath, provider, profileId);
		const agent = new Agent({
			providerId: provider,
			modelId,
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
			...(auth.options ? { options: auth.options } : {}),
			systemPrompt,
			tools,
			toolPolicies,
			maxIterations: options.maxTurns ?? 100,
		});
		run.agent = agent;
		if (priorMessages?.length) agent.restore(priorMessages);

		const engineMeta: MessageEngine = {
			type: 'cline',
			provider,
			model: { id: modelId, name: modelId },
			account: { id: account.id, name: account.name },
		};
		const converter = createClineMessageConverter({ engine: engineMeta, sessionId });
		const queue = new EventQueue<EngineOutput>();
		queueHolder.queue = queue;
		const unsubscribe = agent.subscribe((event) => {
			try {
				for (const out of converter.convert(event)) queue.push(out);
			} catch (error) {
				queue.fail(error);
			}
		});

		// Abort wiring: cancelling the stream aborts the Cline run.
		const onAbort = () => { agent.abort('Cancelled'); };
		controller.signal.addEventListener('abort', onAbort, { once: true });

		// Build the user turn (text + image attachments).
		const promptText = prompt.content.filter(b => b.type === 'text').map(b => (b.type === 'text' ? b.text : '')).join('\n');
		const content: AgentMessagePart[] = [{ type: 'text', text: promptText }];
		for (const b of prompt.content) {
			if (b.type === 'image') content.push({ type: 'image', image: `data:${b.mediaType};base64,${b.data}`, mediaType: b.mediaType });
		}
		const userMessage: AgentMessage = { id: crypto.randomUUID(), role: 'user', content, createdAt: Date.now() };

		// system_init first — model + enabled tools (Cline bridges MCP as custom tools).
		yield {
			type: 'system_init',
			sessionId,
			model: modelId,
			engine: 'cline',
			tools: toolNames,
			mcpServers: [],
		};

		const runPromise: Promise<AgentRunResult> = priorMessages?.length ? agent.continue(userMessage) : agent.run(userMessage);
		const settle = runPromise
			.then((result) => {
				// Store this turn's full transcript under its OWN new id — never
				// overwrite the parent (`resume`) entry, so sibling forks stay isolated.
				this.sessions.set(sessionId, [...result.messages]);
				// Bound the map so a long-lived project engine can't grow unbounded.
				// FIFO eviction: forking from a very old (evicted) checkpoint simply
				// starts fresh, same graceful degradation as a cross-restart resume.
				while (this.sessions.size > MAX_TRACKED_SESSIONS) {
					const oldest = this.sessions.keys().next().value;
					if (oldest === undefined) break;
					this.sessions.delete(oldest);
				}
				if (result.status === 'failed') {
					queue.fail(result.error ?? new Error('Cline run failed'));
					return;
				}
				queue.close();
			})
			.catch((error) => queue.fail(error));

		try {
			for await (const out of queue.drain()) yield out;
			await settle;
		} catch (error) {
			handleStreamError(error);
		} finally {
			controller.signal.removeEventListener('abort', onAbort);
			unsubscribe();
			// Retire THIS run only — another chat session of the same project may
			// still be streaming on this instance.
			this.forgetRun(run);
		}
	}

	/** Drop a finished run and the asks only it could answer. */
	private forgetRun(run: ClineRun): void {
		this.runs.remove(run);
		for (const [id, pending] of this.pendingAsks) {
			if (pending.owner === run) this.pendingAsks.delete(id);
		}
		run.agent = null;
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
	private async stopRuns(targets: ClineRun[]): Promise<void> {
		for (const run of targets) {
			if (!run.controller.signal.aborted) run.controller.abort();
			const agent = run.agent;
			// Drop only this run's parked asks; another run's are still live.
			this.forgetRun(run);
			if (agent) {
				try { agent.abort('Cancelled'); } catch { /* may already be idle */ }
			}
		}
	}

	async interrupt(owner: AbortController): Promise<void> {
		const targets = this.runs.select(owner);
		for (const run of targets) {
			if (run.agent) {
				try { run.agent.abort('Interrupted'); } catch { /* ignore */ }
			}
		}
	}

	resolveUserAnswer(toolUseId: string, answers: Record<string, string>): boolean {
		const pending = this.pendingAsks.get(toolUseId);
		if (!pending) {
			debug.warn('engine', `Cline resolveUserAnswer: no pending question for ${toolUseId}`);
			return false;
		}
		pending.resolve(formatAnswers(pending.questions, answers));
		this.pendingAsks.delete(toolUseId);
		return true;
	}

	/**
	 * One-shot structured JSON generation via prompt engineering (no tools). Runs
	 * a tool-less `Agent` and parses the final assistant text.
	 */
	async generateStructured<T = unknown>(options: StructuredGenerationOptions): Promise<T> {
		const { prompt, providerSlug, modelId, schema, accountId } = options;

		const account = getClineAccountForProvider(providerSlug)
			?? (accountId != null ? engineQueries.getAccount(accountId) : null);
		if (!account) throw new Error(`Cline has no account for provider "${providerSlug}".`);
		const provider = parseClineCredential(account.credential)?.provider ?? providerSlug;
		const auth = await resolveClineAuth(account);

		const { Agent } = await loadEngineSdk<typeof import('@cline/sdk')>('cline', '@cline/sdk');
		const agent = new Agent({
			providerId: provider,
			modelId,
			...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
			...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
			...(auth.options ? { options: auth.options } : {}),
			systemPrompt: 'You output only valid JSON. No prose, no markdown fences.',
			maxIterations: 1,
		});

		const result = await agent.run(buildJsonPrompt(prompt, schema));
		if (!result.outputText?.trim()) throw new Error('Cline returned no structured output');
		return extractJson<T>(result.outputText);
	}
}

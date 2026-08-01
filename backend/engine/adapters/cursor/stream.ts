/**
 * Cursor Engine Adapter
 *
 * Wraps `@cursor/sdk` into the AIEngine interface. Key choices:
 *
 *   1. **Local agents.** `Agent.create({ local: { cwd, store } })` runs the coding
 *      agent in-process against the project workspace. Cloud agents (Cursor VMs +
 *      GitHub repos) don't fit Clopen's local-project workflow and can't take the
 *      in-process custom tools we need, so they're not used.
 *   2. **Native async-generator stream.** `agent.send()` returns a `Run` whose
 *      `run.stream()` is already an `AsyncGenerator<SDKMessage>` — no subscribe
 *      bridge (unlike Cline/Pi). The message-converter maps each event.
 *   3. **Single-account, API-key auth.** One `CURSOR_API_KEY` per account, passed
 *      to `Agent.create({ apiKey })`; multi-account is a pure DB `is_active` swap.
 *   4. **Isolated JSONL store + fork-on-resume.** State lives in Clopen's isolated
 *      engine dir via a `JsonlLocalAgentStore` (never `~/.cursor`); every resume
 *      forks by copying the parent agent's checkpoints (README §10.10 / §10.19).
 *
 * MCP servers ride Cursor's native `mcpServers` config (the shared `clopen-mcp`
 * bridge). AskUserQuestion is bridged as an in-process custom tool. Subagents map
 * to Cursor's native `agents` config.
 */

import type { SDKAgent, Run, SDKUserMessage, SDKImage, AgentDefinition, SDKCustomTool, ModelSelection } from '@cursor/sdk';
import type { EngineOutput, EngineModel, MessageEngine } from '$shared/types/unified';
import type { AIEngine, EngineQueryOptions, StructuredGenerationOptions } from '../../types';
import { resolveOsPath } from '$backend/utils/paths';
import { loadEngineSdk } from '$backend/engine/sdk-loader';
import { debug } from '$shared/utils/logger';
import { engineQueries } from '$backend/database/queries/engine-queries';
import { syncSkills } from '$backend/skills';
import { syncEngineArtifacts, buildArtifactsPromptContext } from '$backend/engine/artifact-sync';
import { artifactFilter } from '$backend/profiles';
import { getCursorMcpConfig } from '../../../mcp';
import { subagentQueries } from '$backend/database/queries';
import { readSubagentMd } from '$backend/subagents/store';
import { buildJsonPrompt, extractJson } from '../../structured-helpers';
import { getActiveCursorAccount, resolveCursorApiKey } from './credential';
import { getCursorStore } from './environment';
import { forkCursorAgent } from './session-fork';
import { fetchCursorModels } from './models';
import { createAskUserQuestionTool, formatAnswers, type PendingAsk } from './ask-question-tool';
import { createCursorMessageConverter } from './message-converter';
import { handleStreamError } from './error-handler';

/** Strip YAML frontmatter from a subagent markdown doc, leaving the instructions. */
function stripFrontmatter(md: string): string {
	const match = md.match(/^---\n[\s\S]*?\n---\n?/);
	return (match ? md.slice(match[0].length) : md).trim();
}

/**
 * Minimal pushable queue merging Cursor's pull stream (`run.stream()`) with the
 * push emissions of the in-process AskUserQuestion custom tool into one ordered
 * async generator. The ask tool fires from inside the SDK's tool executor (a
 * separate async flow from the stream loop), so a plain `for await` can't carry
 * its emission — the queue is the merge point.
 */
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
 * Build a Cursor `ModelSelection` from the base model id and the chosen
 * reasoning token. The token encodes the model-parameter id as
 * `"<paramId>::<value>"` (see cursor/models.ts). A plain id (no `::`) or an
 * empty token yields the bare model with no params.
 */
function buildCursorModelSelection(modelId: string, reasoningEffort?: string): ModelSelection {
	if (!reasoningEffort || !reasoningEffort.includes('::')) return { id: modelId };
	const sep = reasoningEffort.indexOf('::');
	const paramId = reasoningEffort.slice(0, sep);
	const value = reasoningEffort.slice(sep + 2);
	if (!paramId || !value) return { id: modelId };
	return { id: modelId, params: [{ id: paramId, value }] };
}

export class CursorEngine implements AIEngine {
	readonly name = 'cursor' as const;
	private _isInitialized = false;
	private activeController: AbortController | null = null;
	private activeRun: Run | null = null;
	private activeAgent: SDKAgent | null = null;
	private pendingAsks = new Map<string, PendingAsk>();

	get isInitialized(): boolean { return this._isInitialized; }
	get isActive(): boolean { return this.activeController !== null; }

	async initialize(): Promise<void> {
		if (this._isInitialized) return;
		this._isInitialized = true;
		debug.log('engine', '✅ Cursor engine initialized');
	}

	async dispose(): Promise<void> {
		await this.cancel();
		this.pendingAsks.clear();
		this._isInitialized = false;
	}

	async getAvailableModels(): Promise<EngineModel[]> {
		return fetchCursorModels();
	}

	/** Build the `agents` config from Clopen's enabled subagents (Cursor-native). */
	private async buildAgents(): Promise<Record<string, AgentDefinition> | undefined> {
		const subagents = subagentQueries.getEnabled();
		if (subagents.length === 0) return undefined;
		const agents: Record<string, AgentDefinition> = {};
		for (const s of subagents) {
			const md = (await readSubagentMd(s.slug)) ?? '';
			const prompt = stripFrontmatter(md) || `You are the ${s.name} subagent. ${s.description}`;
			agents[s.slug] = { description: s.description || s.name, prompt, model: 'inherit' };
		}
		return agents;
	}

	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
		const { projectPath, prompt, resume, modelId, reasoningEffort, abortController, accountId } = options;
		debug.log('chat', 'Cursor - Stream Query', { modelId, resume });

		// Cursor selects reasoning via a per-model parameter. The catalog encodes
		// the chosen level as `"<paramId>::<value>"` (see cursor/models.ts); rebuild
		// the `ModelSelection.params` entry here. Absent/malformed → base model.
		const modelSelection = buildCursorModelSelection(modelId, reasoningEffort);

		// ── Resolve account + API key ──
		const account = (accountId != null ? engineQueries.getAccount(accountId) : null) ?? getActiveCursorAccount();
		if (!account) {
			throw new Error('Cursor is not configured. Add an API key in Settings → Engines → Cursor.');
		}
		const apiKey = resolveCursorApiKey(account);

		this.activeController = abortController || new AbortController();
		const resolvedProjectPath = resolveOsPath(projectPath);

		// ── Active Profile scoping + artifact materialization ──
		const profileId = options.mcpContext?.profileId;
		const mcpProfileFilter = artifactFilter(profileId, 'mcp') ?? undefined;
		await syncSkills('cursor', profileId);
		await syncEngineArtifacts('cursor', profileId);

		// ── Output queue merging the pull stream with the ask tool's push emissions ──
		const queue = new EventQueue<EngineOutput>();
		const converterHolder: { current: ReturnType<typeof createCursorMessageConverter> | null } = { current: null };

		// ── Tools: AskUserQuestion (in-process custom tool) + MCP (native config) ──
		const askTool: SDKCustomTool = createAskUserQuestionTool({
			register: (id, entry) => this.pendingAsks.set(id, entry),
			unregister: (id) => this.pendingAsks.delete(id),
			// Emit the tool_use with the COMPLETE questions from execute's args.
			emit: (id, questions) => {
				const c = converterHolder.current;
				if (c) for (const out of c.emitAskUserQuestion(id, questions)) queue.push(out);
			},
		});
		const customTools: Record<string, SDKCustomTool> = { AskUserQuestion: askTool };
		const mcpServers = getCursorMcpConfig(mcpProfileFilter);
		const agents = await this.buildAgents();

		const { Agent } = await loadEngineSdk<typeof import('@cursor/sdk')>('cursor', '@cursor/sdk');
		const store = await getCursorStore(projectPath);
		const engineMeta: MessageEngine = {
			type: 'cursor',
			provider: 'cursor',
			model: { id: modelId, name: modelId },
			account: { id: account.id, name: account.name },
		};

		// ── Resume / fork (branch-aware) ──
		// `resume` is the parent agent id. We ALWAYS fork (copy the parent's
		// checkpoints under a fresh agent id) so sibling branches stay isolated.
		let forkedAgentId: string | undefined;
		if (resume) {
			try {
				forkedAgentId = await forkCursorAgent(store, resume);
			} catch (error) {
				debug.warn('engine', `Cursor fork failed (${error instanceof Error ? error.message : String(error)}), starting fresh`);
			}
		}

		const localOptions = { cwd: resolvedProjectPath, store, customTools };
		let agent: SDKAgent;
		try {
			agent = forkedAgentId
				? await Agent.resume(forkedAgentId, {
					apiKey,
					model: { id: modelId },
					local: localOptions,
					...(Object.keys(mcpServers).length ? { mcpServers } : {}),
					...(agents ? { agents } : {}),
				})
				: await Agent.create({
					apiKey,
					model: { id: modelId },
					local: localOptions,
					...(Object.keys(mcpServers).length ? { mcpServers } : {}),
					...(agents ? { agents } : {}),
				});
		} catch (error) {
			this.activeController = null;
			handleStreamError(error);
			return;
		}
		this.activeAgent = agent;
		const sessionId = agent.agentId;

		const converter = createCursorMessageConverter({ engine: engineMeta, sessionId });
		converterHolder.current = converter;

		// Build the user turn (text + image attachments).
		const promptText = prompt.content.filter(b => b.type === 'text').map(b => (b.type === 'text' ? b.text : '')).join('\n');
		const artifacts = buildArtifactsPromptContext(profileId);
		const text = artifacts ? `${artifacts}\n\n${promptText}` : promptText;
		const images: SDKImage[] = [];
		for (const b of prompt.content) {
			if (b.type === 'image') images.push({ data: b.data, mimeType: b.mediaType });
		}
		const userMessage: SDKUserMessage = { text, ...(images.length ? { images } : {}) };

		// Cursor's `run.stream()` yields each text/thinking chunk as its own
		// SDKMessage; the converter streams every chunk live as a transient
		// stream_event AND accumulates it, flushing ONE consolidated reasoning /
		// assistant message per block. The pull stream + the ask tool's push
		// emissions are merged through the queue.
		let onAbort: (() => void) | null = null;
		try {
			const run = await agent.send(userMessage, {
				model: modelSelection,
				// Sub-agent (Task) steps aren't in `run.stream()` — they ride
				// `tool-call-delta.taskUpdate` here. Stream each completed sub-agent
				// tool call live as a child of the Agent block (parent.toolUseId).
				onDelta: ({ update }) => {
					const u = update as { type?: string; callId?: string; taskUpdate?: unknown };
					if (u.type === 'tool-call-delta' && u.taskUpdate && u.callId) {
						const c = converterHolder.current;
						if (c) for (const out of c.emitSubagentActivity(u.callId, u.taskUpdate)) queue.push(out);
					}
				},
			});
			this.activeRun = run;

			// Abort wiring: cancelling the stream cancels the Cursor run.
			onAbort = () => { run.cancel().catch(() => { /* already terminal */ }); };
			this.activeController.signal.addEventListener('abort', onAbort, { once: true });

			// Drive the pull stream + result in the background, funnelling into the queue.
			const settle = (async () => {
				try {
					if (run.supports('stream')) {
						for await (const message of run.stream()) {
							for (const out of converter.convert(message)) queue.push(out);
						}
					}
					const result = await run.wait();
					for (const out of converter.finalize(result)) queue.push(out);
					queue.close();
				} catch (error) {
					queue.fail(error);
				}
			})();

			for await (const out of queue.drain()) yield out;
			await settle;
		} catch (error) {
			handleStreamError(error);
		} finally {
			if (onAbort) this.activeController?.signal.removeEventListener('abort', onAbort);
			try { agent.close(); } catch { /* fire-and-forget */ }
			this.activeRun = null;
			this.activeAgent = null;
			this.activeController = null;
			this.pendingAsks.clear();
		}
	}

	async cancel(): Promise<void> {
		// Release any parked AskUserQuestion callbacks so a blocked run can settle.
		for (const [, pending] of this.pendingAsks) {
			pending.resolve('User did not answer the question.');
		}
		this.pendingAsks.clear();

		// Abort the local controller first (cuts the for-await loop), then RPC.
		if (this.activeController && !this.activeController.signal.aborted) {
			this.activeController.abort();
		}
		this.activeController = null;

		if (this.activeRun) {
			try { await this.activeRun.cancel(); } catch { /* may already be terminal */ }
		}
		this.activeRun = null;
		this.activeAgent = null;
	}

	async interrupt(): Promise<void> {
		if (this.activeRun) {
			try { await this.activeRun.cancel(); } catch { /* ignore */ }
		}
	}

	resolveUserAnswer(toolUseId: string, answers: Record<string, string>): boolean {
		const pending = this.pendingAsks.get(toolUseId);
		if (!pending) {
			debug.warn('engine', `Cursor resolveUserAnswer: no pending question for ${toolUseId}`);
			return false;
		}
		pending.resolve(formatAnswers(pending.questions, answers));
		this.pendingAsks.delete(toolUseId);
		return true;
	}

	/**
	 * One-shot structured JSON generation. Cursor local agents always expose the
	 * built-in coding tools, so we instruct the model to answer with JSON only and
	 * parse the final result text.
	 */
	async generateStructured<T = unknown>(options: StructuredGenerationOptions): Promise<T> {
		const { prompt, modelId, schema, projectPath, accountId } = options;

		const account = (accountId != null ? engineQueries.getAccount(accountId) : null) ?? getActiveCursorAccount();
		if (!account) throw new Error('Cursor is not configured.');
		const apiKey = resolveCursorApiKey(account);

		const { Agent } = await loadEngineSdk<typeof import('@cursor/sdk')>('cursor', '@cursor/sdk');
		const agent = await Agent.create({
			apiKey,
			model: { id: modelId },
			local: { cwd: resolveOsPath(projectPath), store: await getCursorStore(projectPath) },
		});
		try {
			const run = await agent.send(buildJsonPrompt(prompt, schema));
			const result = await run.wait();
			if (!result.result?.trim()) throw new Error('Cursor returned no structured output');
			return extractJson<T>(result.result);
		} finally {
			try { agent.close(); } catch { /* ignore */ }
		}
	}
}

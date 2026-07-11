/**
 * Codex Engine Adapter
 *
 * Wraps `@openai/codex-sdk` into the AIEngine interface. The SDK manages a
 * subprocess (`codex exec`) per turn — we only own the per-project `Codex`
 * instance, the `Thread` lifecycle, and an `AbortController` for cancellation.
 *
 * Auth: dual mode (API key + ChatGPT browser OAuth). See ./auth.ts and
 * backend/engine/README.md §9.13 for the auth-blob swap pattern.
 *
 * MCP: reuses the existing remote MCP HTTP server at /mcp via
 * getCodexMcpConfig() in backend/mcp/config.ts. No new MCP infrastructure.
 *
 * TODO(codex-sdk): AskUserQuestion is currently UNSUPPORTED for Codex. The
 * upstream `@openai/codex-sdk` exposes no callback hook (no `canUseTool`
 * equivalent, no permission/elicitation events on the stream). Once the SDK
 * surfaces a native interactive-question primitive, implement
 * `resolveUserAnswer` on this adapter and route `chat:ask-user-answer` from
 * `backend/ws/chat/stream.ts` to it — same pattern as Claude/OpenCode.
 */

import { Codex, type Thread, type ThreadOptions, type Input as CodexInput } from '@openai/codex-sdk';
import type { EngineOutput, EngineModel } from '$shared/types/unified';
import type { AIEngine, EngineQueryOptions, StructuredGenerationOptions } from '../../types';
import { extractJson } from '../../structured-helpers';
import { engineQueries } from '$backend/database/queries/engine-queries';
import { resolveOsPath } from '$backend/utils/paths';
import { resolveBinary } from '$backend/utils/cli';
import { getCleanSpawnEnv } from '$backend/utils/index.js';
import { getCodexMcpConfig } from '../../../mcp';
import { artifactFilter } from '$backend/profiles';
import { syncSkills } from '$backend/skills';
import { syncEngineArtifacts, buildArtifactsPromptContext } from '$backend/engine/artifact-sync';
import { CODEX_MODELS } from './models';
import { debug } from '$shared/utils/logger';
import { handleStreamError, buildTurnError } from './error-handler';
import {
	createCodexState,
	convertThreadStarted,
	convertTurnStarted,
	convertItemStarted,
	convertItemUpdated,
	convertItemCompleted,
	convertTurnCompleted,
	buildResultEvent,
} from './message-converter';
import {
	parseCodexCredential,
	applyAccountAuth,
	snapshotAuthJsonToActiveAccount,
	getCodexHomeDir,
} from './credential';
import { forkCodexSessionState, sessionStateExists } from './session-fork';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export class CodexEngine implements AIEngine {
	readonly name = 'codex' as const;

	private _isInitialized = false;
	private codex: Codex | null = null;
	private activeThread: Thread | null = null;
	private activeController: AbortController | null = null;
	/** Account ID currently baked into `this.codex`. Same trade-off as Copilot. */
	private currentAccountId: number | null = null;
	/**
	 * Profile connector-filter signature baked into `this.codex`. Codex takes its
	 * MCP set at construction, so scoping connectors to a Profile means rebuilding
	 * the client when the filter changes (same trade-off as an account switch).
	 * `'*'` = unfiltered (no profile constraint). `null` = not initialized.
	 */
	private currentMcpFilterKey: string | null = null;

	get isInitialized(): boolean {
		return this._isInitialized;
	}

	get isActive(): boolean {
		return this.activeController !== null;
	}

	async initialize(accountId?: number, mcpProfileFilter?: Set<string>): Promise<void> {
		const mcpKey = mcpProfileFilter ? [...mcpProfileFilter].sort().join(',') : '*';
		if (this._isInitialized && (accountId == null || accountId === this.currentAccountId) && mcpKey === this.currentMcpFilterKey) {
			return;
		}

		const account = accountId != null
			? engineQueries.getAccount(accountId)
			: engineQueries.getActiveAccountForEngine('codex');
		if (!account) {
			throw new Error('Codex is not configured. Add an OpenAI API key or sign in with ChatGPT in Settings → Engines → Codex.');
		}

		const credential = parseCodexCredential(account.credential);
		if (!credential) {
			throw new Error(`Codex account "${account.name}" has invalid credentials. Re-add it in Settings → Engines → Codex.`);
		}

		// For ChatGPT mode, ensure ~/.codex/auth.json reflects this account
		// before we construct the SDK client. For API-key mode the apiKey
		// option is passed directly; no filesystem mutation.
		applyAccountAuth(account);

		const codexBinary = resolveBinary('codex');
		const mcpConfig = getCodexMcpConfig(mcpProfileFilter);

		// Codex SDK takes config at construction. We pass `show_raw_agent_reasoning`
		// (so the SDK forwards reasoning text events) and forward the Clopen MCP
		// HTTP endpoint to the spawned subprocess. Sandbox is disabled at the
		// thread level (`sandboxMode: 'danger-full-access'`) to match the trust
		// model of every other engine in this repo — Claude bypasses permissions,
		// OpenCode auto-approves every permission event, Copilot uses `approveAll`,
		// and Qwen's `canUseTool` returns allow for everything. Codex's
		// `workspace-write` sandbox relies on platform primitives (Seatbelt on
		// macOS, Landlock on Linux) that are absent on Windows, where the CLI
		// degrades to read-only — using full-access keeps behaviour consistent.
		// The SDK does NOT inherit process.env when `env` is provided, so we
		// pass the full clean spawn env and layer CODEX_HOME on top to redirect
		// the subprocess's auth.json + sessions into Clopen's isolated dir.
		this.codex = new Codex({
			apiKey: credential.kind === 'api_key' ? credential.apiKey : undefined,
			...(codexBinary ? { codexPathOverride: codexBinary } : {}),
			env: { ...getCleanSpawnEnv(), CODEX_HOME: getCodexHomeDir() },
			config: {
				show_raw_agent_reasoning: true,
				...(Object.keys(mcpConfig).length > 0 ? { mcp_servers: mcpConfig } : {}),
			},
		});
		this.currentAccountId = account.id;
		this.currentMcpFilterKey = mcpKey;
		this._isInitialized = true;
		debug.log('engine', `Codex engine initialized (account ${account.id}, mode=${credential.kind}, mcpFilter=${mcpKey})`);
	}

	async dispose(): Promise<void> {
		await this.cancel();
		this.codex = null;
		this.currentAccountId = null;
		this.currentMcpFilterKey = null;
		this._isInitialized = false;
		debug.log('engine', 'Codex engine disposed');
	}

	async getAvailableModels(): Promise<EngineModel[]> {
		// Static catalog — no CLI call needed (plan §4.7).
		return CODEX_MODELS;
	}

	async *streamQuery(options: EngineQueryOptions): AsyncGenerator<EngineOutput, void, unknown> {
		const { projectPath, prompt, resume, modelId, abortController, accountId } = options;

		// Active Profile for this stream — scopes the materialized artifact set AND
		// (below) the MCP connector set baked into the Codex client.
		const profileId = options.mcpContext?.profileId;
		// Refresh the synthetic skills preamble in CODEX_HOME before the turn.
		await syncSkills('codex', profileId);
		await syncEngineArtifacts('codex', profileId);

		// Per-stream account/profile override — the SDK bakes both the apiKey and the
		// MCP set at construction, so a change in either requires re-creating the
		// client. The connector filter narrows MCP to the Profile's set (like Claude/
		// Qwen/Copilot do per stream); `undefined` = unfiltered → no change for the
		// common no-profile path.
		const mcpProfileFilter = artifactFilter(profileId, 'mcp') ?? undefined;
		const mcpKey = mcpProfileFilter ? [...mcpProfileFilter].sort().join(',') : '*';
		const accountChanged = this._isInitialized && accountId != null && accountId !== this.currentAccountId;
		const mcpChanged = this._isInitialized && mcpKey !== this.currentMcpFilterKey;
		if (accountChanged || mcpChanged) {
			debug.log('engine', `Codex re-initialising (accountChanged=${accountChanged}, mcpChanged=${mcpChanged})`);
			await this.dispose();
		}
		if (!this._isInitialized || !this.codex) {
			await this.initialize(accountId, mcpProfileFilter);
		}
		if (!this.codex) {
			throw new Error('Codex client unavailable.');
		}

		// Refresh auth.json for the active account every turn (cheap idempotent
		// op — only writes when the file content drifts from the stored blob).
		const activeAccount = accountId != null
			? engineQueries.getAccount(accountId)
			: engineQueries.getActiveAccountForEngine('codex');
		if (activeAccount) {
			applyAccountAuth(activeAccount);
		}

		this.activeController = abortController || new AbortController();

		const resolvedProjectPath = resolveOsPath(projectPath);
		const state = createCodexState('', modelId);

		const threadOptions: ThreadOptions = {
			model: modelId,
			workingDirectory: resolvedProjectPath,
			skipGitRepoCheck: true,
			sandboxMode: 'danger-full-access',
			approvalPolicy: 'never',
			modelReasoningEffort: 'medium',
			webSearchMode: 'cached',
			webSearchEnabled: true,
		};

		try {
			let thread: Thread;

			if (resume) {
				// Fork-by-copy on EVERY resume — same semantics as Copilot
				// (README §9.10 sharp edge: never gate on options.forkSession).
				let resumeId = resume;
				if (sessionStateExists(resume)) {
					const forkId = crypto.randomUUID();
					if (forkCodexSessionState(resume, forkId)) {
						resumeId = forkId;
					}
				}
				try {
					thread = this.codex.resumeThread(resumeId, threadOptions);
					debug.log('engine', `Codex resumed thread: ${resumeId}${resumeId === resume ? '' : ` (forked from ${resume})`}`);
				} catch (error) {
					debug.warn('engine', `Failed to resume Codex thread ${resumeId}, starting fresh:`, error);
					thread = this.codex.startThread(threadOptions);
				}
			} else {
				thread = this.codex.startThread(threadOptions);
			}

			this.activeThread = thread;

			// Prompt-scoped engine: advertise the profile-scoped Skills/Commands/
			// Subagents PER-SESSION via the prompt (not the shared global AGENTS.md /
			// persistent client) so the active Profile scopes them correctly.
			const artifactsContext = buildArtifactsPromptContext(profileId);
			const input = await buildCodexInput(prompt, artifactsContext || undefined);
			const { events } = await thread.runStreamed(input, {
				signal: this.activeController.signal,
			});

			for await (const event of events) {
				if (this.activeController.signal.aborted) break;

				switch (event.type) {
					case 'thread.started':
						yield* convertThreadStarted(event, state);
						break;

					case 'turn.started':
						yield* convertTurnStarted(state);
						break;

					case 'item.started':
						yield* convertItemStarted(event, state);
						break;

					case 'item.updated':
						yield* convertItemUpdated(event, state);
						break;

					case 'item.completed':
						yield* convertItemCompleted(event, state);
						break;

					case 'turn.completed':
						yield* convertTurnCompleted(event, state);
						break;

					case 'turn.failed':
						throw buildTurnError(event.error);

					case 'error':
						throw new Error(event.message || 'Unknown Codex error');
				}
			}

			yield buildResultEvent(state, this.activeController.signal.aborted);
		} catch (error) {
			handleStreamError(error);
		} finally {
			// Snapshot the (possibly token-refreshed) auth.json back to DB so
			// refreshes survive across account switches (README §9.13 step 4).
			try {
				snapshotAuthJsonToActiveAccount();
			} catch (snapshotErr) {
				debug.warn('engine', 'Codex: post-stream auth.json snapshot failed (non-fatal):', snapshotErr);
			}
			this.activeThread = null;
			this.activeController = null;
		}
	}

	async cancel(): Promise<void> {
		// Abort the local controller so the for-await loop exits even if the
		// SDK's signal propagation hangs.
		if (this.activeController && !this.activeController.signal.aborted) {
			this.activeController.abort();
		}
		this.activeController = null;
		this.activeThread = null;
	}

	async interrupt(): Promise<void> {
		await this.cancel();
	}

	/**
	 * One-shot structured JSON generation via the SDK's native `outputSchema`.
	 * The CLI returns the JSON-serialised object as `Turn.finalResponse` (and
	 * as the text of the trailing `agent_message` item) — see codex-sdk
	 * `TurnOptions.outputSchema` in `dist/index.d.ts`.
	 */
	async generateStructured<T = unknown>(options: StructuredGenerationOptions): Promise<T> {
		const {
			prompt,
			modelId,
			schema,
			projectPath,
			abortController,
			accountId,
		} = options;

		if (!this._isInitialized || !this.codex || (accountId != null && accountId !== this.currentAccountId)) {
			if (this._isInitialized) {
				await this.dispose();
			}
			await this.initialize(accountId);
		}
		if (!this.codex) {
			throw new Error('Codex client unavailable.');
		}

		// Refresh auth.json for the active account before the turn (cheap
		// idempotent op — keeps a freshly-refreshed on-disk token, see
		// credential.ts). Without this the structured turn could run on a stale
		// blob; without the finally-snapshot below, a refresh it performs would
		// be lost and the next stream would replay a revoked token.
		const structuredAccount = accountId != null
			? engineQueries.getAccount(accountId)
			: engineQueries.getActiveAccountForEngine('codex');
		if (structuredAccount) {
			applyAccountAuth(structuredAccount);
		}

		const controller = abortController || new AbortController();
		const resolvedProjectPath = resolveOsPath(projectPath);

		const thread = this.codex.startThread({
			model: modelId,
			workingDirectory: resolvedProjectPath,
			skipGitRepoCheck: true,
			sandboxMode: 'read-only',
			approvalPolicy: 'never',
			modelReasoningEffort: 'low',
		});

		debug.log('engine', `[codex structured] running with model=${modelId}`);

		try {
			const turn = await thread.run(prompt, {
				outputSchema: schema,
				signal: controller.signal,
			});

			if (!turn.finalResponse) {
				throw new Error('Codex returned empty response');
			}

			return extractJson<T>(turn.finalResponse);
		} finally {
			// Persist any token refresh the CLI performed during this turn so the
			// next stream doesn't replay an already-rotated (revoked) token.
			try {
				snapshotAuthJsonToActiveAccount();
			} catch (snapshotErr) {
				debug.warn('engine', 'Codex: post-structured auth.json snapshot failed (non-fatal):', snapshotErr);
			}
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

async function buildCodexInput(prompt: EngineQueryOptions['prompt'], prefixText?: string): Promise<CodexInput> {
	const items: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = [];

	// Optional per-session context (e.g. the profile-scoped skills preamble),
	// prepended so it leads the turn.
	if (prefixText) {
		items.push({ type: 'text', text: prefixText });
	}

	for (const block of prompt.content) {
		if (block.type === 'text') {
			items.push({ type: 'text', text: block.text });
		} else if (block.type === 'image') {
			// Codex's SDK accepts local_image paths only — write the image
			// bytes to a tmp file, then pass the path.
			const tmpPath = await writeImageToTemp(block.data, block.mediaType);
			if (tmpPath) {
				items.push({ type: 'local_image', path: tmpPath });
			}
		}
		// Document blocks (PDF) — Codex SDK has no document input. Skipped.
	}

	if (items.length === 0) {
		return '';
	}
	if (items.length === 1 && items[0].type === 'text') {
		return items[0].text;
	}
	return items;
}

async function writeImageToTemp(base64: string, mediaType: string): Promise<string | null> {
	try {
		const ext = mediaType.split('/')[1]?.split('+')[0] || 'png';
		const tmpDir = path.join(os.tmpdir(), 'clopen-codex');
		if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
		const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.${ext}`);
		const buffer = Buffer.from(base64, 'base64');
		fs.writeFileSync(tmpPath, buffer);
		return tmpPath;
	} catch (err) {
		debug.warn('engine', 'Codex: failed to write image attachment:', err);
		return null;
	}
}

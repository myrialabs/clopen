/**
 * Chat Model State Store
 *
 * Holds the local engine/model selection for the chat input.
 * Isolated from Settings — Settings only provides the initial default.
 * Changes here do NOT persist to Settings, and Settings changes do NOT
 * affect the current session's selection after the first message is sent.
 */

import { DEFAULT_ENGINE, DEFAULT_MODEL_ID, DEFAULT_MODEL_NAME } from '$shared/constants/engines';
import type { EngineType } from '$shared/types/unified';
import type { ChatSession } from '$shared/types/database/schema';
import { sessionState } from '$frontend/stores/core/sessions.svelte';

interface ChatModelState {
	engine: EngineType;
	provider: string;
	modelId: string;
	modelName: string;
	engineModelMemory: Record<string, { provider: string; id: string; name: string }>;
	accountId: number | null;
	accountName: string | null;
	/** Active Profile for this session. `null` = no profile / use project default. */
	profileId: number | null;
	/**
	 * Reasoning/thinking level for the selected model (native per engine).
	 * `null` = use the engine/model default (no explicit choice). Sent with the
	 * turn and persisted to the session record.
	 */
	reasoningEffort: string | null;
}

// Local reactive state — starts from compile-time defaults.
// Initialized from Settings on each new session via initChatModel().
export const chatModelState = $state<ChatModelState>({
	engine: DEFAULT_ENGINE,
	provider: 'anthropic',
	modelId: DEFAULT_MODEL_ID,
	modelName: DEFAULT_MODEL_NAME,
	engineModelMemory: { 'claude-code': { provider: 'anthropic', id: DEFAULT_MODEL_ID, name: DEFAULT_MODEL_NAME } },
	accountId: null,
	accountName: null,
	profileId: null,
	reasoningEffort: null
});

/**
 * Initialize the local chat model state from Settings defaults.
 * Called when a new session starts (no messages yet).
 */
export function initChatModel(
	engine: EngineType,
	provider: string,
	modelId: string,
	modelName: string,
	memory: Record<string, { provider: string; id: string; name: string }>,
	reasoningEffort: string | null = null
): void {
	chatModelState.engine = engine;
	chatModelState.provider = provider;
	chatModelState.modelId = modelId;
	chatModelState.modelName = modelName;
	chatModelState.engineModelMemory = { ...memory };
	// accountId/accountName are set by EngineModelPicker after fetching engine-specific accounts
	chatModelState.accountId = null;
	chatModelState.accountName = null;
	// New session: no explicit profile choice yet — the stream falls back to the
	// project default. The picker surfaces that default; a user pick sets it.
	chatModelState.profileId = null;
	// Seed the reasoning level from the per-model default (Settings → Models).
	chatModelState.reasoningEffort = reasoningEffort;
}

/**
 * Restore the local chat model state from a session's persisted engine/model.
 * Called when continuing an existing session (has messages).
 * IMPORTANT: Must NOT read from chatModelState to avoid circular tracking in $effect.
 */
export function restoreChatModelFromSession(
	engine: EngineType,
	provider: string,
	modelId: string,
	modelName: string,
	accountId?: number | null,
	accountName?: string | null,
	profileId?: number | null,
	reasoningEffort?: string | null
): void {
	chatModelState.engine = engine;
	chatModelState.provider = provider;
	chatModelState.modelId = modelId;
	chatModelState.modelName = modelName;
	// Only set the current engine's model — avoids reading chatModelState.engineModelMemory
	// which would cause UpdatedAtError in Svelte 5 $effect tracking
	chatModelState.engineModelMemory = { [engine]: { provider, id: modelId, name: modelName } };
	chatModelState.accountId = accountId ?? null;
	chatModelState.accountName = accountName ?? null;
	chatModelState.profileId = profileId ?? null;
	chatModelState.reasoningEffort = reasoningEffort ?? null;
}

// ════════════════════════════════════════════
// Session ↔ picker bookkeeping
// ════════════════════════════════════════════

type SelectionFields = Pick<ChatSession, 'engine' | 'provider' | 'model_id' | 'model_name' | 'account_id' | 'account_name' | 'profile_id' | 'reasoning_effort'>;

/**
 * Key of the selection the picker should be initialised from.
 *
 * `sessionState.currentSession` is replaced wholesale all the time (fresh
 * fetch on switch, list refresh, collaborator mirrors), so the init effect
 * must not run on object identity — that reset account/profile/reasoning on
 * every replacement. It runs when this key changes instead:
 * - session with a persisted engine/model → id + every persisted field, so a
 *   server-fresh copy that really differs is still picked up;
 * - fresh session → id + the Settings defaults it is seeded from (late
 *   settings hydration still applies), ignoring everything else.
 */
export function selectionInitKey(session: ChatSession | null | undefined, defaultsSignature: string): string {
	if (session?.engine && session.model_id) {
		return JSON.stringify([
			session.id, session.engine, session.provider ?? null, session.model_id, session.model_name ?? null,
			session.account_id ?? null, session.account_name ?? null, session.profile_id ?? null, session.reasoning_effort ?? null
		]);
	}
	return JSON.stringify([session?.id ?? null, 'fresh', defaultsSignature]);
}

// Not reactive on purpose: it is bookkeeping for the init effect, which must
// not re-run because it changed.
let appliedSelectionKey: string | null = null;

/** Returns true (and records the key) when the picker has not been initialised for `key` yet. */
export function claimSelectionInit(key: string): boolean {
	if (key === appliedSelectionKey) return false;
	appliedSelectionKey = key;
	return true;
}

/**
 * Mirror a selection change onto `sessionState.currentSession` without making
 * the init effect treat it as new server state.
 *
 * Mirroring keeps the session object truthful (other code reads engine/model
 * from it), and recording the resulting key means the replacement does not
 * re-run init and revert the picker's other fields.
 */
export function patchCurrentSessionSelection(patch: Partial<SelectionFields>): void {
	const current = sessionState.currentSession;
	if (!current) return;
	const next: ChatSession = { ...current, ...patch };
	sessionState.currentSession = next;
	// A fresh session's key ignores these fields, so only a session that is
	// (now) persisted needs its key advanced.
	if (next.engine && next.model_id) appliedSelectionKey = selectionInitKey(next, '');
}

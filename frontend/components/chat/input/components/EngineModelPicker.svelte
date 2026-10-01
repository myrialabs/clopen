<script lang="ts">
	import { untrack } from 'svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { settings, togglePinnedModel, setReasoningDefault } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { userStore } from '$frontend/stores/features/user.svelte';
	import {
		chatModelState,
		initChatModel,
		restoreChatModelFromSession,
		selectionInitKey,
		claimSelectionInit,
		patchCurrentSessionSelection
	} from '$frontend/stores/ui/chat-model.svelte';
	import { ENGINES, getModelTags, pickDefaultModel, reasoningLevelLabel } from '$shared/constants/engines';
	import type { EngineType, EngineModel } from '$shared/types/unified';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ProfilePicker from './ProfilePicker.svelte';
	import { openSettingsModal, focusEngineSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { claudeAccountsStore, type ClaudeAccountItem } from '$frontend/stores/features/claude-accounts.svelte';
	import { copilotAccountsStore, type CopilotAccountItem } from '$frontend/stores/features/copilot-accounts.svelte';
	import { codexAccountsStore, type CodexAccountItem } from '$frontend/stores/features/codex-accounts.svelte';
	import { qwenAccountsStore, type QwenAccountItem } from '$frontend/stores/features/qwen-accounts.svelte';
	import { piAccountsStore, type PiAccountItem } from '$frontend/stores/features/pi-accounts.svelte';
	import { clineAccountsStore, type ClineAccountItem } from '$frontend/stores/features/cline-accounts.svelte';
	import { cursorAccountsStore, type CursorAccountItem } from '$frontend/stores/features/cursor-accounts.svelte';
	import { opencodeProvidersStore, type OpenCodeProviderItem, type OpenCodeAccountItem } from '$frontend/stores/features/opencode-providers.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import { formatProvider, formatTokens } from '$frontend/utils/format';
	import { CLIENT_ID } from '$frontend/utils/client-id';
	import { anchoredPopover } from '$frontend/utils/anchored-popover';

	// ════════════════════════════════════════════
	// Collaborative sync
	//
	// `chat:model-sync` / `chat:account-sync` / `chat:reasoning-sync` are emitted
	// ONLY from explicit user actions (selectModel, selectEngine, selectAccount,
	// selectOCAccount, selectReasoning). Restores, init and auto-selection are
	// local: emitting from them made every client that opened a session
	// broadcast its own restored/defaulted state over its collaborators'.
	// ════════════════════════════════════════════

	interface SyncEnvelope {
		senderId: string;
		clientId?: string;
		chatSessionId?: string;
	}

	/** Session + sender for an outgoing sync, or null when there is nothing to sync to. */
	function syncTarget(): { chatSessionId: string; senderId: string } | null {
		const chatSessionId = sessionState.currentSession?.id;
		const senderId = userStore.currentUser?.id;
		if (!chatSessionId || !senderId) return null;
		return { chatSessionId, senderId };
	}

	/**
	 * Whether an incoming sync must be ignored: it is this tab's own echo (by
	 * per-tab clientId, so the same user's other tabs/devices still apply it;
	 * user-id fallback for payloads without one), or it belongs to a session
	 * this tab has already switched away from.
	 */
	function ignoreSync(data: SyncEnvelope): boolean {
		const own = data.clientId ? data.clientId === CLIENT_ID : data.senderId === userStore.currentUser?.id;
		if (own) return true;
		return data.chatSessionId !== sessionState.currentSession?.id;
	}

	function emitModelSync() {
		const target = syncTarget();
		if (!target || !chatModelState.modelId) return;
		ws.emit('chat:model-sync', {
			...target,
			clientId: CLIENT_ID,
			engine: chatModelState.engine,
			provider: chatModelState.provider,
			modelId: chatModelState.modelId,
			modelName: chatModelState.modelName,
			reasoningEffort: chatModelState.reasoningEffort
		});
	}

	function emitAccountSync() {
		const target = syncTarget();
		if (!target) return;
		ws.emit('chat:account-sync', {
			...target,
			clientId: CLIENT_ID,
			accountId: chatModelState.accountId,
			accountName: chatModelState.accountName
		});
	}

	function emitReasoningSync() {
		const target = syncTarget();
		if (!target) return;
		ws.emit('chat:reasoning-sync', {
			...target,
			clientId: CLIENT_ID,
			reasoningEffort: chatModelState.reasoningEffort
		});
	}

	// ════════════════════════════════════════════
	// Single-account-list engines: Claude Code + Copilot
	// (Both stores expose the same { accounts, fetch, refresh, set, reset } API,
	// so a single picker UI handles both — engine-specific logic only diverges
	// at the store reference resolved by `accountsForEngine`.)
	// ════════════════════════════════════════════

	type SimpleAccount = ClaudeAccountItem | CopilotAccountItem | CodexAccountItem | QwenAccountItem | PiAccountItem | ClineAccountItem | CursorAccountItem;

	const accountsForEngine = $derived<SimpleAccount[]>(
		chatModelState.engine === 'claude-code'
			? claudeAccountsStore.accounts
			: chatModelState.engine === 'copilot'
				? copilotAccountsStore.accounts
				: chatModelState.engine === 'codex'
					? codexAccountsStore.accounts
					: chatModelState.engine === 'qwen'
						? qwenAccountsStore.accounts
						: chatModelState.engine === 'pi'
							? piAccountsStore.accounts
							: chatModelState.engine === 'cline'
								? clineAccountsStore.accounts
								: chatModelState.engine === 'cursor'
									? cursorAccountsStore.accounts
									: []
	);

	const currentAccount = $derived(
		accountsForEngine.find(a => a.id === chatModelState.accountId) || null
	);

	/** Auth mode for the active Codex account — drives ChatGPT-only model filtering. */
	const codexActiveAuthMode = $derived<'chatgpt' | 'api_key' | null>(
		chatModelState.engine === 'codex' && currentAccount && 'authMode' in currentAccount
			? (currentAccount as CodexAccountItem).authMode ?? null
			: null
	);

	const accountPickerLabel = $derived(
		chatModelState.engine === 'copilot' ? 'Copilot Account'
			: chatModelState.engine === 'codex' ? 'Codex Account'
			: chatModelState.engine === 'qwen' ? 'Qwen Code Account'
			: chatModelState.engine === 'pi' ? 'Pi Account'
			: chatModelState.engine === 'cline' ? 'Cline Account'
			: chatModelState.engine === 'cursor' ? 'Cursor Account'
			: 'Claude Account'
	);

	const showAccountPicker = $derived(
		chatModelState.engine === 'claude-code'
		|| chatModelState.engine === 'copilot'
		|| chatModelState.engine === 'codex'
		|| chatModelState.engine === 'qwen'
		|| chatModelState.engine === 'pi'
		|| chatModelState.engine === 'cline'
		|| chatModelState.engine === 'cursor'
	);
	const hasEngineAccounts = $derived(accountsForEngine.length > 0);

	// Fetch accounts when engine switches into a single-account-list engine
	$effect(() => {
		const engine = chatModelState.engine;
		if (engine === 'claude-code') {
			claudeAccountsStore.fetch();
		} else if (engine === 'copilot') {
			copilotAccountsStore.fetch();
		} else if (engine === 'codex') {
			codexAccountsStore.fetch();
		} else if (engine === 'qwen') {
			qwenAccountsStore.fetch();
		} else if (engine === 'pi') {
			piAccountsStore.fetch();
		} else if (engine === 'cline') {
			clineAccountsStore.fetch();
		} else if (engine === 'cursor') {
			cursorAccountsStore.fetch();
		}
	});

	// Auto-select active account when no account is set and accounts are loaded
	$effect(() => {
		const engine = chatModelState.engine;
		const accounts = accountsForEngine;
		const currentId = chatModelState.accountId;

		if ((engine === 'claude-code' || engine === 'copilot' || engine === 'codex' || engine === 'qwen' || engine === 'pi' || engine === 'cline' || engine === 'cursor') && accounts.length > 0) {
			untrack(() => {
				// If no account set, or current account not found in list, use active account
				const hasValidAccount = currentId !== null && accounts.some(a => a.id === currentId);
				if (!hasValidAccount) {
					const activeAccount = accounts.find(a => a.isActive);
					if (activeAccount) {
						chatModelState.accountId = activeAccount.id;
						chatModelState.accountName = activeAccount.name;
					}
				}
			});
		}
	});

	// Listen for remote account changes from collaborators (and this user's
	// other tabs/devices)
	$effect(() => {
		const unsub = ws.on('chat:account-sync', (data: SyncEnvelope & { accountId: number | null; accountName: string | null }) => {
			if (ignoreSync(data)) return;
			debug.log('chat', 'Remote account sync:', data);
			chatModelState.accountId = data.accountId;
			chatModelState.accountName = data.accountName;
			patchCurrentSessionSelection({
				account_id: data.accountId ?? undefined,
				account_name: data.accountName ?? undefined
			});
		});
		return unsub;
	});

	// Account dropdown state
	let showAccountDropdown = $state(false);
	let accountTriggerButton = $state<HTMLButtonElement>();
	// A server-side account switch in flight — blocks a second pick until it settles.
	let accountSwitching = $state(false);

	function toggleAccountDropdown() {
		if (!showAccountDropdown) accountSearchQuery = '';
		showAccountDropdown = !showAccountDropdown;
	}

	function closeAccountDropdown() {
		showAccountDropdown = false;
	}

	/**
	 * Promote the picked account to DB-active where the engine needs it.
	 * Throws when the server refuses, so the caller keeps the previous account.
	 *
	 * - Codex: switching swaps `~/.codex/auth.json` server-side so the next
	 *   subprocess (and the model-listing path) picks up the right blob.
	 * - Qwen / Cursor: models are discovered against the active account's
	 *   endpoint / API key, so the catalog is refreshed too.
	 * - Pi / Cline: multi-provider — the (union) catalog follows the account.
	 * - Claude Code / Copilot: nothing server-side; the per-stream `accountId`
	 *   override applies the pick.
	 */
	async function promoteAccountOnServer(engine: EngineType, id: number): Promise<void> {
		switch (engine) {
			case 'codex':
				await ws.http('engine:codex-accounts-switch', { id });
				await codexAccountsStore.refresh();
				return;
			case 'qwen':
				await ws.http('engine:qwen-accounts-switch', { id });
				await qwenAccountsStore.refresh();
				await modelStore.refreshModels('qwen');
				return;
			case 'pi':
				await ws.http('engine:pi-accounts-switch', { id });
				await piAccountsStore.refresh();
				await modelStore.refreshModels('pi');
				return;
			case 'cline':
				await ws.http('engine:cline-accounts-switch', { id });
				await clineAccountsStore.refresh();
				await modelStore.refreshModels('cline');
				return;
			case 'cursor':
				await ws.http('engine:cursor-accounts-switch', { id });
				await cursorAccountsStore.refresh();
				await modelStore.refreshModels('cursor');
				return;
			default:
				return;
		}
	}

	async function selectAccount(account: SimpleAccount) {
		if (accountSwitching) return;
		closeAccountDropdown();
		if (account.id === chatModelState.accountId) return;

		const engine = chatModelState.engine;
		const sessionId = sessionState.currentSession?.id;
		accountSwitching = true;
		try {
			await promoteAccountOnServer(engine, account.id);
		} catch (err) {
			// Local state is only committed after the server agrees, so a failed
			// switch leaves the picker on the account that is actually active.
			debug.warn('chat', `${engine} account switch failed — keeping the current account:`, err);
			return;
		} finally {
			accountSwitching = false;
		}

		// The user moved on (other engine / other session) while we waited.
		if (chatModelState.engine !== engine || sessionState.currentSession?.id !== sessionId) return;

		chatModelState.accountId = account.id;
		chatModelState.accountName = account.name;
		patchCurrentSessionSelection({ account_id: account.id, account_name: account.name });
		emitAccountSync();
	}

	// ════════════════════════════════════════════
	// OpenCode Accounts (reads from shared store)
	// ════════════════════════════════════════════

	const ocProviders = $derived(opencodeProvidersStore.providers);

	// Determine the provider of the currently selected model
	const ocSelectedModelProvider = $derived.by(() => {
		if (chatModelState.engine !== 'opencode' || !currentModel) return null;
		return currentModel.engine.provider || null;
	});

	// Find the DB provider matching the selected model's provider
	const ocMatchingProvider = $derived.by((): OpenCodeProviderItem | null => {
		if (!ocSelectedModelProvider) return null;
		return ocProviders.find(p => p.slug === ocSelectedModelProvider) || null;
	});

	// Show OpenCode account picker only for non-free providers with accounts
	const showOCAccountPicker = $derived(
		chatModelState.engine === 'opencode' &&
		ocMatchingProvider !== null &&
		ocMatchingProvider.slug !== 'opencode' &&
		ocMatchingProvider.accounts.length > 0
	);

	const currentOCAccount = $derived.by((): OpenCodeAccountItem | null => {
		if (!ocMatchingProvider) return null;
		return ocMatchingProvider.accounts.find(a => a.isActive) || null;
	});

	// Fetch providers when engine switches to opencode
	$effect(() => {
		const engine = chatModelState.engine;
		if (engine === 'opencode') {
			opencodeProvidersStore.fetchProviders();
		}
	});

	// Auto-select active opencode account into chatModelState
	$effect(() => {
		const engine = chatModelState.engine;
		const ocAccount = currentOCAccount;

		if (engine === 'opencode' && ocAccount) {
			untrack(() => {
				chatModelState.accountId = ocAccount.id;
				chatModelState.accountName = ocAccount.name;
			});
		}
	});

	// OpenCode account dropdown state
	let showOCAccountDropdown = $state(false);
	let ocAccountTriggerButton = $state<HTMLButtonElement>();

	function toggleOCAccountDropdown() {
		showOCAccountDropdown = !showOCAccountDropdown;
	}

	function closeOCAccountDropdown() {
		showOCAccountDropdown = false;
	}

	async function selectOCAccount(account: OpenCodeAccountItem) {
		if (accountSwitching) return;
		closeOCAccountDropdown();
		const sessionId = sessionState.currentSession?.id;
		accountSwitching = true;
		try {
			// The switch is all there is to do: the backend notices the account change
			// and has the next turn talk to a server built with the new credential,
			// while any turn already running finishes on the old one.
			await opencodeProvidersStore.switchAccount(account.id);
		} catch (err) {
			debug.warn('chat', 'OpenCode account switch failed — keeping the current account:', err);
			return;
		} finally {
			accountSwitching = false;
		}
		if (chatModelState.engine !== 'opencode' || sessionState.currentSession?.id !== sessionId) return;
		chatModelState.accountId = account.id;
		chatModelState.accountName = account.name;
		patchCurrentSessionSelection({ account_id: account.id, account_name: account.name });
		emitAccountSync();
	}

	// ════════════════════════════════════════════
	// Model Picker (existing logic)
	// ════════════════════════════════════════════

	// The engine is switchable at any point in a session. When it changes
	// mid-conversation the backend replays the branch to the new engine as
	// prompt content (backend/chat/engine-handoff.ts), so there is nothing to
	// lock — the new engine picks up with the full conversation behind it.

	// Read from local chat model state (isolated from Settings)
	const currentEngine = $derived(ENGINES.find(e => e.type === chatModelState.engine));
	// Engine-scoped: model ids collide across engines (the same OpenAI id is
	// served by several), so a global lookup could resolve another engine's model.
	const currentModel = $derived(modelStore.getForEngine(chatModelState.engine, chatModelState.modelId));
	const engineModelsLoading = $derived(modelStore.isLoading(chatModelState.engine));

	// ── Reasoning / thinking level (only when the selected model exposes one) ──
	const currentReasoningControl = $derived(currentModel?.capabilities.reasoningControl ?? null);
	const currentReasoningValue = $derived(
		chatModelState.reasoningEffort
		?? settings.reasoningDefaults[chatModelState.modelId]
		?? currentReasoningControl?.default
		?? null
	);
	const currentReasoningLabel = $derived(
		currentReasoningValue
			? (currentReasoningControl?.levels.find(l => l.value === currentReasoningValue)?.label ?? reasoningLevelLabel(currentReasoningValue))
			: ''
	);

	// Keep chatModelState.reasoningEffort holding the EFFECTIVE level so it's sent
	// with the turn (and surfaces in the Raw Message). Reasoning-capable model →
	// per-model default (Settings) or the model's own default; a value invalid for
	// the current model is re-seeded. No knob → cleared to null.
	//
	// Only once the model is resolved: before the catalog loads (e.g. right after
	// a reload) `control` is null merely because the model is unknown, and
	// clearing then wiped the level restored from the session.
	$effect(() => {
		const control = currentReasoningControl;
		const resolved = !!currentModel && !engineModelsLoading;
		const modelId = chatModelState.modelId;
		const defaults = settings.reasoningDefaults;
		if (!resolved) return;
		untrack(() => {
			const current = chatModelState.reasoningEffort;
			if (!control) {
				if (current != null) chatModelState.reasoningEffort = null;
				return;
			}
			const valid = control.levels.some(l => l.value === current);
			if (!valid) chatModelState.reasoningEffort = defaults[modelId] ?? control.default;
		});
	});

	// Readiness error for the active engine (e.g. not installed / not signed in),
	// surfaced by models:list. Drives the not-installed → Open Stack notice below.
	const engineError = $derived(modelStore.getError(chatModelState.engine));
	const isAdmin = $derived(authStore.isAdmin);
	const availableModels = $derived.by(() => {
		const all = modelStore.getByEngine(chatModelState.engine);
		// Codex auth-mode filter (plan §6 + README §6.2): hide ChatGPT-only
		// models when the active account is API-key, and vice versa.
		if (chatModelState.engine === 'codex' && codexActiveAuthMode) {
			return all.filter(m => {
				const required = m.capabilities?.requiresAuthMode;
				if (!required) return true;
				return required === codexActiveAuthMode;
			});
		}
		return all;
	});

	// The catalog for the active engine is not in yet (loading, or never fetched
	// and not failed). The trigger and reasoning pill keep their last value
	// meanwhile instead of collapsing — no layout shift on reload/engine switch.
	const modelsPending = $derived(
		engineModelsLoading || (!modelStore.isFetched(chatModelState.engine) && !engineError)
	);

	// Label shown in the trigger button
	const triggerLabel = $derived.by(() => {
		if (currentModel) return currentModel.engine.model.name;
		if (modelsPending) return chatModelState.modelName || 'Loading...';
		return 'No model selected';
	});

	// Show the restored reasoning level (disabled) until the model resolves.
	const reasoningPending = $derived(!currentModel && modelsPending && !!chatModelState.reasoningEffort);

	// Initialize model picker based on session state:
	// - Session with persisted engine/model: restore from session
	// - Otherwise (new session, or legacy session without engine/model): apply
	//   Settings defaults
	//
	// Runs only when `selectionInitKey` changes — a different session, a
	// server-fresh copy whose persisted selection really differs, or (fresh
	// session only) different Settings defaults. NOT on every replacement of
	// the `currentSession` object: that re-ran init and reset the account,
	// profile and reasoning picks of fresh sessions. Local picks and remote
	// syncs mirror onto the session via patchCurrentSessionSelection, which
	// records the key so the mirror itself never re-triggers init.
	$effect(() => {
		const session = sessionState.currentSession;
		const sEngine = settings.selectedEngine;
		const sProvider = settings.selectedProvider;
		const sModelId = settings.selectedModelId;
		const sModelName = settings.selectedModelName;
		const key = selectionInitKey(session, JSON.stringify([sEngine, sProvider, sModelId, sModelName]));

		untrack(() => {
			if (!claimSelectionInit(key)) return;
			// Read per-model reasoning defaults untracked: editing a default (here or
			// via the pill) must not re-trigger this init and clobber the live choice.
			const reasoningDefaults = settings.reasoningDefaults;
			if (session?.engine && session.model_id) {
				restoreChatModelFromSession(session.engine, session.provider || sProvider, session.model_id, session.model_name || '', session.account_id, session.account_name, session.profile_id, session.reasoning_effort ?? null);
			} else {
				initChatModel(sEngine, sProvider, sModelId, sModelName, settings.engineModelMemory || {}, reasoningDefaults[sModelId] ?? null);
			}
		});
	});

	// Pre-load models for the current engine whenever it changes.
	// Ensures models are ready without waiting for the user to open the dropdown.
	$effect(() => {
		const engine = chatModelState.engine;
		modelStore.fetchModels(engine);
	});

	// Auto-select a model if no valid model is set for the current engine.
	// Reads (engine, currentModel, availableModels) are tracked; writes use untrack
	// to prevent circular chatModelState read-write (UpdatedAtError).
	// Local only — not broadcast (see "Collaborative sync" above).
	$effect(() => {
		const engine = chatModelState.engine;
		const modelValid = !!currentModel;
		const models = availableModels;
		if (!modelValid && models.length > 0) {
			untrack(() => {
				const memory = chatModelState.engineModelMemory;
				const remembered = memory[engine];
				const target =
					(remembered && models.find(m => m.engine.model.id === remembered.id)) ||
					pickDefaultModel(models);
				if (target) {
					chatModelState.provider = target.engine.provider;
					chatModelState.modelId = target.engine.model.id;
					chatModelState.modelName = target.engine.model.name;
					chatModelState.engineModelMemory = { ...memory, [engine]: { provider: target.engine.provider, id: target.engine.model.id, name: target.engine.model.name } };
					chatModelState.reasoningEffort = settings.reasoningDefaults[target.engine.model.id] ?? null;
				}
			});
		}
	});

	// Listen for remote model changes from collaborators (and this user's other
	// tabs/devices)
	$effect(() => {
		const unsub = ws.on('chat:model-sync', (data: SyncEnvelope & { engine: string; provider: string; modelId: string; modelName: string; reasoningEffort?: string | null }) => {
			if (ignoreSync(data)) return;
			debug.log('chat', 'Remote model sync:', data);
			const engine = data.engine as EngineType;
			const engineChanged = engine !== chatModelState.engine;
			chatModelState.engine = engine;
			chatModelState.provider = data.provider;
			chatModelState.modelId = data.modelId;
			chatModelState.modelName = data.modelName;
			chatModelState.engineModelMemory = {
				...chatModelState.engineModelMemory,
				[engine]: { provider: data.provider, id: data.modelId, name: data.modelName }
			};
			if (data.reasoningEffort !== undefined) chatModelState.reasoningEffort = data.reasoningEffort;
			// Accounts are per engine — the old engine's account is meaningless now;
			// the auto-select effect picks this engine's active account.
			if (engineChanged) {
				chatModelState.accountId = null;
				chatModelState.accountName = null;
			}
			patchCurrentSessionSelection({
				engine,
				provider: data.provider,
				model_id: data.modelId,
				model_name: data.modelName,
				...(data.reasoningEffort !== undefined ? { reasoning_effort: data.reasoningEffort } : {}),
				...(engineChanged ? { account_id: undefined, account_name: undefined } : {})
			});
		});
		return unsub;
	});

	// Search state
	let searchQuery = $state('');
	let collapsedProviders = $state<Set<string>>(new Set());
	// Account dropdown search (Claude Code / Copilot + OpenCode), mirroring models.
	let accountSearchQuery = $state('');

	const filteredAccounts = $derived.by(() => {
		const q = accountSearchQuery.trim().toLowerCase();
		if (!q) return accountsForEngine;
		return accountsForEngine.filter(a => a.name.toLowerCase().includes(q));
	});

	const filteredModels = $derived.by(() => {
		if (!searchQuery.trim()) return availableModels;
		const q = searchQuery.toLowerCase();
		return availableModels.filter(m =>
			m.engine.model.name.toLowerCase().includes(q) ||
			m.engine.model.id.toLowerCase().includes(q) ||
			m.engine.provider.toLowerCase().includes(q)
		);
	});

	// Group models by provider
	const pinnedModelIds = $derived(settings.pinnedModels);

	const groupedModels = $derived.by(() => {
		const groups = new Map<string, EngineModel[]>();
		for (const model of filteredModels) {
			const key = model.engine.provider;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(model);
		}
		return groups;
	});

	// Sync accordion: open all when searching, otherwise only open the provider with the selected model
	$effect(() => {
		if (searchQuery.trim()) {
			collapsedProviders = new Set();
		} else if (groupedModels.size > 0) {
			const allProviders = [...groupedModels.keys()];
			let selectedProvider: string | null = null;
			for (const [provider, models] of groupedModels) {
				if (models.some(m => m.engine.model.id === chatModelState.modelId)) {
					selectedProvider = provider;
					break;
				}
			}
			const collapsed = new Set(allProviders);
			if (selectedProvider) {
				collapsed.delete(selectedProvider);
			}
			collapsedProviders = collapsed;
		}
	});

	function toggleProvider(provider: string) {
		const next = new Set(collapsedProviders);
		if (next.has(provider)) {
			next.delete(provider);
		} else {
			next.add(provider);
		}
		collapsedProviders = next;
	}

	// Dropdown state
	let showDropdown = $state(false);
	let triggerButton = $state<HTMLButtonElement>();

	function toggleDropdown() {
		showDropdown = !showDropdown;
		if (!showDropdown) searchQuery = '';
	}

	function closeDropdown() {
		showDropdown = false;
		searchQuery = '';
	}

	// ── Reasoning-level dropdown ──
	let showReasoningDropdown = $state(false);
	let reasoningTriggerButton = $state<HTMLButtonElement>();

	function toggleReasoningDropdown() {
		showReasoningDropdown = !showReasoningDropdown;
	}

	function closeReasoningDropdown() {
		showReasoningDropdown = false;
	}

	function selectReasoning(value: string) {
		chatModelState.reasoningEffort = value;
		// Remember per-model + surface as the Settings → Models default.
		setReasoningDefault(chatModelState.modelId, value);
		patchCurrentSessionSelection({ reasoning_effort: value });
		emitReasoningSync();
		closeReasoningDropdown();
	}

	// Listen for remote reasoning-level changes from collaborators (and this
	// user's other tabs/devices)
	$effect(() => {
		const unsub = ws.on('chat:reasoning-sync', (data: SyncEnvelope & { reasoningEffort: string | null }) => {
			if (ignoreSync(data)) return;
			debug.log('chat', 'Remote reasoning sync:', data);
			chatModelState.reasoningEffort = data.reasoningEffort;
			patchCurrentSessionSelection({ reasoning_effort: data.reasoningEffort });
		});
		return unsub;
	});

	/**
	 * The concrete level a fresh model pick starts on: this user's per-model
	 * default, else the model's own default. Resolved here (not left null for
	 * the re-seed effect) because it is broadcast with the pick — a null would
	 * make every collaborator re-seed from THEIR per-model defaults and disagree.
	 */
	function effectiveReasoningFor(model: EngineModel): string | null {
		const control = model.capabilities.reasoningControl;
		if (!control) return null;
		return settings.reasoningDefaults[model.engine.model.id] ?? control.default ?? null;
	}

	// Local picks are mirrored onto `sessionState.currentSession` (via
	// patchCurrentSessionSelection) because the sender ignores its own echo:
	// without it `currentSession` stayed stale after every local pick, and code
	// reading engine/model from it saw the old values.

	async function selectEngine(engineType: EngineType) {
		if (engineType === chatModelState.engine) return;
		// Captured before any await: a reply that lands after the user picked
		// another engine or switched session must not be applied.
		const sessionId = sessionState.currentSession?.id;

		// Switch engine immediately so the active tab updates before model fetch
		chatModelState.engine = engineType;
		searchQuery = '';

		// Clear model immediately so it shows null during loading, then fetch.
		// Accounts are per engine, so the previous engine's one goes too (the
		// auto-select effect picks this engine's active account).
		chatModelState.modelId = '';
		chatModelState.modelName = '';
		chatModelState.accountId = null;
		chatModelState.accountName = null;
		await modelStore.fetchModels(engineType);

		if (chatModelState.engine !== engineType || sessionState.currentSession?.id !== sessionId) return;

		// After models are loaded, pick a model for this engine
		const memory = chatModelState.engineModelMemory;
		const remembered = memory[engineType];
		const models = modelStore.getByEngine(engineType);
		const target =
			(remembered && models.find(m => m.engine.model.id === remembered.id)) ||
			pickDefaultModel(models);

		if (target) {
			chatModelState.provider = target.engine.provider;
			chatModelState.modelId = target.engine.model.id;
			chatModelState.modelName = target.engine.model.name;
			chatModelState.engineModelMemory = { ...memory, [engineType]: { provider: target.engine.provider, id: target.engine.model.id, name: target.engine.model.name } };
			chatModelState.reasoningEffort = effectiveReasoningFor(target);
			patchCurrentSessionSelection({
				engine: engineType,
				provider: target.engine.provider,
				model_id: target.engine.model.id,
				model_name: target.engine.model.name,
				reasoning_effort: chatModelState.reasoningEffort,
				account_id: chatModelState.accountId ?? undefined,
				account_name: chatModelState.accountName ?? undefined
			});
			emitModelSync();
			// Persist + broadcast this engine's account (still cleared, or already
			// auto-selected by now) so the session record never keeps the previous
			// engine's account.
			emitAccountSync();
		}
	}

	function selectModel(model: EngineModel) {
		chatModelState.provider = model.engine.provider;
		chatModelState.modelId = model.engine.model.id;
		chatModelState.modelName = model.engine.model.name;
		chatModelState.engineModelMemory = {
			...chatModelState.engineModelMemory,
			[chatModelState.engine]: { provider: model.engine.provider, id: model.engine.model.id, name: model.engine.model.name }
		};
		// Restore the per-model reasoning default (or the model's own default).
		chatModelState.reasoningEffort = effectiveReasoningFor(model);
		patchCurrentSessionSelection({
			engine: chatModelState.engine,
			provider: model.engine.provider,
			model_id: model.engine.model.id,
			model_name: model.engine.model.name,
			reasoning_effort: chatModelState.reasoningEffort
		});
		emitModelSync();
		closeDropdown();
	}

	function retryModels() {
		void modelStore.refreshModels(chatModelState.engine);
	}

	// No accounts connected → Settings → Engines for this engine.
	function connectAccount() {
		closeAllDropdowns();
		openSettingsModal('engines');
		focusEngineSection(chatModelState.engine);
	}

	function closeAllDropdowns() {
		closeDropdown();
		closeAccountDropdown();
		closeOCAccountDropdown();
		closeReasoningDropdown();
	}

	// A stream starting closes every dropdown — selections can't be made mid-turn.
	$effect(() => {
		if (appState.isLoading) untrack(() => closeAllDropdowns());
	});

	// Not-ready shortcuts from the model dropdown: install via Settings → Stack,
	// or configure the engine's account. Both close the dropdown first so the
	// Settings modal isn't hidden behind it.
	function openStack() {
		closeDropdown();
		openSettingsModal('stack');
	}

	function configureEngine(engineType: EngineType) {
		closeDropdown();
		openSettingsModal('engines');
		focusEngineSection(engineType);
	}

</script>

<div class="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-0.5">
	<button
		bind:this={triggerButton}
		type="button"
		class="flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-8 text-xs rounded-lg transition-all duration-150 min-w-0
			bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
			text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
			disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
		onclick={toggleDropdown}
		disabled={appState.isLoading}
		aria-haspopup="listbox"
		aria-expanded={showDropdown}
	>
		{#if currentEngine}
			<div class="flex dark:hidden items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html currentEngine.icon.light}</div>
			<div class="hidden dark:flex items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html currentEngine.icon.dark}</div>
		{/if}
		<span class="font-medium max-w-40 truncate">{triggerLabel}</span>
		<Icon name="lucide:chevron-down" class="w-3 h-3 flex-shrink-0" />
	</button>

	<!-- Account picker (Claude Code + Copilot — both use one-account-per-engine) -->
	{#if showAccountPicker}
		{#if hasEngineAccounts}
			<button
				bind:this={accountTriggerButton}
				type="button"
				class="flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-8 text-xs rounded-lg transition-all duration-150
					bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
					text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
					disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
				onclick={toggleAccountDropdown}
				disabled={appState.isLoading || accountSwitching}
				aria-haspopup="listbox"
				aria-expanded={showAccountDropdown}
				aria-busy={accountSwitching}
			>
				{#if accountSwitching}
					<div class="w-3.5 h-3.5 border-2 border-slate-300 border-t-violet-500 rounded-full animate-spin"></div>
				{:else}
					<Icon name="lucide:user" class="w-3.5 h-3.5" />
				{/if}
				<span class="font-medium max-w-24 truncate">{currentAccount?.name || 'Account'}</span>
				<Icon name="lucide:chevron-down" class="w-3 h-3" />
			</button>
		{:else if isAdmin}
			<button
				type="button"
				class="flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-8 text-xs rounded-lg transition-colors
					bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40
					border border-amber-200 dark:border-amber-700/50 cursor-pointer"
				onclick={connectAccount}
				title="Connect an account in Settings → Engines"
			>
				<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 flex-shrink-0" />
				<span class="font-medium">No accounts connected</span>
				<span class="underline underline-offset-2">Connect</span>
			</button>
		{:else}
			<div class="flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-8 text-xs rounded-lg
				bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400
				border border-amber-200 dark:border-amber-700/50">
				<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 flex-shrink-0" />
				<span class="font-medium">No accounts connected</span>
			</div>
		{/if}
	{/if}

	<!-- OpenCode account picker (shown for non-free OpenCode providers) -->
	{#if showOCAccountPicker}
		<button
			bind:this={ocAccountTriggerButton}
			type="button"
			class="flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-8 text-xs rounded-lg transition-all duration-150
				bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
				text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
				disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
			onclick={toggleOCAccountDropdown}
			disabled={appState.isLoading || accountSwitching}
			aria-haspopup="listbox"
			aria-expanded={showOCAccountDropdown}
			aria-busy={accountSwitching}
		>
			{#if accountSwitching}
				<div class="w-3.5 h-3.5 border-2 border-slate-300 border-t-violet-500 rounded-full animate-spin"></div>
			{:else}
				<Icon name="lucide:key" class="w-3.5 h-3.5" />
			{/if}
			<span class="font-medium max-w-24 truncate">{currentOCAccount?.name || 'Account'}</span>
			<Icon name="lucide:chevron-down" class="w-3 h-3" />
		</button>
	{/if}

	<!-- Reasoning / thinking level (only when the selected model exposes one).
	     While the model is still resolving, the restored level stays visible
	     (disabled) so the row doesn't jump. -->
	{#if (currentReasoningControl && currentReasoningControl.levels.length > 0) || reasoningPending}
		<button
			bind:this={reasoningTriggerButton}
			type="button"
			class="flex items-center gap-1.5 px-2 py-1 pointer-coarse:min-h-8 text-xs rounded-lg transition-all duration-150
				bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
				text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
				disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
			onclick={toggleReasoningDropdown}
			disabled={appState.isLoading || !currentReasoningControl}
			title="Reasoning effort"
			aria-haspopup="listbox"
			aria-expanded={showReasoningDropdown}
		>
			<Icon name="lucide:gauge" class="w-3.5 h-3.5" />
			<span class="font-medium max-w-24 truncate">{currentReasoningLabel || 'Reasoning'}</span>
			<Icon name="lucide:chevron-down" class="w-3 h-3" />
		</button>
	{/if}

	<!-- Active-profile picker (per-session; only shown when profiles exist) -->
	<ProfilePicker />
</div>

<!-- Account dropdown (Claude Code + Copilot) -->
{#if showAccountDropdown}
	<div class="fixed inset-0" style="z-index: 9998;" onclick={closeAccountDropdown}></div>

	<div
		use:anchoredPopover={{ anchor: accountTriggerButton, onClose: closeAccountDropdown, maxHeight: 256 }}
		style="position: fixed; z-index: 9999;"
		class="origin-bottom-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-48 max-w-[calc(100vw-1rem)] flex flex-col"
		transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
	>
		<div class="flex gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<Icon name="lucide:user" class="w-3.5 h-3.5" />
			<span class="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide">{accountPickerLabel}</span>
		</div>
		{#if accountsForEngine.length > 5}
			<div class="px-2 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
				<div class="relative">
					<Icon name="lucide:search" class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
					<input
						type="text"
						bind:value={accountSearchQuery}
						placeholder="Search accounts..."
						class="w-full pl-6 pr-2 py-1 text-xs bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-md outline-none focus:ring-1 focus:ring-violet-500/40 focus:border-violet-500 transition-colors text-slate-800 dark:text-slate-200 placeholder-slate-400"
					/>
				</div>
			</div>
		{/if}
		<div class="overflow-y-auto py-1" role="listbox" aria-label={accountPickerLabel}>
			{#each filteredAccounts as account (account.id)}
				{@const isSelected = chatModelState.accountId === account.id}
				<button
					type="button"
					role="option"
					aria-selected={isSelected}
					data-popover-item
					class="flex items-center gap-2.5 w-full px-3 py-2 text-left transition-all duration-150 focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700
						{isSelected
							? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400'
							: 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
					onclick={() => selectAccount(account)}
				>
					<!-- Radio indicator -->
					<div class="flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center
						{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
						{#if isSelected}
							<div class="w-1.5 h-1.5 rounded-full bg-violet-600"></div>
						{/if}
					</div>

					<div class="flex items-center gap-2 min-w-0 flex-1">
						<span class="font-medium text-xs truncate">{account.name}</span>
					</div>
				</button>
			{/each}
		</div>
	</div>
{/if}

<!-- OpenCode Account dropdown -->
{#if showOCAccountDropdown && ocMatchingProvider}
	<div class="fixed inset-0" style="z-index: 9998;" onclick={closeOCAccountDropdown}></div>

	<div
		use:anchoredPopover={{ anchor: ocAccountTriggerButton, onClose: closeOCAccountDropdown, maxHeight: 256 }}
		style="position: fixed; z-index: 9999;"
		class="origin-bottom-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-48 max-w-[calc(100vw-1rem)] flex flex-col"
		transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
	>
		<div class="flex gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<Icon name="lucide:key" class="w-3.5 h-3.5" />
			<span class="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide">{ocMatchingProvider.name} Account</span>
		</div>
		<div class="overflow-y-auto py-1" role="listbox" aria-label="{ocMatchingProvider.name} Account">
			{#each ocMatchingProvider.accounts as account (account.id)}
				{@const isSelected = account.isActive}
				<button
					type="button"
					role="option"
					aria-selected={isSelected}
					data-popover-item
					class="flex items-center gap-2.5 w-full px-3 py-2 text-left transition-all duration-150 focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700
						{isSelected
							? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400'
							: 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
					onclick={() => selectOCAccount(account)}
				>
					<!-- Radio indicator -->
					<div class="flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center
						{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
						{#if isSelected}
							<div class="w-1.5 h-1.5 rounded-full bg-violet-600"></div>
						{/if}
					</div>

					<div class="flex items-center gap-2 min-w-0 flex-1">
						<span class="font-medium text-xs truncate">{account.name}</span>
					</div>
				</button>
			{/each}
		</div>
	</div>
{/if}

<!-- Reasoning-level dropdown -->
{#if showReasoningDropdown && currentReasoningControl}
	<div class="fixed inset-0" style="z-index: 9998;" onclick={closeReasoningDropdown}></div>

	<div
		use:anchoredPopover={{ anchor: reasoningTriggerButton, onClose: closeReasoningDropdown, maxHeight: 256 }}
		style="position: fixed; z-index: 9999;"
		class="origin-bottom-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-40 max-w-[calc(100vw-1rem)] flex flex-col"
		transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
	>
		<div class="flex gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<Icon name="lucide:gauge" class="w-3.5 h-3.5" />
			<span class="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide">Reasoning effort</span>
		</div>
		<div class="overflow-y-auto py-1" role="listbox" aria-label="Reasoning effort">
			{#each currentReasoningControl.levels as level (level.value)}
				{@const isSelected = currentReasoningValue === level.value}
				<button
					type="button"
					role="option"
					aria-selected={isSelected}
					data-popover-item
					class="flex items-center gap-2.5 w-full px-3 py-2 text-left transition-all duration-150 focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700
						{isSelected
							? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400'
							: 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
					onclick={() => selectReasoning(level.value)}
				>
					<div class="flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center
						{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
						{#if isSelected}
							<div class="w-1.5 h-1.5 rounded-full bg-violet-600"></div>
						{/if}
					</div>
					<span class="font-medium text-xs truncate">{level.label}</span>
				</button>
			{/each}
		</div>
	</div>
{/if}

<!-- Model dropdown rendered as fixed portal to escape overflow-hidden parent -->
{#if showDropdown}
	<div class="fixed inset-0" style="z-index: 9998;" onclick={closeDropdown}></div>

	<div
		use:anchoredPopover={{ anchor: triggerButton, onClose: closeDropdown, maxHeight: 384 }}
		style="position: fixed; z-index: 9999;"
		class="origin-bottom-left bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden w-80 max-w-[calc(100vw-1rem)] flex flex-col"
		transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
	>

		<!-- Engine tabs -->
		<div class="flex border-b border-slate-200 dark:border-slate-700 flex-shrink-0 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Engines">
			{#each ENGINES as engine (engine.type)}
				{@const isActive = chatModelState.engine === engine.type}
				<button
					type="button"
					role="tab"
					aria-selected={isActive}
					class="flex items-center justify-center gap-1.5 px-2 py-2 pointer-coarse:px-3 text-xs font-medium transition-all duration-150 whitespace-nowrap
						{isActive ? 'flex-1' : 'flex-shrink-0'}
						{isActive
							? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 border-b-2 border-violet-600'
							: 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
					onclick={() => selectEngine(engine.type)}
					title={engine.name}
				>
					<div class="flex dark:hidden items-center justify-center w-3.5 h-3.5 flex-shrink-0 [&>svg]:w-full [&>svg]:h-full">{@html engine.icon.light}</div>
					<div class="hidden dark:flex items-center justify-center w-3.5 h-3.5 flex-shrink-0 [&>svg]:w-full [&>svg]:h-full">{@html engine.icon.dark}</div>
					{#if isActive}
						<span class="truncate max-w-28">{engine.name}</span>
					{/if}
				</button>
			{/each}
		</div>

		<!-- Search -->
		<div class="px-2 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<div class="relative">
				<Icon name="lucide:search" class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search models..."
					class="w-full pl-6 pr-2 py-1 text-xs bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-md outline-none focus:ring-1 focus:ring-violet-500/40 focus:border-violet-500 transition-colors text-slate-800 dark:text-slate-200 placeholder-slate-400"
				/>
			</div>
		</div>

		<!-- Model list -->
		<div class="overflow-y-auto py-1">
			{#if engineModelsLoading}
				<div class="flex items-center justify-center gap-2 py-5 text-xs text-slate-400">
					<div class="w-3.5 h-3.5 border-2 border-slate-300 border-t-violet-500 rounded-full animate-spin"></div>
					<span>Loading models...</span>
				</div>
			{:else if filteredModels.length === 0}
				{#if searchQuery}
					<div class="px-3 py-4 text-xs text-slate-500 text-center">
						No models matching your search.
					</div>
				{:else if engineError}
					<div class="m-2 flex items-start gap-2.5 p-3 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
						<Icon name="lucide:triangle-alert" class="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
						<div class="flex-1 min-w-0">
							<p class="text-xs text-amber-900 dark:text-amber-100">{engineError}</p>
							<div class="mt-2 flex flex-wrap items-center gap-1.5">
								<button
									type="button"
									class="inline-flex items-center gap-1.5 px-2.5 py-1 pointer-coarse:min-h-8 text-2xs font-semibold rounded-md border border-amber-600/50 text-amber-700 dark:text-amber-300 hover:bg-amber-600/10 cursor-pointer transition-colors"
									onclick={retryModels}
								>
									<Icon name="lucide:refresh-cw" class="w-3 h-3" />
									Retry
								</button>
								{#if isAdmin}
									{#if engineError.includes('Settings → Stack')}
										<button
											type="button"
											class="inline-flex items-center gap-1.5 px-2.5 py-1 pointer-coarse:min-h-8 text-2xs font-semibold rounded-md bg-amber-600 hover:bg-amber-700 text-white cursor-pointer transition-colors"
											onclick={openStack}
										>
											Open Stack
										</button>
									{:else}
										<button
											type="button"
											class="inline-flex items-center gap-1.5 px-2.5 py-1 pointer-coarse:min-h-8 text-2xs font-semibold rounded-md bg-amber-600 hover:bg-amber-700 text-white cursor-pointer transition-colors"
											onclick={() => configureEngine(chatModelState.engine)}
										>
											Configure {currentEngine?.name ?? 'engine'}
										</button>
									{/if}
								{/if}
							</div>
						</div>
					</div>
				{:else}
					<div class="px-3 py-4 text-xs text-slate-500 text-center">
						No models available.
					</div>
				{/if}
			{:else}
				{#each [...groupedModels.entries()] as [provider, providerModels] (provider)}
					{@const isCollapsed = collapsedProviders.has(provider)}
					{@const hasSelectedModel = providerModels.some(m => m.engine.model.id === chatModelState.modelId)}
					{@const sortedModels = [...providerModels].sort((a, b) => {
						const aPin = (pinnedModelIds || []).includes(a.engine.model.id) ? 0 : 1;
						const bPin = (pinnedModelIds || []).includes(b.engine.model.id) ? 0 : 1;
						return aPin - bPin;
					})}

					<!-- Provider header -->
					<button
						type="button"
						data-popover-item
						aria-expanded={!isCollapsed}
						class="flex items-center gap-2 w-full px-3 py-1.5 pointer-coarse:py-2.5 text-left transition-colors
							hover:bg-slate-50 dark:hover:bg-slate-700/50 focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700"
						onclick={() => toggleProvider(provider)}
					>
						<svg viewBox="0 0 24 24" fill="none"
							class="w-3 h-3 text-slate-400 transition-transform duration-200 flex-shrink-0
								{isCollapsed ? '' : 'rotate-90'}"
							aria-hidden="true">
							<path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
						<span class="text-2xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide truncate min-w-0">
							{formatProvider(provider)}
						</span>
						<span class="text-4xs text-slate-400 dark:text-slate-500 flex-shrink-0">
							{providerModels.length}
						</span>
						{#if hasSelectedModel}
							<div class="w-1.5 h-1.5 rounded-full bg-violet-500 ml-auto flex-shrink-0"></div>
						{/if}
					</button>

					<!-- Provider models -->
					{#if !isCollapsed}
						{#each sortedModels as model (model.engine.model.id)}
							{@const isSelected = chatModelState.modelId === model.engine.model.id}
							{@const isPinned = (pinnedModelIds || []).includes(model.engine.model.id)}
							<!-- Row = select button + sibling pin button (a button can't nest
							     another interactive element). -->
							<div class="group flex items-stretch transition-all duration-150
								{isSelected
									? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400'
									: 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}">
								<button
									type="button"
									data-popover-item
									aria-pressed={isSelected}
									class="flex items-start gap-2.5 flex-1 min-w-0 pl-5 pr-1 py-2 text-left focus-visible:outline-none focus-visible:bg-slate-100 dark:focus-visible:bg-slate-700"
									onclick={() => selectModel(model)}
								>
									<!-- Radio indicator -->
									<div class="flex-shrink-0 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center mt-0.5
										{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
										{#if isSelected}
											<div class="w-1.5 h-1.5 rounded-full bg-violet-600"></div>
										{/if}
									</div>

									<!-- Model info -->
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2 min-w-0">
											<span class="font-medium text-xs truncate">{model.engine.model.name}</span>
											{#if model.limit.input}
												<span class="text-3xs text-slate-400 dark:text-slate-500 flex-shrink-0">{formatTokens(model.limit.input)}</span>
											{/if}
											{#if isPinned}
												<Icon name="lucide:pin" class="w-3 h-3 text-amber-500 flex-shrink-0" />
											{/if}
										</div>
									{#if getModelTags(model).length > 0}
										<div class="flex flex-wrap gap-1 mt-0.5">
											{#each getModelTags(model) as tag}
												<span class="px-1 py-px text-4xs font-medium rounded bg-slate-100 dark:bg-slate-700/60 text-slate-500 dark:text-slate-400">{tag}</span>
											{/each}
										</div>
									{/if}
									</div>
								</button>
								<!-- Pin toggle — always visible on touch (no hover there), with a
								     full-size tap target separate from the row. -->
								<button
									type="button"
									class="flex-shrink-0 self-center flex items-center justify-center w-6 h-6 pointer-coarse:w-9 pointer-coarse:h-9 mr-2 rounded text-slate-400 hover:text-amber-500 hover:bg-amber-500/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
									onclick={() => togglePinnedModel(model.engine.model.id)}
									title={isPinned ? 'Unpin model' : 'Pin model'}
									aria-label={isPinned ? `Unpin ${model.engine.model.name}` : `Pin ${model.engine.model.name}`}
								>
									<Icon name={isPinned ? 'lucide:pin-off' : 'lucide:pin'} class="w-3.5 h-3.5" />
								</button>
							</div>
						{/each}
					{/if}
				{/each}
			{/if}
		</div>
	</div>
{/if}

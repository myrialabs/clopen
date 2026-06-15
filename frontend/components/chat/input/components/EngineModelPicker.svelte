<script lang="ts">
	import { untrack } from 'svelte';
	import { settings, togglePinnedModel } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { userStore } from '$frontend/stores/features/user.svelte';
	import { chatModelState, initChatModel, restoreChatModelFromSession } from '$frontend/stores/ui/chat-model.svelte';
	import { ENGINES, getModelTags } from '$shared/constants/engines';
	import type { EngineType, EngineModel } from '$shared/types/unified';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { claudeAccountsStore, type ClaudeAccountItem } from '$frontend/stores/features/claude-accounts.svelte';
	import { copilotAccountsStore, type CopilotAccountItem } from '$frontend/stores/features/copilot-accounts.svelte';
	import { codexAccountsStore, type CodexAccountItem } from '$frontend/stores/features/codex-accounts.svelte';
	import { qwenAccountsStore, type QwenAccountItem } from '$frontend/stores/features/qwen-accounts.svelte';
	import { opencodeProvidersStore, type OpenCodeProviderItem, type OpenCodeAccountItem } from '$frontend/stores/features/opencode-providers.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import { formatProvider, formatTokens } from '$frontend/utils/format';

	// ════════════════════════════════════════════
	// Single-account-list engines: Claude Code + Copilot
	// (Both stores expose the same { accounts, fetch, refresh, set, reset } API,
	// so a single picker UI handles both — engine-specific logic only diverges
	// at the store reference resolved by `accountsForEngine`.)
	// ════════════════════════════════════════════

	type SimpleAccount = ClaudeAccountItem | CopilotAccountItem | CodexAccountItem | QwenAccountItem;

	const accountsForEngine = $derived<SimpleAccount[]>(
		chatModelState.engine === 'claude-code'
			? claudeAccountsStore.accounts
			: chatModelState.engine === 'copilot'
				? copilotAccountsStore.accounts
				: chatModelState.engine === 'codex'
					? codexAccountsStore.accounts
					: chatModelState.engine === 'qwen'
						? qwenAccountsStore.accounts
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
			: 'Claude Account'
	);

	const showAccountPicker = $derived(
		chatModelState.engine === 'claude-code'
		|| chatModelState.engine === 'copilot'
		|| chatModelState.engine === 'codex'
		|| chatModelState.engine === 'qwen'
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
		}
	});

	// Auto-select active account when no account is set and accounts are loaded
	$effect(() => {
		const engine = chatModelState.engine;
		const accounts = accountsForEngine;
		const currentId = chatModelState.accountId;

		if ((engine === 'claude-code' || engine === 'copilot' || engine === 'codex' || engine === 'qwen') && accounts.length > 0) {
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

	// Emit account changes to other users in the same chat session
	let lastSyncedAccountId: number | null = null;
	let ignoringRemoteAccountSync = false;

	$effect(() => {
		const accountId = chatModelState.accountId;
		const accountName = chatModelState.accountName;
		const chatSessionId = sessionState.currentSession?.id;
		const senderId = userStore.currentUser?.id;
		if (!chatSessionId || !senderId || ignoringRemoteAccountSync) return;
		if (accountId !== null && accountId !== lastSyncedAccountId) {
			lastSyncedAccountId = accountId;
			ws.emit('chat:account-sync', {
				senderId,
				chatSessionId,
				accountId,
				accountName: accountName ?? null
			});
		}
	});

	// Listen for remote account changes from other users
	$effect(() => {
		const unsub = ws.on('chat:account-sync', (data: { senderId: string; accountId: number | null; accountName: string | null }) => {
			const currentUserId = userStore.currentUser?.id;
			if (data.senderId === currentUserId) return;
			debug.log('chat', 'Remote account sync:', data);
			ignoringRemoteAccountSync = true;
			chatModelState.accountId = data.accountId;
			chatModelState.accountName = data.accountName;
			lastSyncedAccountId = data.accountId;
			ignoringRemoteAccountSync = false;

			// Also update session state so init $effect won't overwrite on re-render
			if (sessionState.currentSession) {
				sessionState.currentSession = {
					...sessionState.currentSession,
					account_id: data.accountId ?? undefined,
					account_name: data.accountName ?? undefined
				};
			}
		});
		return unsub;
	});

	// Account dropdown state
	let showAccountDropdown = $state(false);
	let accountTriggerButton = $state<HTMLButtonElement>();
	let accountDropdownStyle = $state('');

	function toggleAccountDropdown() {
		if (!showAccountDropdown && accountTriggerButton) {
			const rect = accountTriggerButton.getBoundingClientRect();
			accountDropdownStyle = `position: fixed; bottom: ${window.innerHeight - rect.top + 4}px; left: ${rect.left}px; z-index: 9999;`;
		}
		showAccountDropdown = !showAccountDropdown;
	}

	function closeAccountDropdown() {
		showAccountDropdown = false;
	}

	async function selectAccount(account: SimpleAccount) {
		chatModelState.accountId = account.id;
		chatModelState.accountName = account.name;

		// For Codex, switching the account also swaps `~/.codex/auth.json`
		// (server-side) so the next subprocess picks up the right blob. We
		// fire-and-forget — the per-stream `accountId` override would still
		// apply this if the user sends immediately after switching, but
		// touching the file early matters for the model-listing path.
		if (chatModelState.engine === 'codex') {
			try {
				await ws.http('engine:codex-accounts-switch', { id: account.id });
				await codexAccountsStore.refresh();
			} catch (err) {
				debug.warn('chat', 'Codex account switch failed:', err);
			}
		}

		// Qwen models are discovered dynamically against the active account's
		// `/models` endpoint, so promoting the chat-picked account to DB-active
		// and refreshing the model list keeps the picker in sync with the
		// preset's actual catalog.
		if (chatModelState.engine === 'qwen') {
			try {
				await ws.http('engine:qwen-accounts-switch', { id: account.id });
				await qwenAccountsStore.refresh();
				await modelStore.refreshModels('qwen');
			} catch (err) {
				debug.warn('chat', 'Qwen account switch failed:', err);
			}
		}

		closeAccountDropdown();
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
	let ocAccountDropdownStyle = $state('');

	function toggleOCAccountDropdown() {
		if (!showOCAccountDropdown && ocAccountTriggerButton) {
			const rect = ocAccountTriggerButton.getBoundingClientRect();
			ocAccountDropdownStyle = `position: fixed; bottom: ${window.innerHeight - rect.top + 4}px; left: ${rect.left}px; z-index: 9999;`;
		}
		showOCAccountDropdown = !showOCAccountDropdown;
	}

	function closeOCAccountDropdown() {
		showOCAccountDropdown = false;
	}

	let ocNeedsRestart = $state(false);
	let ocRestarting = $state(false);

	async function selectOCAccount(account: OpenCodeAccountItem) {
		await opencodeProvidersStore.switchAccount(account.id);
		chatModelState.accountId = account.id;
		chatModelState.accountName = account.name;
		ocNeedsRestart = true;
		closeOCAccountDropdown();
	}

	async function restartOCServer() {
		ocRestarting = true;
		try {
			await opencodeProvidersStore.restartServer(true);
			await modelStore.refreshModels('opencode');
			ocNeedsRestart = false;
		} catch {
			// Ignore
		} finally {
			ocRestarting = false;
		}
	}

	// ════════════════════════════════════════════
	// Model Picker (existing logic)
	// ════════════════════════════════════════════

	// Track whether a chat has started (any user message in current session, or session has history e.g. restored to initial)
	const hasStartedChat = $derived(
		sessionState.messages.some(m => m.type === 'user') || sessionState.hasMessageHistory
	);

	// Engine lock: once chat starts, the engine is locked for this session.
	const lockedEngine = $derived<EngineType | null>(
		hasStartedChat ? chatModelState.engine : null
	);

	const engineLocked = $derived(lockedEngine !== null);

	// Read from local chat model state (isolated from Settings)
	const currentEngine = $derived(ENGINES.find(e => e.type === chatModelState.engine));
	const currentModel = $derived(modelStore.getById(chatModelState.modelId));
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

	// Label shown in the trigger button
	const triggerLabel = $derived.by(() => {
		if (modelStore.loading) return 'Loading...';
		if (!currentModel) return 'No model selected';
		return currentModel.engine.model.name;
	});

	// Initialize model picker based on session state:
	// - Session with persisted engine/model: restore from session (highest priority)
	// - New session (no messages, no persisted engine/model): apply Settings defaults
	// - Legacy session without engine/model: fall back to Settings defaults
	//
	// IMPORTANT: Session engine/model is checked BEFORE hasStartedChat because
	// when switching sessions, messages load asynchronously AFTER the session is set.
	// If we checked hasStartedChat first, there's a window where messages haven't
	// loaded yet (hasStartedChat=false) → defaults would be applied, overriding the
	// session's actual engine/model selection.
	$effect(() => {
		const session = sessionState.currentSession;
		const _sessionId = session?.id;
		const started = hasStartedChat;
		const sEngine = settings.selectedEngine;
		const sProvider = settings.selectedProvider;
		const sModelId = settings.selectedModelId;
		const sModelName = settings.selectedModelName;
		const sMemory = settings.engineModelMemory;
		const sessionEngine = session?.engine;
		const sessionProvider = session?.provider;
		const sessionModelId = session?.model_id;
		const sessionModelName = session?.model_name;
		const sessionAccountId = session?.account_id;
		const sessionAccountName = session?.account_name;

		untrack(() => {
			if (sessionEngine && sessionModelId) {
				// Session has persisted engine/model: always restore from session.
				// This works for both existing sessions (has messages) and sessions
				// where messages are still loading asynchronously.
				restoreChatModelFromSession(sessionEngine, sessionProvider || sProvider, sessionModelId, sessionModelName || '', sessionAccountId, sessionAccountName);
			} else if (!started) {
				// New session (no messages, no persisted engine/model): apply Settings defaults
				initChatModel(sEngine, sProvider, sModelId, sModelName, sMemory || {});
			} else {
				// Existing session without engine/model (pre-migration or not yet set):
				// fall back to Settings defaults
				initChatModel(sEngine, sProvider, sModelId, sModelName, sMemory || {});
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
	$effect(() => {
		const engine = chatModelState.engine;
		const modelValid = currentModel?.engine.type === engine;
		const models = availableModels;
		if (!modelValid && models.length > 0) {
			untrack(() => {
				const memory = chatModelState.engineModelMemory;
				const remembered = memory[engine];
				const target =
					(remembered && models.find(m => m.engine.model.id === remembered.id)) ||
					models[0];
				if (target) {
					chatModelState.provider = target.engine.provider;
					chatModelState.modelId = target.engine.model.id;
					chatModelState.modelName = target.engine.model.name;
					chatModelState.engineModelMemory = { ...memory, [engine]: { provider: target.engine.provider, id: target.engine.model.id, name: target.engine.model.name } };
				}
			});
		}
	});

	// Emit model changes to other users in the same chat session
	let lastSyncedModelId = '';
	let lastSyncedEngine = '';
	let ignoringRemoteSync = false;

	$effect(() => {
		const engine = chatModelState.engine;
		const provider = chatModelState.provider;
		const modelId = chatModelState.modelId;
		const modelName = chatModelState.modelName;
		const chatSessionId = sessionState.currentSession?.id;
		const senderId = userStore.currentUser?.id;
		if (!chatSessionId || !senderId || ignoringRemoteSync) return;
		// Only emit if model actually changed (not on init)
		if (modelId && (modelId !== lastSyncedModelId || engine !== lastSyncedEngine)) {
			lastSyncedModelId = modelId;
			lastSyncedEngine = engine;
			ws.emit('chat:model-sync', {
				senderId,
				chatSessionId,
				engine,
				provider,
				modelId,
				modelName
			});
		}
	});

	// Listen for remote model changes from other users
	$effect(() => {
		const unsub = ws.on('chat:model-sync', (data: { senderId: string; engine: string; provider: string; modelId: string; modelName: string }) => {
			const currentUserId = userStore.currentUser?.id;
			if (data.senderId === currentUserId) return; // Ignore own events
			debug.log('chat', 'Remote model sync:', data);
			ignoringRemoteSync = true;
			chatModelState.engine = data.engine as EngineType;
			chatModelState.provider = data.provider;
			chatModelState.modelId = data.modelId;
			chatModelState.modelName = data.modelName;
			lastSyncedModelId = data.modelId;
			lastSyncedEngine = data.engine;
			ignoringRemoteSync = false;

			// Also update session state so init $effect won't overwrite on re-render
			if (sessionState.currentSession) {
				sessionState.currentSession = {
					...sessionState.currentSession,
					engine: data.engine as EngineType,
					provider: data.provider,
					model_id: data.modelId,
					model_name: data.modelName
				};
			}
		});
		return unsub;
	});

	// Search state
	let searchQuery = $state('');
	let collapsedProviders = $state<Set<string>>(new Set());

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
	let triggerButton: HTMLButtonElement;
	let dropdownStyle = $state('');

	function toggleDropdown() {
		if (!showDropdown && triggerButton) {
			const rect = triggerButton.getBoundingClientRect();
			dropdownStyle = `position: fixed; bottom: ${window.innerHeight - rect.top + 4}px; left: ${rect.left}px; z-index: 9999;`;
		}
		showDropdown = !showDropdown;
		if (!showDropdown) searchQuery = '';
	}

	function closeDropdown() {
		showDropdown = false;
		searchQuery = '';
	}

	async function selectEngine(engineType: EngineType) {
		if (engineLocked) return;

		// Switch engine immediately so the active tab updates before model fetch
		chatModelState.engine = engineType;
		searchQuery = '';

		// Clear model immediately so it shows null during loading, then fetch
		chatModelState.modelId = '';
		chatModelState.modelName = '';
		await modelStore.fetchModels(engineType);

		// After models are loaded, pick a model for this engine
		const memory = chatModelState.engineModelMemory;
		const remembered = memory[engineType];
		const models = modelStore.getByEngine(engineType);
		const target =
			(remembered && models.find(m => m.engine.model.id === remembered.id)) ||
			models[0];

		if (target) {
			chatModelState.provider = target.engine.provider;
			chatModelState.modelId = target.engine.model.id;
			chatModelState.modelName = target.engine.model.name;
			chatModelState.engineModelMemory = { ...memory, [engineType]: { provider: target.engine.provider, id: target.engine.model.id, name: target.engine.model.name } };
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
		closeDropdown();
	}

</script>

<div class="flex items-center gap-1.5 px-4 pt-2 pb-0.5">
	<button
		bind:this={triggerButton}
		type="button"
		class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-all duration-150
			bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
			text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
			disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
		onclick={toggleDropdown}
		disabled={appState.isLoading}
	>
		{#if currentEngine}
			<div class="flex dark:hidden items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html currentEngine.icon.light}</div>
			<div class="hidden dark:flex items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html currentEngine.icon.dark}</div>
		{/if}
		<span class="font-medium">{triggerLabel}</span>
		<Icon name="lucide:chevron-down" class="w-3 h-3" />
	</button>

	<!-- Account picker (Claude Code + Copilot — both use one-account-per-engine) -->
	{#if showAccountPicker}
		{#if hasEngineAccounts}
			<button
				bind:this={accountTriggerButton}
				type="button"
				class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-all duration-150
					bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
					text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
					disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
				onclick={toggleAccountDropdown}
				disabled={appState.isLoading}
			>
				<Icon name="lucide:user" class="w-3.5 h-3.5" />
				<span class="font-medium max-w-24 truncate">{currentAccount?.name || 'Account'}</span>
				<Icon name="lucide:chevron-down" class="w-3 h-3" />
			</button>
		{:else}
			<div class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg
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
			class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-all duration-150
				bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
				text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700
				disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-100 dark:disabled:hover:bg-slate-800"
			onclick={toggleOCAccountDropdown}
			disabled={appState.isLoading}
		>
			<Icon name="lucide:key" class="w-3.5 h-3.5" />
			<span class="font-medium max-w-24 truncate">{currentOCAccount?.name || 'Account'}</span>
			<Icon name="lucide:chevron-down" class="w-3 h-3" />
		</button>
	{/if}

	<!-- OpenCode restart notification after account switch -->
	{#if ocNeedsRestart}
		<button
			type="button"
			class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-all duration-150
				bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400
				border border-amber-200 dark:border-amber-700/50
				hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
			onclick={restartOCServer}
			disabled={ocRestarting}
		>
			<Icon name={ocRestarting ? 'lucide:loader' : 'lucide:rotate-cw'} class="w-3.5 h-3.5 {ocRestarting ? 'animate-spin' : ''}" />
			<span class="font-medium">{ocRestarting ? 'Restarting...' : 'Restart Server'}</span>
		</button>
	{/if}
</div>

<!-- Account dropdown (Claude Code + Copilot) -->
{#if showAccountDropdown}
	<div class="fixed inset-0" style="z-index: 9998;" onclick={closeAccountDropdown}></div>

	<div style={accountDropdownStyle} class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-48 max-h-64 flex flex-col">
		<div class="flex gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<Icon name="lucide:user" class="w-3.5 h-3.5" />
			<span class="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide">{accountPickerLabel}</span>
		</div>
		<div class="overflow-y-auto py-1">
			{#each accountsForEngine as account (account.id)}
				{@const isSelected = chatModelState.accountId === account.id}
				<button
					type="button"
					class="flex items-center gap-2.5 w-full px-3 py-2 text-left transition-all duration-150
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

	<div style={ocAccountDropdownStyle} class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-48 max-h-64 flex flex-col">
		<div class="flex gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<Icon name="lucide:key" class="w-3.5 h-3.5" />
			<span class="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide">{ocMatchingProvider.name} Account</span>
		</div>
		<div class="overflow-y-auto py-1">
			{#each ocMatchingProvider.accounts as account (account.id)}
				{@const isSelected = account.isActive}
				<button
					type="button"
					class="flex items-center gap-2.5 w-full px-3 py-2 text-left transition-all duration-150
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

<!-- Model dropdown rendered as fixed portal to escape overflow-hidden parent -->
{#if showDropdown}
	<div class="fixed inset-0" style="z-index: 9998;" onclick={closeDropdown}></div>

	<div style={dropdownStyle} class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-64 max-h-96 flex flex-col">

		<!-- Engine tabs -->
		<div class="flex border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			{#each ENGINES as engine (engine.type)}
				{@const isActive = chatModelState.engine === engine.type}
				{@const isDisabled = engineLocked && engine.type !== lockedEngine}
				<button
					type="button"
					class="flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-all duration-150 whitespace-nowrap
						{isActive ? 'flex-1' : 'flex-shrink-0'}
						{isActive
							? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 border-b-2 border-violet-600'
							: isDisabled
								? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
								: 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
					onclick={() => !isDisabled && selectEngine(engine.type)}
					disabled={isDisabled}
					title={engine.name}
				>
					<div class="flex dark:hidden items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html engine.icon.light}</div>
					<div class="hidden dark:flex items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html engine.icon.dark}</div>
					{#if isActive}
						<span>{engine.name}</span>
					{/if}
					{#if isDisabled}
						<Icon name="lucide:lock" class="w-3 h-3" />
					{/if}
				</button>
			{/each}
		</div>

		<!-- Engine locked notice -->
		{#if engineLocked}
			<div class="px-3 py-1.5 bg-amber-50 dark:bg-amber-900/10 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
				<div class="flex items-center gap-1.5 text-3xs text-amber-600 dark:text-amber-400">
					<Icon name="lucide:info" class="w-3 h-3 flex-shrink-0" />
					<span>Engine is locked for this session. You can still switch models.</span>
				</div>
			</div>
		{/if}

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
			{#if modelStore.loading}
				<div class="flex items-center justify-center gap-2 py-5 text-xs text-slate-400">
					<div class="w-3.5 h-3.5 border-2 border-slate-300 border-t-violet-500 rounded-full animate-spin"></div>
					<span>Loading models...</span>
				</div>
			{:else if filteredModels.length === 0}
				<div class="px-3 py-4 text-xs text-slate-500 text-center">
					{searchQuery ? 'No models matching your search.' : 'No models available.'}
				</div>
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
						class="flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors
							hover:bg-slate-50 dark:hover:bg-slate-700/50"
						onclick={() => toggleProvider(provider)}
					>
						<svg viewBox="0 0 24 24" fill="none"
							class="w-3 h-3 text-slate-400 transition-transform duration-200 flex-shrink-0
								{isCollapsed ? '' : 'rotate-90'}"
							aria-hidden="true">
							<path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
						<span class="text-2xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
							{formatProvider(provider)}
						</span>
						<span class="text-4xs text-slate-400 dark:text-slate-500">
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
							<button
								type="button"
								class="group flex items-start gap-2.5 w-full pl-5 pr-3 py-2 text-left transition-all duration-150
									{isSelected
										? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400'
										: 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
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
									<div class="flex items-center gap-2">
										<span class="font-medium text-xs">{model.engine.model.name}</span>
										{#if model.limit.input}
											<span class="text-3xs text-slate-400 dark:text-slate-500">{formatTokens(model.limit.input)}</span>
										{/if}
										{#if (pinnedModelIds || []).includes(model.engine.model.id)}
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
								<!-- Pin toggle -->
								<span role="button" tabindex="0"
									class="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-amber-500 hover:bg-amber-500/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
									onclick={(e) => { e.stopPropagation(); togglePinnedModel(model.engine.model.id); }}
									onkeydown={(e) => e.key === 'Enter' && togglePinnedModel(model.engine.model.id)}
									title={(pinnedModelIds || []).includes(model.engine.model.id) ? 'Unpin model' : 'Pin model'}>
									<Icon name={(pinnedModelIds || []).includes(model.engine.model.id) ? 'lucide:pin-off' : 'lucide:pin'} class="w-3.5 h-3.5" />
								</span>
							</button>
						{/each}
					{/if}
				{/each}
			{/if}
		</div>
	</div>
{/if}

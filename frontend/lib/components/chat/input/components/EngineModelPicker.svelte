<script lang="ts">
	import { untrack } from 'svelte';
	import { settings } from '$frontend/lib/stores/features/settings.svelte';
	import { modelStore } from '$frontend/lib/stores/features/models.svelte';
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import { userStore } from '$frontend/lib/stores/features/user.svelte';
	import { chatModelState, initChatModel, restoreChatModelFromSession } from '$frontend/lib/stores/ui/chat-model.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType, EngineModel } from '$shared/types/engine';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { claudeAccountsStore, type ClaudeAccountItem } from '$frontend/lib/stores/features/claude-accounts.svelte';
	import ws from '$frontend/lib/utils/ws';
	import { debug } from '$shared/utils/logger';

	// ════════════════════════════════════════════
	// Claude Accounts (reads from shared store)
	// ════════════════════════════════════════════

	const claudeAccounts = $derived(claudeAccountsStore.accounts);

	const currentAccount = $derived(
		claudeAccounts.find(a => a.id === chatModelState.claudeAccountId) || null
	);

	const showAccountPicker = $derived(chatModelState.engine === 'claude-code');
	const hasClaudeAccounts = $derived(claudeAccounts.length > 0);

	// Fetch accounts when engine switches to claude-code
	$effect(() => {
		const engine = chatModelState.engine;
		if (engine === 'claude-code') {
			claudeAccountsStore.fetch();
		}
	});

	// Auto-select active account when no account is set and accounts are loaded
	$effect(() => {
		const engine = chatModelState.engine;
		const accounts = claudeAccounts;
		const currentId = chatModelState.claudeAccountId;

		if (engine === 'claude-code' && accounts.length > 0) {
			untrack(() => {
				// If no account set, or current account not found in list, use active account
				const hasValidAccount = currentId !== null && accounts.some(a => a.id === currentId);
				if (!hasValidAccount) {
					const activeAccount = accounts.find(a => a.isActive);
					if (activeAccount) {
						chatModelState.claudeAccountId = activeAccount.id;
					}
				}
			});
		}
	});

	// Emit account changes to other users in the same chat session
	let lastSyncedAccountId: number | null = null;
	let ignoringRemoteAccountSync = false;

	$effect(() => {
		const accountId = chatModelState.claudeAccountId;
		const engine = chatModelState.engine;
		const chatSessionId = sessionState.currentSession?.id;
		const senderId = userStore.currentUser?.id;
		if (!chatSessionId || !senderId || ignoringRemoteAccountSync || engine !== 'claude-code') return;
		if (accountId !== null && accountId !== lastSyncedAccountId) {
			lastSyncedAccountId = accountId;
			ws.emit('chat:account-sync', {
				senderId,
				chatSessionId,
				claudeAccountId: accountId
			});
		}
	});

	// Listen for remote account changes from other users
	$effect(() => {
		const unsub = ws.on('chat:account-sync', (data: { senderId: string; claudeAccountId: number | null }) => {
			const currentUserId = userStore.currentUser?.id;
			if (data.senderId === currentUserId) return;
			debug.log('chat', 'Remote account sync:', data);
			ignoringRemoteAccountSync = true;
			chatModelState.claudeAccountId = data.claudeAccountId;
			lastSyncedAccountId = data.claudeAccountId;
			ignoringRemoteAccountSync = false;

			// Also update session state so init $effect won't overwrite on re-render
			if (sessionState.currentSession) {
				sessionState.currentSession = {
					...sessionState.currentSession,
					claude_account_id: data.claudeAccountId ?? undefined
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

	function selectAccount(account: ClaudeAccountItem) {
		chatModelState.claudeAccountId = account.id;
		closeAccountDropdown();
	}

	// ════════════════════════════════════════════
	// Model Picker (existing logic)
	// ════════════════════════════════════════════

	// Track whether a chat has started (any user message in current session)
	const hasStartedChat = $derived(
		sessionState.messages.some(m => m.type === 'user')
	);

	// Engine lock: once chat starts, the engine is locked for this session.
	const lockedEngine = $derived<EngineType | null>(
		hasStartedChat ? chatModelState.engine : null
	);

	const engineLocked = $derived(lockedEngine !== null);

	// Read from local chat model state (isolated from Settings)
	const currentEngine = $derived(ENGINES.find(e => e.type === chatModelState.engine));
	const currentModel = $derived(modelStore.getById(chatModelState.model));
	const availableModels = $derived(modelStore.getByEngine(chatModelState.engine));

	// Label shown in the trigger button
	const triggerLabel = $derived.by(() => {
		if (chatModelState.engine !== 'claude-code' && modelStore.loading) return 'Loading...';
		if (!currentModel) return 'No model selected';
		return currentModel.name;
	});

	// Initialize model picker based on session state:
	// - New session (no messages): apply Settings defaults
	// - Existing session (has messages): restore from session's persisted engine/model
	// Reads are done outside untrack (tracked), writes inside untrack (not tracked)
	// to prevent UpdatedAtError from circular chatModelState read-write.
	$effect(() => {
		const session = sessionState.currentSession;
		const _sessionId = session?.id;
		const started = hasStartedChat;
		const sEngine = settings.selectedEngine;
		const sModel = settings.selectedModel;
		const sMemory = settings.engineModelMemory;
		const sessionEngine = session?.engine;
		const sessionModel = session?.model;
		const sessionAccountId = session?.claude_account_id;

		untrack(() => {
			if (!started) {
				// New session (no messages): apply Settings defaults
				initChatModel(sEngine, sModel, sMemory || {});
			} else if (sessionEngine && sessionModel) {
				// Existing session with persisted engine/model: restore
				restoreChatModelFromSession(sessionEngine, sessionModel, sessionAccountId);
			} else {
				// Existing session without engine/model (pre-migration or not yet set):
				// fall back to Settings defaults
				initChatModel(sEngine, sModel, sMemory || {});
			}
		});
	});

	// Pre-load models for the current engine whenever it changes.
	// Ensures models are ready without waiting for the user to open the dropdown.
	$effect(() => {
		const engine = chatModelState.engine;
		if (engine !== 'claude-code') {
			modelStore.fetchModels(engine);
		}
	});

	// Auto-select a model if no valid model is set for the current engine.
	// Reads (engine, currentModel, availableModels) are tracked; writes use untrack
	// to prevent circular chatModelState read-write (UpdatedAtError).
	$effect(() => {
		const engine = chatModelState.engine;
		const modelValid = currentModel?.engine === engine;
		const models = availableModels;
		if (!modelValid && models.length > 0) {
			untrack(() => {
				const memory = chatModelState.engineModelMemory;
				const remembered = memory[engine];
				const target =
					(remembered && models.find(m => m.id === remembered)) ||
					models.find(m => m.recommended) ||
					models[0];
				if (target) {
					chatModelState.model = target.id;
					chatModelState.engineModelMemory = { ...memory, [engine]: target.id };
				}
			});
		}
	});

	// Emit model changes to other users in the same chat session
	let lastSyncedModel = '';
	let lastSyncedEngine = '';
	let ignoringRemoteSync = false;

	$effect(() => {
		const engine = chatModelState.engine;
		const model = chatModelState.model;
		const chatSessionId = sessionState.currentSession?.id;
		const senderId = userStore.currentUser?.id;
		if (!chatSessionId || !senderId || ignoringRemoteSync) return;
		// Only emit if model actually changed (not on init)
		if (model && (model !== lastSyncedModel || engine !== lastSyncedEngine)) {
			lastSyncedModel = model;
			lastSyncedEngine = engine;
			ws.emit('chat:model-sync', {
				senderId,
				chatSessionId,
				engine,
				model
			});
		}
	});

	// Listen for remote model changes from other users
	$effect(() => {
		const unsub = ws.on('chat:model-sync', (data: { senderId: string; engine: string; model: string }) => {
			const currentUserId = userStore.currentUser?.id;
			if (data.senderId === currentUserId) return; // Ignore own events
			debug.log('chat', 'Remote model sync:', data);
			ignoringRemoteSync = true;
			chatModelState.engine = data.engine as EngineType;
			chatModelState.model = data.model;
			lastSyncedModel = data.model;
			lastSyncedEngine = data.engine;
			ignoringRemoteSync = false;

			// Also update session state so init $effect won't overwrite on re-render
			if (sessionState.currentSession) {
				sessionState.currentSession = {
					...sessionState.currentSession,
					engine: data.engine as EngineType,
					model: data.model
				};
			}
		});
		return unsub;
	});

	// Search state
	let searchQuery = $state('');
	let refreshing = $state(false);
	let collapsedProviders = $state<Set<string>>(new Set());

	const filteredModels = $derived.by(() => {
		if (!searchQuery.trim()) return availableModels;
		const q = searchQuery.toLowerCase();
		return availableModels.filter(m =>
			m.name.toLowerCase().includes(q) ||
			m.modelId.toLowerCase().includes(q) ||
			m.provider.toLowerCase().includes(q) ||
			m.capabilities.some(c => c.toLowerCase().includes(q))
		);
	});

	// Group models by provider
	const groupedModels = $derived.by(() => {
		const groups = new Map<string, EngineModel[]>();
		for (const model of filteredModels) {
			const key = model.provider;
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
				if (models.some(m => m.id === chatModelState.model)) {
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

	function formatProvider(provider: string): string {
		return provider
			.split(/[-_]/)
			.map(w => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ');
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

		// Fetch models if needed; clear model immediately so it shows null during loading
		if (engineType !== 'claude-code') {
			chatModelState.model = '';
			await modelStore.fetchModels(engineType);
		}

		// After models are loaded, pick a model for this engine
		const memory = chatModelState.engineModelMemory;
		const remembered = memory[engineType];
		const models = modelStore.getByEngine(engineType);
		const target =
			(remembered && models.find(m => m.id === remembered)) ||
			models.find(m => m.recommended) ||
			models[0];

		if (target) {
			chatModelState.model = target.id;
			chatModelState.engineModelMemory = { ...memory, [engineType]: target.id };
		}
	}

	function selectModel(model: EngineModel) {
		chatModelState.model = model.id;
		chatModelState.engineModelMemory = {
			...chatModelState.engineModelMemory,
			[chatModelState.engine]: model.id
		};
		closeDropdown();
	}

	async function handleRefresh() {
		refreshing = true;
		try {
			await modelStore.refreshModels(chatModelState.engine);
		} finally {
			refreshing = false;
		}
	}
</script>

<div class="flex items-center gap-1.5 px-4 pt-2 pb-0.5 -mb-2">
	<button
		bind:this={triggerButton}
		type="button"
		class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-all duration-150
			bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
			text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700"
		onclick={toggleDropdown}
	>
		{#if currentEngine}
			<div class="flex dark:hidden items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html currentEngine.icon.light}</div>
			<div class="hidden dark:flex items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html currentEngine.icon.dark}</div>
		{/if}
		<span class="font-medium">{triggerLabel}</span>
		<Icon name="lucide:chevron-down" class="w-3 h-3" />
	</button>

	<!-- Account picker (always shown for Claude Code engine) -->
	{#if showAccountPicker}
		{#if hasClaudeAccounts}
			<button
				bind:this={accountTriggerButton}
				type="button"
				class="flex items-center gap-1.5 px-2 py-1 text-xs rounded-lg transition-all duration-150
					bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700
					text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700"
				onclick={toggleAccountDropdown}
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
</div>

<!-- Account dropdown -->
{#if showAccountDropdown}
	<div class="fixed inset-0" style="z-index: 9998;" onclick={closeAccountDropdown}></div>

	<div style={accountDropdownStyle} class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-48 max-h-64 flex flex-col">
		<div class="flex gap-1.5 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<Icon name="lucide:user" class="w-3.5 h-3.5" />
			<span class="text-xs font-medium text-slate-500 dark:text-slate-400 tracking-wide">Claude Account</span>
		</div>
		<div class="overflow-y-auto py-1">
			{#each claudeAccounts as account (account.id)}
				{@const isSelected = chatModelState.claudeAccountId === account.id}
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
					class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-all duration-150
						{isActive
							? 'bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 border-b-2 border-violet-600'
							: isDisabled
								? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
								: 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
					onclick={() => !isDisabled && selectEngine(engine.type)}
					disabled={isDisabled}
				>
					<div class="flex dark:hidden items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html engine.icon.light}</div>
					<div class="hidden dark:flex items-center justify-center w-3.5 h-3.5 [&>svg]:w-full [&>svg]:h-full">{@html engine.icon.dark}</div>
					{engine.name}
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

		<!-- Search + Refresh -->
		<div class="px-2 py-2 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
			<div class="flex items-center gap-1.5">
				<div class="relative flex-1">
					<Icon name="lucide:search" class="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Search models..."
						class="w-full pl-6 pr-2 py-1 text-xs bg-slate-50 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-600 rounded-md outline-none focus:ring-1 focus:ring-violet-500/40 focus:border-violet-500 transition-colors text-slate-800 dark:text-slate-200 placeholder-slate-400"
					/>
				</div>
				<button
					type="button"
					class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 dark:hover:text-violet-400 dark:hover:bg-violet-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
					onclick={handleRefresh}
					disabled={refreshing || modelStore.loading}
					title="Refresh models"
				>
					<svg viewBox="0 0 24 24" fill="none" class="w-3.5 h-3.5 {refreshing ? 'animate-spin' : ''}" aria-hidden="true">
						<path d="M21 12a9 9 0 11-2.636-6.364M21 3v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
				</button>
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
					{@const hasSelectedModel = providerModels.some(m => m.id === chatModelState.model)}

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
						{#each providerModels as model (model.id)}
							{@const isSelected = chatModelState.model === model.id}
							<button
								type="button"
								class="flex items-start gap-2.5 w-full pl-5 pr-3 py-2 text-left transition-all duration-150
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
									<div class="font-medium text-xs">{model.name}</div>
									{#if model.capabilities.length > 0}
										<div class="flex flex-wrap gap-1 mt-1">
											{#each model.capabilities as cap}
												<span class="px-1.5 py-0.5 text-3xs rounded bg-slate-100 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 leading-none">
													{cap}
												</span>
											{/each}
										</div>
									{/if}
								</div>
							</button>
						{/each}
					{/if}
				{/each}
			{/if}
		</div>
	</div>
{/if}

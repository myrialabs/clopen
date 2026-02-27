<script lang="ts">
	import { settings, updateSettings } from '$frontend/lib/stores/features/settings.svelte';
	import { modelStore } from '$frontend/lib/stores/features/models.svelte';
	import { ENGINES, type EngineType } from '$shared/constants/engines';
	import type { EngineModel } from '$shared/types/engine';

	let searchQuery = $state('');
	let refreshing = $state(false);
	let collapsedProviders = $state<Set<string>>(new Set());

	// Handle engine selection — restore remembered model or pick first
	async function selectEngine(engineType: EngineType) {
		updateSettings({ selectedEngine: engineType });
		searchQuery = '';

		// Restore remembered model for this engine
		const memory = settings.engineModelMemory || {};
		const remembered = memory[engineType];

		if (engineType !== 'claude-code') {
			const models = await modelStore.fetchModels(engineType);
			const target = (remembered && models.find(m => m.id === remembered))
				|| models.find(m => m.recommended)
				|| models[0];
			if (target) {
				updateSettings({
					selectedModel: target.id,
					engineModelMemory: { ...memory, [engineType]: target.id }
				});
			} else {
				// No models available — clear the model selection
				updateSettings({ selectedModel: '' });
			}
		} else {
			const models = modelStore.getByEngine('claude-code');
			const target = (remembered && models.find(m => m.id === remembered))
				|| models.find(m => m.recommended)
				|| models[0];
			if (target) {
				updateSettings({
					selectedModel: target.id,
					engineModelMemory: { ...memory, [engineType]: target.id }
				});
			} else {
				// No models available — clear the model selection
				updateSettings({ selectedModel: '' });
			}
		}

		// Open accordion for the selected model's provider
		syncAccordionState();
	}

	// Handle model selection — also save to per-engine memory
	function selectModel(modelId: string) {
		const memory = settings.engineModelMemory || {};
		updateSettings({
			selectedModel: modelId,
			engineModelMemory: { ...memory, [settings.selectedEngine]: modelId }
		});
	}

	// Refresh models (bypass cache)
	async function handleRefresh() {
		refreshing = true;
		try {
			await modelStore.refreshModels(settings.selectedEngine);
		} finally {
			refreshing = false;
		}
	}

	// Toggle provider accordion
	function toggleProvider(provider: string) {
		const next = new Set(collapsedProviders);
		if (next.has(provider)) {
			next.delete(provider);
		} else {
			next.add(provider);
		}
		collapsedProviders = next;
	}

	// Sync accordion state: open only the provider containing the selected model
	function syncAccordionState() {
		const allProviders = [...groupedModels.keys()];
		const selectedModel = settings.selectedModel;
		let selectedProvider: string | null = null;

		for (const [provider, models] of groupedModels) {
			if (models.some(m => m.id === selectedModel)) {
				selectedProvider = provider;
				break;
			}
		}

		// Collapse all, then open the one with selected model
		const collapsed = new Set(allProviders);
		if (selectedProvider) {
			collapsed.delete(selectedProvider);
		}
		collapsedProviders = collapsed;
	}

	// Get models for the currently selected engine, filtered by search
	const filteredModels = $derived.by(() => {
		const models = modelStore.getByEngine(settings.selectedEngine);
		if (!searchQuery.trim()) return models;

		const q = searchQuery.toLowerCase();
		return models.filter(m =>
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

	// Fetch models on mount for non-claude-code, then sync accordion
	$effect(() => {
		if (settings.selectedEngine !== 'claude-code') {
			modelStore.fetchModels(settings.selectedEngine);
		}
	});

	// Sync accordion: open all when searching, restore default when cleared
	$effect(() => {
		if (searchQuery.trim()) {
			// Searching — open all accordions
			collapsedProviders = new Set();
		} else if (groupedModels.size > 0) {
			// Not searching — only open the one with selected model
			syncAccordionState();
		}
	});

	function formatContext(tokens: number): string {
		return tokens >= 1000000
			? `${(tokens / 1000000).toFixed(1)}M`
			: `${(tokens / 1000).toFixed(0)}K`;
	}

	function formatProvider(provider: string): string {
		return provider
			.split(/[-_]/)
			.map(w => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ');
	}
</script>

<!-- Claude SVG logo (Anthropic) -->
{#snippet claudeLogo(active: boolean)}
	<svg viewBox="0 0 24 24" fill="none" class="w-5 h-5" aria-hidden="true">
		<path d="M16.091 4L9.115 20h-1.19L14.901 4h1.19zm-5.726 5.2L14.8 20h-1.218L9.2 9.6l1.165-.4z"
			fill={active ? '#8b5cf6' : 'currentColor'} />
	</svg>
{/snippet}

<!-- OpenCode SVG logo -->
{#snippet opencodeLogo(active: boolean)}
	<svg viewBox="0 0 24 24" fill="none" class="w-5 h-5" aria-hidden="true">
		<path d="M8.5 6L3 12l5.5 6M15.5 6L21 12l-5.5 6M13.5 4l-3 16"
			stroke={active ? '#8b5cf6' : 'currentColor'}
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round" />
	</svg>
{/snippet}

<div class="py-1">
	<!-- Engine Selection -->
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">AI Engine</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
		Select the AI engine to power your conversations
	</p>

	<div class="flex gap-3 mb-6">
		{#each ENGINES as engine (engine.type)}
			{@const isActive = settings.selectedEngine === engine.type}
			<button
				type="button"
				class="flex-1 flex items-center gap-3 p-3.5 overflow-hidden border-2 rounded-xl text-left cursor-pointer transition-all duration-200
					{isActive
					? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8'
					: 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20 dark:hover:border-violet-500/35'}"
				onclick={() => selectEngine(engine.type)}
			>
				<div>
					<div class="flex dark:hidden items-center justify-center w-5 h-5">{@html engine.icon.light}</div>
					<div class="hidden dark:flex items-center justify-center w-5 h-5">{@html engine.icon.dark}</div>
				</div>
				<div>
					<div class="font-bold text-sm text-slate-900 dark:text-slate-100">{engine.name}</div>
					<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{engine.description}</div>
				</div>
				{#if isActive}
					<div class="flex items-center justify-center w-5 h-5 bg-gradient-to-br from-violet-600 to-purple-600 rounded-full text-white ml-auto flex-shrink-0">
						<svg viewBox="0 0 24 24" fill="none" class="w-3 h-3" aria-hidden="true">
							<path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</div>
				{/if}
			</button>
		{/each}
	</div>

	<!-- Model Selection -->
	<div class="flex items-center justify-between mb-1.5">
		<h3 class="text-base font-bold text-slate-900 dark:text-slate-100">Model</h3>
		<button
			type="button"
			class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer
				text-slate-500 hover:text-violet-600 hover:bg-violet-500/10 dark:hover:text-violet-400 dark:hover:bg-violet-500/15
				disabled:opacity-50 disabled:cursor-not-allowed"
			onclick={handleRefresh}
			disabled={refreshing || modelStore.loading}
		>
			<svg viewBox="0 0 24 24" fill="none" class="w-3.5 h-3.5 {refreshing ? 'animate-spin' : ''}" aria-hidden="true">
				<path d="M21 12a9 9 0 11-2.636-6.364M21 3v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
			</svg>
			{refreshing ? 'Refreshing...' : 'Refresh'}
		</button>
	</div>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-3">
		Select the AI model for the {ENGINES.find(e => e.type === settings.selectedEngine)?.name || 'selected'} engine
	</p>

	<!-- Search -->
	<div class="relative mb-3">
		<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
			<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
			<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
		</svg>
		<input
			type="text"
			bind:value={searchQuery}
			placeholder="Search models..."
			class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
		/>
	</div>

	<!-- Model List -->
	<div class="flex flex-col gap-1.5">
		{#if modelStore.loading && settings.selectedEngine !== 'claude-code' && !refreshing}
			<!-- Loading skeleton for Open Code only -->
			<div class="border border-slate-200/80 dark:border-slate-700/50 rounded-lg overflow-hidden">
				<div class="bg-white/80 dark:bg-slate-800/40 px-3 py-3 flex items-center gap-3">
					<div class="w-4 h-4 rounded-full bg-slate-200 dark:bg-slate-700 animate-pulse"></div>
					<div class="h-3.5 w-32 rounded bg-slate-200 dark:bg-slate-700 animate-pulse"></div>
				</div>
				<div class="px-4 py-2.5 space-y-2.5">
					{#each Array(3) as _}
						<div class="flex items-center gap-3 py-2">
							<div class="w-4 h-4 rounded-full bg-slate-200/80 dark:bg-slate-700/60 animate-pulse"></div>
							<div class="flex-1 space-y-1.5">
								<div class="h-3.5 w-40 rounded bg-slate-200/80 dark:bg-slate-700/60 animate-pulse"></div>
								<div class="flex gap-1.5">
									<div class="h-3 w-14 rounded bg-slate-200/60 dark:bg-slate-700/40 animate-pulse"></div>
									<div class="h-3 w-12 rounded bg-slate-200/60 dark:bg-slate-700/40 animate-pulse"></div>
								</div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{:else if filteredModels.length === 0}
			<div class="py-4 text-sm text-slate-500 text-center">
				{searchQuery ? 'No models matching your search.' : 'No models available for this engine.'}
			</div>
		{:else}
			<!-- Grouped by provider with accordion -->
			{#each [...groupedModels.entries()] as [provider, providerModels] (provider)}
				{@const isCollapsed = collapsedProviders.has(provider)}
				{@const hasSelectedModel = providerModels.some(m => m.id === settings.selectedModel)}
				<div class="border border-slate-200/80 dark:border-slate-700/50 rounded-lg overflow-hidden">
					<!-- Accordion header -->
					<button
						type="button"
						class="flex items-center gap-2.5 w-full px-3 py-2.5 text-left cursor-pointer transition-colors
							bg-white/80 dark:bg-slate-800/40 hover:bg-white dark:hover:bg-slate-800/60"
						onclick={() => toggleProvider(provider)}
					>
						<svg viewBox="0 0 24 24" fill="none"
							class="w-4 h-4 text-slate-400 transition-transform duration-200 flex-shrink-0
								{isCollapsed ? '' : 'rotate-90'}"
							aria-hidden="true">
							<path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
						<span class="text-sm font-semibold text-slate-800 dark:text-slate-200">
							{formatProvider(provider)}
						</span>
						<span class="text-xs text-slate-400 dark:text-slate-500">
							{providerModels.length} {providerModels.length === 1 ? 'model' : 'models'}
						</span>
						{#if hasSelectedModel}
							<div class="w-1.5 h-1.5 rounded-full bg-violet-500 ml-auto flex-shrink-0"></div>
						{/if}
					</button>

					<!-- Accordion body -->
					{#if !isCollapsed}
						<div class="flex flex-col bg-white/40 dark:bg-slate-800/20">
							{#each providerModels as model (model.id)}
								{@const isSelected = settings.selectedModel === model.id}
								{@const caps = model.capabilities}
								<button
									type="button"
									class="flex items-start gap-3 px-3 py-2.5 text-left cursor-pointer transition-all duration-150
										{isSelected
										? 'bg-violet-500/10 dark:bg-violet-500/12'
										: 'hover:bg-slate-100/80 dark:hover:bg-slate-700/30'}"
									onclick={() => selectModel(model.id)}
								>
									<!-- Radio indicator -->
									<div class="flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5
										{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
										{#if isSelected}
											<div class="w-2 h-2 rounded-full bg-violet-600"></div>
										{/if}
									</div>

									<!-- Model info -->
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{model.name}</span>
											<!-- <span class="text-2xs text-slate-400 dark:text-slate-500">{formatContext(model.contextWindow)}</span> -->
										</div>
										{#if caps.length > 0}
											<div class="flex flex-wrap gap-1 mt-1.5">
												{#each caps as cap}
													<span class="px-1.5 py-0.5 text-2xs rounded bg-slate-100 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400 leading-none">
														{cap}
													</span>
												{/each}
											</div>
										{/if}
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</div>

<script lang="ts">
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { ENGINES, getModelTags } from '$shared/constants/engines';
	import type { EngineType, EngineModel } from '$shared/types/unified';

	interface Props {
		engine: EngineType;
		model: string;
		onEngineChange: (engine: EngineType) => void;
		onModelChange: (modelId: string) => void;
	}

	const { engine, model, onEngineChange, onModelChange }: Props = $props();

	let searchQuery = $state('');
	let collapsedProviders = $state<Set<string>>(new Set());

	// Models for the selected engine, filtered by search
	const filteredModels = $derived.by(() => {
		const models = modelStore.getByEngine(engine);
		if (!searchQuery.trim()) return models;
		const q = searchQuery.toLowerCase();
		return models.filter(m =>
			m.engine.model.name.toLowerCase().includes(q) ||
			m.engine.model.id.toLowerCase().includes(q) ||
			m.engine.provider.toLowerCase().includes(q)
		);
	});

	// Group models by provider
	const groupedModels = $derived.by(() => {
		const groups = new Map<string, EngineModel[]>();
		for (const m of filteredModels) {
			const key = m.engine.provider;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(m);
		}
		return groups;
	});

	// Fetch models when engine changes (for non-claude-code)
	$effect(() => {
		if (engine !== 'claude-code') {
			modelStore.fetchModels(engine);
		}
	});

	// Sync accordion state when search or models change
	$effect(() => {
		if (searchQuery.trim()) {
			collapsedProviders = new Set();
		} else if (groupedModels.size > 0) {
			syncAccordionState();
		}
	});

	function syncAccordionState() {
		const allProviders = [...groupedModels.keys()];
		let selectedProvider: string | null = null;
		for (const [provider, models] of groupedModels) {
			if (models.some(m => m.engine.model.id === model)) {
				selectedProvider = provider;
				break;
			}
		}
		const collapsed = new Set(allProviders);
		if (selectedProvider) collapsed.delete(selectedProvider);
		collapsedProviders = collapsed;
	}

	function toggleProvider(provider: string) {
		const next = new Set(collapsedProviders);
		if (next.has(provider)) next.delete(provider);
		else next.add(provider);
		collapsedProviders = next;
	}

	function formatProvider(provider: string): string {
		return provider.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
	}

	function formatTokenLimit(tokens: number): string {
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
		if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens % 1_000 === 0 ? 0 : 1)}K`;
		return `${tokens}`;
	}

	async function handleEngineChange(engineType: EngineType) {
		searchQuery = '';
		onEngineChange(engineType);

		if (engineType !== 'claude-code') {
			await modelStore.fetchModels(engineType);
		}

		syncAccordionState();
	}

</script>

<!-- Engine Selection -->
<div class="mb-6">
	<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Engine</label>
	<div class="flex gap-3">
		{#each ENGINES as eng (eng.type)}
			{@const isActive = engine === eng.type}
			<button
				type="button"
				class="flex-1 flex items-center gap-3 p-3.5 overflow-hidden border-2 rounded-xl text-left cursor-pointer transition-all duration-200
					{isActive
					? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8'
					: 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20 dark:hover:border-violet-500/35'}"
				onclick={() => handleEngineChange(eng.type)}
			>
				<div>
					<div class="flex dark:hidden items-center justify-center w-5 h-5">{@html eng.icon.light}</div>
					<div class="hidden dark:flex items-center justify-center w-5 h-5">{@html eng.icon.dark}</div>
				</div>
				<div>
					<div class="font-bold text-sm text-slate-900 dark:text-slate-100">{eng.name}</div>
					<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{eng.description}</div>
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
</div>

<!-- Model Selection -->
<div>
	<div class="mb-1.5">
		<label class="text-sm font-semibold text-slate-700 dark:text-slate-300">Model</label>
	</div>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-3">
		Select the model for the {ENGINES.find(e => e.type === engine)?.name || 'selected'} engine
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
		{#if modelStore.loading && engine !== 'claude-code'}
			<!-- Loading skeleton -->
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
			{#each [...groupedModels.entries()] as [provider, providerModels] (provider)}
				{@const isCollapsed = collapsedProviders.has(provider)}
				{@const hasSelectedModel = providerModels.some(m => m.engine.model.id === model)}
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
							{#each providerModels as mdl (mdl.engine.model.id)}
								{@const isSelected = model === mdl.engine.model.id}
								<button
									type="button"
									class="flex items-start gap-3 px-3 py-2.5 text-left cursor-pointer transition-all duration-150
										{isSelected
										? 'bg-violet-500/10 dark:bg-violet-500/12'
										: 'hover:bg-slate-100/80 dark:hover:bg-slate-700/30'}"
									onclick={() => onModelChange(mdl.engine.model.id)}
								>
									<div class="flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5
										{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
										{#if isSelected}
											<div class="w-2 h-2 rounded-full bg-violet-600"></div>
										{/if}
									</div>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-2">
											<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{mdl.engine.model.name}</span>
											{#if mdl.limit.input}
												<span class="text-2xs text-slate-400 dark:text-slate-500">{formatTokenLimit(mdl.limit.input)}</span>
											{/if}
										</div>
										{#if getModelTags(mdl).length > 0}
										<div class="flex flex-wrap gap-1 mt-1">
											{#each getModelTags(mdl) as tag}
												<span class="px-1.5 py-0.5 text-3xs font-medium rounded bg-slate-100 dark:bg-slate-700/60 text-slate-500 dark:text-slate-400">{tag}</span>
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

<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType, EngineModel } from '$shared/types/unified';
	import type { CommitMessageFormat } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';
	import { formatProvider } from '$frontend/utils/format';

	const formatOptions: { id: CommitMessageFormat; label: string; desc: string; icon: IconName }[] = [
		{ id: 'single-line', label: 'Single Line', desc: 'type(scope): subject', icon: 'lucide:minus' },
		{ id: 'multi-line', label: 'Multi Line', desc: 'Subject + body', icon: 'lucide:align-left' }
	];

	let searchQuery = $state('');
	let refreshing = $state(false);
	let collapsedProviders = $state<Set<string>>(new Set());

	const commitGen = $derived(settings.commitGenerator);
	const useCustomModel = $derived(commitGen.useCustomModel);

	// Resolve which model is being used for display
	const activeEngine = $derived(useCustomModel ? commitGen.engine : settings.selectedEngine);
	const activeModelId = $derived(useCustomModel ? commitGen.modelId : settings.selectedModelId);
	const activeEngineMeta = $derived(ENGINES.find(e => e.type === activeEngine));
	const activeModelMeta = $derived(activeModelId ? modelStore.getById(activeModelId) : undefined);

	// Models for the custom engine, filtered by search
	const filteredModels = $derived.by(() => {
		const models = modelStore.getByEngine(commitGen.engine);
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
		for (const model of filteredModels) {
			const key = model.engine.provider;
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key)!.push(model);
		}
		return groups;
	});

	// Fetch models when custom engine changes (for opencode)
	$effect(() => {
		if (useCustomModel && commitGen.engine !== 'claude-code') {
			modelStore.fetchModels(commitGen.engine);
		}
	});

	// Sync accordion state when search or models change
	$effect(() => {
		if (!useCustomModel) return;
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
			if (models.some(m => m.engine.model.id === commitGen.modelId)) {
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

	function toggleCustomModel() {
		updateSettings({
			commitGenerator: { ...commitGen, useCustomModel: !useCustomModel }
		});
	}

	async function selectEngine(engineType: EngineType) {
		const models = modelStore.getByEngine(engineType);
		const defaultModel = models[0];
		updateSettings({
			commitGenerator: {
				...commitGen,
				engine: engineType,
				modelId: defaultModel?.engine.model.id || '',
				modelName: defaultModel?.engine.model.name || ''
			}
		});
		searchQuery = '';

		if (engineType !== 'claude-code') {
			const fetched = await modelStore.fetchModels(engineType);
			if (fetched.length > 0) {
				updateSettings({
					commitGenerator: { ...settings.commitGenerator, modelId: fetched[0].engine.model.id, modelName: fetched[0].engine.model.name }
				});
			}
		}

		syncAccordionState();
	}

	function selectModel(mdl: EngineModel) {
		updateSettings({
			commitGenerator: { ...commitGen, modelId: mdl.engine.model.id, modelName: mdl.engine.model.name }
		});
	}

	function selectFormat(format: CommitMessageFormat) {
		updateSettings({
			commitGenerator: { ...commitGen, format }
		});
	}

	async function handleRefresh() {
		refreshing = true;
		try {
			await modelStore.refreshModels(commitGen.engine);
		} finally {
			refreshing = false;
		}
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Commit Message</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
		Generate conventional commit messages from staged changes using AI
	</p>

	<!-- Current Model Info -->
	<div class="mb-5">
		<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Model</label>
		<div class="flex items-center gap-3 px-3.5 py-2.5 border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-800/50">
			{#if activeEngineMeta}
				<div class="flex-shrink-0">
					<div class="flex dark:hidden items-center justify-center w-4 h-4">{@html activeEngineMeta.icon.light}</div>
					<div class="hidden dark:flex items-center justify-center w-4 h-4">{@html activeEngineMeta.icon.dark}</div>
				</div>
			{/if}
			<div class="flex-1 min-w-0">
				<span class="text-sm font-medium text-slate-900 dark:text-slate-100">
					{activeModelMeta?.engine.model.name || activeModelId}
				</span>
				{#if !useCustomModel}
					<span class="text-xs text-slate-500 dark:text-slate-400 ml-1.5">(same as assistant)</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- Custom Model Toggle -->
	<div class="mb-5">
		<button
			type="button"
			class="flex items-center gap-3 w-full text-left"
			onclick={toggleCustomModel}
		>
			<div class="relative w-9 h-5 rounded-full transition-colors duration-200 flex-shrink-0
				{useCustomModel ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}">
				<div class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200
					{useCustomModel ? 'translate-x-4.5' : 'translate-x-0.5'}"></div>
			</div>
			<div>
				<span class="text-sm font-medium text-slate-900 dark:text-slate-100">Use custom model</span>
				<p class="text-xs text-slate-500 dark:text-slate-400">Use a different engine and model instead of the assistant model</p>
			</div>
		</button>
	</div>

	<!-- Custom Engine & Model Selection (only when toggled on) -->
	{#if useCustomModel}
		<!-- Engine Selection -->
		<div class="mb-6">
			<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Engine</label>
			<div class="flex gap-3">
				{#each ENGINES as engine (engine.type)}
					{@const isActive = commitGen.engine === engine.type}
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
		</div>

		<!-- Model Selection -->
		<div class="mb-6">
			<div class="flex items-center justify-between mb-1.5">
				<label class="text-sm font-semibold text-slate-700 dark:text-slate-300">Model</label>
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
				Select the model for the {ENGINES.find(e => e.type === commitGen.engine)?.name || 'selected'} engine
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
				{#if modelStore.loading && commitGen.engine !== 'claude-code' && !refreshing}
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
						{@const hasSelectedModel = providerModels.some(m => m.engine.model.id === commitGen.modelId)}
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
									{#each providerModels as model (model.engine.model.id)}
										{@const isSelected = commitGen.modelId === model.engine.model.id}
																				<button
											type="button"
											class="flex items-start gap-3 px-3 py-2.5 text-left cursor-pointer transition-all duration-150
												{isSelected
												? 'bg-violet-500/10 dark:bg-violet-500/12'
												: 'hover:bg-slate-100/80 dark:hover:bg-slate-700/30'}"
											onclick={() => selectModel(model)}
										>
											<div class="flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5
												{isSelected ? 'border-violet-600' : 'border-slate-300 dark:border-slate-600'}">
												{#if isSelected}
													<div class="w-2 h-2 rounded-full bg-violet-600"></div>
												{/if}
											</div>
											<div class="flex-1 min-w-0">
												<div class="flex items-center gap-2">
													<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{model.engine.model.name}</span>
												</div>
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
	{/if}

	<!-- Format Selection -->
	<div class="mb-2">
		<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Message Format</label>
		<div class="flex gap-2">
			{#each formatOptions as fmt (fmt.id)}
				{@const isActive = commitGen.format === fmt.id}
				<button
					type="button"
					class="flex-1 flex items-center gap-2.5 p-3 border-2 rounded-xl text-left cursor-pointer transition-all duration-200
						{isActive
						? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8'
						: 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20 dark:hover:border-violet-500/35'}"
					onclick={() => selectFormat(fmt.id)}
				>
					<Icon name={fmt.icon} class="w-4 h-4 {isActive ? 'text-violet-600' : 'text-slate-400'}" />
					<div>
						<div class="text-sm font-medium text-slate-900 dark:text-slate-100">{fmt.label}</div>
						<div class="text-xs text-slate-500 dark:text-slate-400 font-mono">{fmt.desc}</div>
					</div>
				</button>
			{/each}
		</div>
	</div>
</div>

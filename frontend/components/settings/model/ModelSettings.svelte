<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import {
		DEFAULT_BRANCH_NAME_PREFIX,
		DEFAULT_BRANCH_SEPARATOR,
		MAX_BRANCH_SEPARATOR_LENGTH,
		RELEASE_BRANCH_NAME_PREFIX,
		TEST_BRANCH_NAME_PREFIX
	} from '$shared/constants/git';
	import type { EngineType } from '$shared/types/unified';
	import type { CommitMessageFormat } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';
	import EngineModelPicker from './EngineModelPicker.svelte';

	type Tab = 'assistant' | 'commit-message';

	const tabs: { id: Tab; label: string; icon: IconName }[] = [
		{ id: 'assistant', label: 'Assistant', icon: 'lucide:bot' },
		{ id: 'commit-message', label: 'Commit Message', icon: 'lucide:git-branch' }
	];

	let activeTab = $state<Tab>('assistant');

	// --- Assistant ---

	function handleAssistantEngineChange(engineType: EngineType) {
		updateSettings({ selectedEngine: engineType });

		const memory = settings.engineModelMemory || {};
		const remembered = memory[engineType];

		modelStore.fetchModels(engineType).then(models => {
			const target = (remembered && models.find(m => m.engine.model.id === remembered.id))
				|| models[0];
			if (target) {
				updateSettings({
					selectedProvider: target.engine.provider,
					selectedModelId: target.engine.model.id,
					selectedModelName: target.engine.model.name,
					engineModelMemory: { ...memory, [engineType]: { provider: target.engine.provider, id: target.engine.model.id, name: target.engine.model.name } }
				});
			} else {
				updateSettings({ selectedProvider: '', selectedModelId: '', selectedModelName: '' });
			}
		});
	}

	function handleAssistantModelChange(modelId: string) {
		const memory = settings.engineModelMemory || {};
		const model = modelStore.getById(modelId);
		const provider = model?.engine.provider || settings.selectedProvider;
		updateSettings({
			selectedProvider: provider,
			selectedModelId: modelId,
			selectedModelName: model?.engine.model.name || modelId,
			engineModelMemory: { ...memory, [settings.selectedEngine]: { provider, id: modelId, name: model?.engine.model.name || modelId } }
		});
	}

	// --- Commit Message ---

	const formatOptions: { id: CommitMessageFormat; label: string; desc: string; icon: IconName }[] = [
		{ id: 'single-line', label: 'Single Line', desc: 'type(scope): subject', icon: 'lucide:minus' },
		{ id: 'multi-line', label: 'Multi Line', desc: 'Subject + body', icon: 'lucide:align-left' }
	];

	const commitGen = $derived(settings.commitGenerator);
	const useCustomModel = $derived(commitGen.useCustomModel);

	// Resolve which model is being used for display
	const activeEngine = $derived(useCustomModel ? commitGen.engine : settings.selectedEngine);
	const activeModelId = $derived(useCustomModel ? commitGen.modelId : settings.selectedModelId);
	const activeEngineMeta = $derived(ENGINES.find(e => e.type === activeEngine));
	const activeModelMeta = $derived(modelStore.getById(activeModelId));
	const INVALID_BRANCH_SEPARATOR_CHARS = /[\s\0~^:?*[\]\\]/;

	let branchSeparatorDraft = $state(DEFAULT_BRANCH_SEPARATOR);
	let lastSyncedBranchSeparator = $state('');

	$effect(() => {
		if (commitGen.branchSeparator === lastSyncedBranchSeparator) return;
		lastSyncedBranchSeparator = commitGen.branchSeparator;
		branchSeparatorDraft = commitGen.branchSeparator;
	});

	const branchSeparatorPreview = $derived(branchSeparatorDraft.trim());
	const branchTemplateExamples = $derived([
		{ branch: 'main/master', name: `${RELEASE_BRANCH_NAME_PREFIX}${branchSeparatorPreview || DEFAULT_BRANCH_SEPARATOR}login` },
		{ branch: 'test/testing', name: `${TEST_BRANCH_NAME_PREFIX}${branchSeparatorPreview || DEFAULT_BRANCH_SEPARATOR}login` },
		{ branch: 'other branches', name: `${DEFAULT_BRANCH_NAME_PREFIX}${branchSeparatorPreview || DEFAULT_BRANCH_SEPARATOR}login` }
	]);
	const branchTemplateError = $derived.by(() => {
		if (branchSeparatorPreview.length === 0) return 'Add a branch separator.';
		if (branchSeparatorPreview.length > MAX_BRANCH_SEPARATOR_LENGTH) {
			return `Use ${MAX_BRANCH_SEPARATOR_LENGTH} characters or fewer for the separator.`;
		}
		if (INVALID_BRANCH_SEPARATOR_CHARS.test(branchSeparatorPreview)) {
			return 'Separator cannot contain spaces or Git ref control characters.';
		}
		if (
			branchSeparatorPreview.includes('..') ||
			branchSeparatorPreview.includes('//') ||
			branchSeparatorPreview.includes('@{')
		) {
			return 'Separator would create an invalid Git branch ref.';
		}
		return '';
	});
	const branchTemplateDirty = $derived(branchSeparatorPreview !== commitGen.branchSeparator);

	function toggleCustomModel() {
		updateSettings({
			commitGenerator: { ...commitGen, useCustomModel: !useCustomModel }
		});
	}

	function handleCommitEngineChange(engineType: EngineType) {
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

		modelStore.fetchModels(engineType).then(fetched => {
			if (fetched.length > 0) {
				updateSettings({
					commitGenerator: { ...settings.commitGenerator, modelId: fetched[0].engine.model.id, modelName: fetched[0].engine.model.name }
				});
			}
		});
	}

	function handleCommitModelChange(modelId: string) {
		const model = modelStore.getById(modelId);
		updateSettings({
			commitGenerator: { ...commitGen, modelId, modelName: model?.engine.model.name || modelId }
		});
	}

	function selectFormat(format: CommitMessageFormat) {
		updateSettings({
			commitGenerator: { ...commitGen, format }
		});
	}

	function saveBranchTemplate() {
		if (branchTemplateError || !branchTemplateDirty) return;
		updateSettings({
			commitGenerator: {
				...commitGen,
				branchSeparator: branchSeparatorPreview
			}
		});
	}

	function resetBranchTemplate() {
		updateSettings({
			commitGenerator: {
				...commitGen,
				branchSeparator: DEFAULT_BRANCH_SEPARATOR
			}
		});
	}

	function handleBranchTemplateKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveBranchTemplate();
		}
	}
</script>

<div class="py-1">
	<!-- Tab Switcher -->
	<div class="flex gap-1 p-1 mb-5 bg-slate-100 dark:bg-slate-800/60 rounded-lg">
		{#each tabs as tab (tab.id)}
			{@const isActive = activeTab === tab.id}
			<button
				type="button"
				class="flex-1 flex items-center justify-center gap-2 py-2 px-3 text-sm font-medium rounded-md transition-all duration-200 cursor-pointer
					{isActive
					? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => activeTab = tab.id}
			>
				<Icon name={tab.icon} class="w-4 h-4 {isActive ? 'text-violet-600' : ''}" />
				{tab.label}
			</button>
		{/each}
	</div>

	<!-- ===== ASSISTANT TAB ===== -->
	{#if activeTab === 'assistant'}
		<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
			Configure the engine and model for chat
		</p>

		<EngineModelPicker
			engine={settings.selectedEngine}
			model={settings.selectedModelId}
			onEngineChange={handleAssistantEngineChange}
			onModelChange={handleAssistantModelChange}
		/>
	{/if}

	<!-- ===== COMMIT MESSAGE TAB ===== -->
	{#if activeTab === 'commit-message'}
		<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
			Configure the engine, model, and format for commits
		</p>

		<!-- Format Selection -->
		<div class="mb-5">
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

		<!-- Branch Name Template -->
		<div class="mb-5">
			<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Branch Name</label>
			<div class="p-3.5 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-100/80 dark:bg-slate-800/80">
				<div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_7rem] gap-3">
					<div class="min-w-0">
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
							Automatic Prefix
						</label>
						<div class="flex flex-wrap gap-1.5">
							<span class="px-2 py-1 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400">
								main/master -&gt; <code class="text-slate-800 dark:text-slate-200">{RELEASE_BRANCH_NAME_PREFIX}</code>
							</span>
							<span class="px-2 py-1 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400">
								test/testing -&gt; <code class="text-slate-800 dark:text-slate-200">{TEST_BRANCH_NAME_PREFIX}</code>
							</span>
							<span class="px-2 py-1 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400">
								other -&gt; <code class="text-slate-800 dark:text-slate-200">{DEFAULT_BRANCH_NAME_PREFIX}</code>
							</span>
						</div>
						<p class="mt-1.5 text-xs text-slate-500 dark:text-slate-500">
							Prefix is resolved from the current branch when generating.
						</p>
					</div>

					<div>
						<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
							Separator
						</label>
						<input
							type="text"
							bind:value={branchSeparatorDraft}
							onkeydown={handleBranchTemplateKeydown}
							maxlength={MAX_BRANCH_SEPARATOR_LENGTH}
							class="w-full font-mono text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md px-2.5 py-2 text-slate-700 dark:text-slate-300 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-400 dark:focus:border-violet-500"
							placeholder="/"
						/>
						<p class="mt-1.5 text-xs text-slate-500 dark:text-slate-500">
							Example: / or #
						</p>
					</div>
				</div>

				<div class="mt-3 flex flex-wrap items-center gap-2">
					{#each branchTemplateExamples as example (example.branch)}
						<div class="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
							<Icon name="lucide:git-branch" class="w-3.5 h-3.5 text-violet-500" />
							<span class="text-xs text-slate-500 dark:text-slate-400">{example.branch}</span>
							<code class="text-xs text-slate-800 dark:text-slate-200">{example.name}</code>
						</div>
					{/each}
				</div>

				{#if branchTemplateError}
					<div class="mt-2 text-xs text-red-500 dark:text-red-400">{branchTemplateError}</div>
				{/if}

				<div class="mt-3 flex items-center gap-2">
					<button
						type="button"
						onclick={saveBranchTemplate}
						disabled={!!branchTemplateError || !branchTemplateDirty}
						class="inline-flex items-center gap-1.5 py-1.5 px-3 bg-violet-500/10 border border-violet-500/20 rounded-md text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:border-violet-600/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-violet-500/10 disabled:hover:border-violet-500/20"
					>
						<Icon name="lucide:check" class="w-3.5 h-3.5" />
						Save
					</button>
					<button
						type="button"
						onclick={resetBranchTemplate}
						class="inline-flex items-center gap-1.5 py-1.5 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-slate-600 dark:text-slate-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-slate-50 dark:hover:bg-slate-800 hover:border-slate-300 dark:hover:border-slate-600"
					>
						<Icon name="lucide:rotate-ccw" class="w-3.5 h-3.5" />
						Reset
					</button>
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

		<!-- Current Model Info (hidden when custom model is active) -->
		{#if !useCustomModel}
			<div class="mb-2">
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
						<span class="text-xs text-slate-500 dark:text-slate-400 ml-1.5">(same as assistant)</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- Custom Engine & Model Selection (only when toggled on) -->
		{#if useCustomModel}
			<div class="mb-2">
				<EngineModelPicker
					engine={commitGen.engine}
					model={commitGen.modelId}
					onEngineChange={handleCommitEngineChange}
					onModelChange={handleCommitModelChange}
				/>
			</div>
		{/if}
	{/if}
</div>

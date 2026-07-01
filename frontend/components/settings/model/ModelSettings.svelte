<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { taskClientStore } from '$frontend/stores/features/task-client.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType } from '$shared/types/unified';
	import type { CommitMessageFormat } from '$shared/types/git';
	import type { CommitMessageConfig, BranchNameConfig } from '$shared/types/stores/settings';
	import type { IconName } from '$shared/types/ui/icons';
	import EngineModelPicker from './EngineModelPicker.svelte';

	type Tab = 'assistant' | 'commit-message';

	const tabs: { id: Tab; label: string; icon: IconName }[] = [
		{ id: 'assistant', label: 'Assistant', icon: 'lucide:bot' },
		{ id: 'commit-message', label: 'Git', icon: 'lucide:git-branch' }
	];

	let activeTab = $state<Tab>('assistant');
	let showModelConfig = $state(false);
	let showCommitConfig = $state(false);
	let showBranchConfig = $state(false);
	let showTicketConfig = $state(false);
	const isTrelloConnected = $derived(taskClientStore.accounts.length > 0);

	let commitConfigDraft = $state<CommitMessageConfig>({ style: 'technical', subjectLength: 72, allowedTypes: '', context: '' });
	let branchConfigDraft = $state<BranchNameConfig>({ maxWords: 3, allowedPrefixes: '', context: '', branchMessageSeparator: '-' });
	let ticketPrefixDraft = $state<'short-link' | 'id-short'>('short-link');
	let ticketLanguageDraft = $state<'auto' | 'en'>('auto');

	$effect(() => {
		if (showCommitConfig) commitConfigDraft = { ...commitGen.commitConfig };
	});
	$effect(() => {
		if (showBranchConfig) branchConfigDraft = { ...commitGen.branchConfig };
	});
	$effect(() => {
		if (showTicketConfig) {
			ticketPrefixDraft = commitGen.ticketPrefix || 'short-link';
			ticketLanguageDraft = commitGen.ticketLanguage || 'auto';
		}
	});

	function saveCommitConfig() {
		updateSettings({ commitGenerator: { ...commitGen, commitConfig: { ...commitConfigDraft } } });
		showCommitConfig = false;
	}

	function saveBranchConfig() {
		updateSettings({ commitGenerator: { ...commitGen, branchConfig: { ...branchConfigDraft } } });
		showBranchConfig = false;
	}

	function saveTicketConfig() {
		updateSettings({
			commitGenerator: {
				...commitGen,
				ticketPrefix: ticketPrefixDraft,
				ticketLanguage: ticketLanguageDraft
			}
		});
		showTicketConfig = false;
	}

	const STYLE_OPTIONS = [
		{ value: 'technical' as const, label: 'Technical', desc: 'Precise and specific' },
		{ value: 'concise' as const, label: 'Concise', desc: 'Short and compact' },
		{ value: 'descriptive' as const, label: 'Descriptive', desc: 'Natural and explanatory' },
	] as const;

	const SUBJECT_LENGTH_OPTIONS = [50, 72, 100] as const;
	const MAX_WORDS_OPTIONS = [1, 2, 3] as const;

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
		{ id: 'multi-line', label: 'Multi Line', desc: 'type(scope): subject + body', icon: 'lucide:align-left' }
	];

	const commitGen = $derived(settings.commitGenerator);
	const useCustomModel = $derived(commitGen.useCustomModel);

	// Resolve which model is being used for display
	const activeEngine = $derived(useCustomModel ? commitGen.engine : settings.selectedEngine);
	const activeModelId = $derived(useCustomModel ? commitGen.modelId : settings.selectedModelId);
	const activeEngineMeta = $derived(ENGINES.find(e => e.type === activeEngine));
	const activeModelMeta = $derived(modelStore.getById(activeModelId));
	const separatorOptions: { value: string; label: string }[] = [
		{ value: '/', label: 'Slash' },
		{ value: '-', label: 'Dash' },
		{ value: '#', label: 'Hash' },
	];

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

	function selectBranchSeparator(value: string) {
		updateSettings({ commitGenerator: { ...commitGen, branchSeparator: value } });
	}

	function updateTicketSource(value: 'none' | 'trello') {
		updateSettings({ commitGenerator: { ...commitGen, ticketSource: value } });
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
			Configure AI models and settings for git operations
		</p>

		<!-- Format Selection -->
		<div class="mb-5">
			<div class="flex items-center justify-between mb-2">
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Commit Message</label>
				<button type="button" onclick={() => showCommitConfig = true} class="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer">
					<Icon name="lucide:settings-2" class="w-3 h-3" />
					Configure
				</button>
			</div>
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

		<!-- Branch Name -->
		<div class="mb-5">
			<div class="flex items-center justify-between mb-2">
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Branch Name</label>
				<button type="button" onclick={() => showBranchConfig = true} class="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer">
					<Icon name="lucide:settings-2" class="w-3 h-3" />
					Configure
				</button>
			</div>
			<div class="flex gap-2">
				{#each separatorOptions as sep (sep.value)}
					{@const isActive = commitGen.branchSeparator === sep.value}
					<button
						type="button"
						class="flex-1 flex items-center gap-2.5 p-3 border-2 rounded-xl text-left cursor-pointer transition-all duration-200
							{isActive
							? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8'
							: 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20 dark:hover:border-violet-500/35'}"
						onclick={() => selectBranchSeparator(sep.value)}
					>
						<code class="text-base font-mono font-bold {isActive ? 'text-violet-600' : 'text-slate-400'}">{sep.value}</code>
						<div>
							<div class="text-sm font-medium text-slate-900 dark:text-slate-100">{sep.label}</div>
							<div class="text-xs text-slate-500 dark:text-slate-400 font-mono">type{sep.value}topic</div>
						</div>
					</button>
				{/each}
			</div>
		</div>

		<!-- Ticket ID Integration -->
		<div class="mb-5">
			<div class="flex items-center justify-between mb-2">
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Branch Ticket</label>
				{#if commitGen.ticketSource && commitGen.ticketSource !== 'none'}
					<button type="button" onclick={() => showTicketConfig = true} class="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer">
						<Icon name="lucide:settings-2" class="w-3 h-3" />
						Configure
					</button>
				{/if}
			</div>
			<div class="flex gap-2">
				<button
					type="button"
					class="flex-1 flex items-center gap-2.5 p-3 border-2 rounded-xl text-left cursor-pointer transition-all duration-200
						{commitGen.ticketSource === 'none' || !commitGen.ticketSource
						? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8'
						: 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20 dark:hover:border-violet-500/35'}"
					onclick={() => updateTicketSource('none')}
				>
					<Icon name="lucide:ban" class="w-4 h-4 {commitGen.ticketSource === 'none' || !commitGen.ticketSource ? 'text-violet-600' : 'text-slate-400'}" />
					<div>
						<div class="text-sm font-medium text-slate-900 dark:text-slate-100">None</div>
						<div class="text-xs text-slate-500 dark:text-slate-400">Do not prepend ticket ID</div>
					</div>
				</button>
				
				<button
					type="button"
					disabled={!isTrelloConnected}
					class="flex-1 flex items-center gap-2.5 p-3 border-2 rounded-xl text-left transition-all duration-200
						{commitGen.ticketSource === 'trello'
						? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8'
						: 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20 dark:hover:border-violet-500/35'}
						{!isTrelloConnected ? 'opacity-40 cursor-not-allowed hover:border-slate-200 dark:hover:border-slate-800' : 'cursor-pointer'}"
					onclick={() => updateTicketSource('trello')}
				>
					<Icon name="lucide:trello" class="w-4 h-4 {commitGen.ticketSource === 'trello' ? 'text-violet-600' : 'text-slate-400'}" />
					<div>
						<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Trello</div>
						<div class="text-xs text-slate-500 dark:text-slate-400">
							{#if isTrelloConnected}
								Use active Trello card ID
							{:else}
								Account not connected
							{/if}
						</div>
					</div>
				</button>
			</div>
		</div>

		<!-- Model (compact row) -->
		<div>
			<div class="flex items-center justify-between mb-2">
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Model</label>
				<button
					type="button"
					onclick={() => showModelConfig = true}
					class="flex items-center gap-1 text-xs text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer"
				>
					<Icon name="lucide:settings-2" class="w-3 h-3" />
					Configure
				</button>
			</div>
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
					{#if useCustomModel}
						<span class="text-xs text-violet-500 dark:text-violet-400 ml-1.5">Custom</span>
					{:else}
						<span class="text-xs text-slate-500 dark:text-slate-400 ml-1.5">(same as assistant)</span>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<Modal isOpen={showCommitConfig} onClose={() => showCommitConfig = false} size="md">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<h2 class="text-base font-bold text-slate-900 dark:text-slate-100">Configure Commit Message</h2>
			<button type="button" class="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer" onclick={() => showCommitConfig = false}>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	{/snippet}
	{#snippet children()}
		<div class="space-y-5">
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Style</label>
				<div class="flex gap-2">
					{#each STYLE_OPTIONS as opt (opt.value)}
						{@const isActive = commitConfigDraft.style === opt.value}
						<button type="button" onclick={() => commitConfigDraft.style = opt.value}
							class="flex-1 flex flex-col gap-0.5 p-3 border-2 rounded-xl text-left cursor-pointer transition-all duration-200
								{isActive ? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8' : 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20'}">
							<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{opt.label}</span>
							<span class="text-xs text-slate-500 dark:text-slate-400">{opt.desc}</span>
						</button>
					{/each}
				</div>
			</div>
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Subject length</label>
				<div class="flex gap-2">
					{#each SUBJECT_LENGTH_OPTIONS as len (len)}
						{@const isActive = commitConfigDraft.subjectLength === len}
						<button type="button" onclick={() => commitConfigDraft.subjectLength = len}
							class="flex-1 flex flex-col gap-0.5 p-3 border-2 rounded-xl text-left cursor-pointer transition-all duration-200
								{isActive ? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8' : 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20'}">
							<span class="text-sm font-medium text-slate-900 dark:text-slate-100 font-mono">{len}</span>
							<span class="text-xs text-slate-500 dark:text-slate-400">chars</span>
						</button>
					{/each}
				</div>
			</div>
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Allowed types <span class="text-slate-400 font-normal">(optional)</span></label>
				<input type="text" bind:value={commitConfigDraft.allowedTypes}
					class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 placeholder:text-slate-400 outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-400"
					placeholder="feat, fix, docs, chore" />
				<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Comma-separated. Empty = AI decides freely.</p>
			</div>
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Additional context <span class="text-slate-400 font-normal">(optional)</span></label>
				<textarea bind:value={commitConfigDraft.context} rows="3"
					class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 placeholder:text-slate-400 resize-none outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-400"
					placeholder="e.g. monorepo — scopes map to top-level packages; subject should state why, not what moved"></textarea>
				<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Guides the AI for your project's conventions.</p>
			</div>
		</div>
	{/snippet}
	{#snippet footer()}
		<button type="button" onclick={() => showCommitConfig = false} class="px-3 py-2 text-sm font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
			Cancel
		</button>
		<button type="button" onclick={saveCommitConfig} class="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer">
			Save
		</button>
	{/snippet}
</Modal>

<Modal isOpen={showBranchConfig} onClose={() => showBranchConfig = false} size="md">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<h2 class="text-base font-bold text-slate-900 dark:text-slate-100">Configure Branch Name</h2>
			<button type="button" class="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer" onclick={() => showBranchConfig = false}>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	{/snippet}
	{#snippet children()}
		<div class="space-y-5">
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Max words</label>
				<div class="flex gap-2">
					{#each MAX_WORDS_OPTIONS as n (n)}
						{@const isActive = branchConfigDraft.maxWords === n}
						<button type="button" onclick={() => branchConfigDraft.maxWords = n}
							class="flex-1 flex flex-col gap-0.5 p-3 border-2 rounded-xl text-center cursor-pointer transition-all duration-200
								{isActive ? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8' : 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20'}">
							<span class="text-sm font-medium text-slate-900 dark:text-slate-100 font-mono">{n}</span>
							<span class="text-xs text-slate-500 dark:text-slate-400">word{n === 1 ? '' : 's'}</span>
						</button>
					{/each}
				</div>
			</div>

			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Branch message separator</label>
				<div class="flex gap-2">
					{#each [
						{ value: '-', label: 'Dash', desc: '-' },
						{ value: '_', label: 'Underscore', desc: '_' }
					] as sepOption}
						{@const isActive = (branchConfigDraft.branchMessageSeparator ?? '-') === sepOption.value}
						<button type="button" onclick={() => branchConfigDraft.branchMessageSeparator = sepOption.value}
							class="flex-1 flex flex-col gap-0.5 p-3 border-2 rounded-xl text-center cursor-pointer transition-all duration-200
								{isActive ? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8' : 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20'}">
							<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{sepOption.label}</span>
							<span class="text-xs text-slate-500 dark:text-slate-400 font-mono">{sepOption.desc}</span>
						</button>
					{/each}
				</div>
			</div>
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Allowed prefixes <span class="text-slate-400 font-normal">(optional)</span></label>
				<input type="text" bind:value={branchConfigDraft.allowedPrefixes}
					class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 placeholder:text-slate-400 outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-400"
					placeholder="feature, fix, docs, chore" />
				<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Comma-separated. Empty = auto-detected from current branch.</p>
			</div>
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Additional context <span class="text-slate-400 font-normal">(optional)</span></label>
				<textarea bind:value={branchConfigDraft.context} rows="3"
					class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-700 dark:text-slate-300 placeholder:text-slate-400 resize-none outline-none focus:ring-1 focus:ring-violet-500/30 focus:border-violet-400"
					placeholder="e.g. always include ticket ID if found in diff; keep names to a single topic area"></textarea>
				<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Guides the AI for your project's conventions.</p>
			</div>
		</div>
	{/snippet}
	{#snippet footer()}
		<button type="button" onclick={() => showBranchConfig = false} class="px-3 py-2 text-sm font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
			Cancel
		</button>
		<button type="button" onclick={saveBranchConfig} class="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer">
			Save
		</button>
	{/snippet}
</Modal>

<Modal isOpen={showTicketConfig} onClose={() => showTicketConfig = false} size="md">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<h2 class="text-base font-bold text-slate-900 dark:text-slate-100">Configure Branch Ticket</h2>
			<button type="button" class="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer" onclick={() => showTicketConfig = false}>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	{/snippet}
	{#snippet children()}
		<div class="space-y-5">
			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">ID Format</label>
				<div class="flex gap-2">
					{#each [
						{ value: 'short-link', label: 'Short Link', desc: '7Hk9Xm1' },
						{ value: 'id-short', label: 'Short ID', desc: '123' }
					] as opt}
						{@const isActive = ticketPrefixDraft === opt.value}
						<button type="button" onclick={() => ticketPrefixDraft = opt.value as any}
							class="flex-1 flex flex-col gap-0.5 p-3 border-2 rounded-xl text-left cursor-pointer transition-all duration-200
								{isActive ? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8' : 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20'}">
							<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{opt.label}</span>
							<span class="text-xs text-slate-500 dark:text-slate-400 font-mono">({opt.desc})</span>
						</button>
					{/each}
				</div>
			</div>

			<div>
				<label class="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">Language</label>
				<div class="flex gap-2">
					{#each [
						{ value: 'auto', label: 'Auto', desc: 'Default' },
						{ value: 'en', label: 'English', desc: 'English' }
					] as langOption}
						{@const isActive = ticketLanguageDraft === langOption.value}
						<button type="button" onclick={() => ticketLanguageDraft = langOption.value as any}
							class="flex-1 flex flex-col gap-0.5 p-3 border-2 rounded-xl text-left cursor-pointer transition-all duration-200
								{isActive ? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8' : 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20'}">
							<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{langOption.label}</span>
							<span class="text-xs text-slate-500 dark:text-slate-400">{langOption.desc}</span>
						</button>
					{/each}
				</div>
			</div>
		</div>
	{/snippet}
	{#snippet footer()}
		<button type="button" onclick={() => showTicketConfig = false} class="px-3 py-2 text-sm font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer">
			Cancel
		</button>
		<button type="button" onclick={saveTicketConfig} class="inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors cursor-pointer">
			Save
		</button>
	{/snippet}
</Modal>

<Modal isOpen={showModelConfig} onClose={() => showModelConfig = false} size="lg">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-5 md:py-4">
			<h2 class="text-base font-bold text-slate-900 dark:text-slate-100">Configure Model</h2>
			<button
				type="button"
				class="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors cursor-pointer"
				onclick={() => showModelConfig = false}
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	{/snippet}
	{#snippet children()}
		<div class="space-y-4">
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
			{#if useCustomModel}
				<EngineModelPicker
					engine={commitGen.engine}
					model={commitGen.modelId}
					onEngineChange={handleCommitEngineChange}
					onModelChange={handleCommitModelChange}
				/>
			{/if}
		</div>
	{/snippet}
</Modal>

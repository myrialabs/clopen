<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import type { CommitMessageFormat } from '$shared/types/git';
	import type { CommitMessageConfig, BranchNameConfig } from '$shared/types/stores/settings';
	import type { IconName } from '$shared/types/ui/icons';
	import ModelPurposeLink from './ModelPurposeLink.svelte';

	let showCommitConfig = $state(false);
	let showBranchConfig = $state(false);

	let commitConfigDraft = $state<CommitMessageConfig>({ style: 'technical', subjectLength: 72, allowedTypes: '', context: '' });
	let branchConfigDraft = $state<BranchNameConfig>({ maxWords: 3, allowedPrefixes: '', context: '' });

	$effect(() => {
		if (showCommitConfig) commitConfigDraft = { ...commitGen.commitConfig };
	});
	$effect(() => {
		if (showBranchConfig) branchConfigDraft = { ...commitGen.branchConfig };
	});

	function saveCommitConfig() {
		updateSettings({ commitGenerator: { ...commitGen, commitConfig: { ...commitConfigDraft } } });
		showCommitConfig = false;
	}

	function saveBranchConfig() {
		updateSettings({ commitGenerator: { ...commitGen, branchConfig: { ...branchConfigDraft } } });
		showBranchConfig = false;
	}

	const STYLE_OPTIONS = [
		{ value: 'technical' as const, label: 'Technical', desc: 'Precise and specific' },
		{ value: 'concise' as const, label: 'Concise', desc: 'Short and compact' },
		{ value: 'descriptive' as const, label: 'Descriptive', desc: 'Natural and explanatory' },
	] as const;

	const SUBJECT_LENGTH_OPTIONS = [50, 72, 100] as const;
	const MAX_WORDS_OPTIONS = [1, 2, 3] as const;

	const formatOptions: { id: CommitMessageFormat; label: string; desc: string; icon: IconName }[] = [
		{ id: 'single-line', label: 'Single Line', desc: 'type(scope): subject', icon: 'lucide:minus' },
		{ id: 'multi-line', label: 'Multi Line', desc: 'type(scope): subject + body', icon: 'lucide:align-left' }
	];

	const commitGen = $derived(settings.commitGenerator);

	const separatorOptions: { value: string; label: string }[] = [
		{ value: '/', label: 'Slash' },
		{ value: '-', label: 'Dash' },
		{ value: '#', label: 'Hash' },
	];

	function selectFormat(format: CommitMessageFormat) {
		updateSettings({
			commitGenerator: { ...commitGen, format }
		});
	}

	function selectBranchSeparator(value: string) {
		updateSettings({ commitGenerator: { ...commitGen, branchSeparator: value } });
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Git</h3>
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

	<!-- Model: said here, chosen in Settings → Models. -->
	<ModelPurposeLink purpose="commits" />
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


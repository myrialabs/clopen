<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import FileChangeItem from './FileChangeItem.svelte';
	import type { GitFileChange } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		title: string;
		icon: IconName;
		files: GitFileChange[];
		section: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
		collapsed?: boolean;
		onStage?: (path: string) => void;
		onUnstage?: (path: string) => void;
		onDiscard?: (path: string) => void;
		onStageAll?: () => void;
		onUnstageAll?: () => void;
		onDiscardAll?: () => void;
		onViewDiff?: (file: GitFileChange, section: string) => void;
		onResolve?: (path: string) => void;
	}

	const {
		title, icon, files, section,
		collapsed = false,
		onStage, onUnstage, onDiscard,
		onStageAll, onUnstageAll, onDiscardAll,
		onViewDiff, onResolve
	}: Props = $props();

	let isCollapsed = $state(collapsed);
</script>

{#if files.length > 0}
	<div class="mb-1">
		<!-- Section header -->
		<div
			onclick={() => isCollapsed = !isCollapsed}
			class="group flex items-center gap-2 py-3 px-2 cursor-pointer select-none hover:bg-slate-100 dark:hover:bg-slate-800/40 rounded-md transition-colors">
			<div
				class="flex items-center gap-2 flex-1 min-w-0 bg-transparent border-none text-left cursor-pointer p-0"
			>
				<Icon
					name={isCollapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'}
					class="w-4 h-4 text-slate-500 shrink-0"
				/>
				<!-- <Icon name={icon} class="w-4 h-4 text-slate-500 shrink-0" /> -->
				<span class="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
					{title}
				</span>
				<span class="text-xs font-medium text-slate-400 dark:text-slate-600 ml-0.5">
					{files.length}
				</span>
			</div>

			<!-- Bulk actions (hidden until hover) -->
			<div class="flex items-center gap-0.5 shrink-0 -my-2">
				{#if section === 'staged' && onUnstageAll}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
						onclick={(e) => { e.stopPropagation(); onUnstageAll?.(); }}
						title="Unstage All"
					>
						<Icon name="lucide:minus" class="w-4 h-4" />
					</button>
				{:else if (section === 'unstaged' || section === 'untracked') && onStageAll}
					{#if onDiscardAll}
						<button
							type="button"
							class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
							onclick={(e) => { e.stopPropagation(); onDiscardAll?.(); }}
							title="Discard All"
						>
							<Icon name="lucide:undo-2" class="w-4 h-4" />
						</button>
					{/if}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors bg-transparent border-none cursor-pointer"
						onclick={(e) => { e.stopPropagation(); onStageAll?.(); }}
						title="Stage All"
					>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</button>
				{/if}
			</div>
		</div>

		<!-- Files list -->
		{#if !isCollapsed}
			<div class="ml-2">
				{#each files as file (file.path)}
					<FileChangeItem
						{file}
						{section}
						{onStage}
						{onUnstage}
						{onDiscard}
						{onViewDiff}
						{onResolve}
					/>
				{/each}
			</div>
		{/if}
	</div>
{/if}

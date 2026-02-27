<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import { getGitStatusLabel, getGitStatusColor } from '$frontend/lib/utils/git-status';
	import type { GitFileChange } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		file: GitFileChange;
		section: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
		isActive?: boolean;
		onStage?: (path: string) => void;
		onUnstage?: (path: string) => void;
		onDiscard?: (path: string) => void;
		onViewDiff?: (file: GitFileChange, section: string) => void;
		onResolve?: (path: string) => void;
	}

	const { file, section, isActive = false, onStage, onUnstage, onDiscard, onViewDiff, onResolve }: Props = $props();

	const statusCode = $derived(section === 'staged' ? file.indexStatus : file.workingStatus);
	const statusLabel = $derived(getGitStatusLabel(statusCode));
	const statusColor = $derived(getGitStatusColor(statusCode));
	const fileName = $derived(file.path.split(/[\\/]/).pop() || file.path);
	const dirPath = $derived(() => {
		const parts = file.path.split(/[\\/]/);
		parts.pop();
		return parts.join('/');
	});
	const fileIcon = $derived(getFileIcon(fileName) as IconName);
</script>

<div
	class="group flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer transition-colors
		{isActive
			? 'bg-violet-500/10 dark:bg-violet-500/15 text-slate-900 dark:text-slate-100'
			: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
	role="button"
	tabindex="0"
	onclick={() => onViewDiff?.(file, section)}
	onkeydown={(e) => e.key === 'Enter' && onViewDiff?.(file, section)}
	title={file.path}
>
	<!-- File icon -->
	<Icon name={fileIcon} class="w-4 h-4 shrink-0" />

	<!-- File name - truncated -->
	<span class="text-xs font-medium truncate min-w-0 flex-1">{fileName}</span>

	<!-- Dir path - truncated, dimmed -->
	{#if dirPath()}
		<span class="text-3xs text-slate-400 dark:text-slate-500 truncate max-w-20 shrink">{dirPath()}</span>
	{/if}

	<!-- Status badge -->
	<span class="w-4 text-center text-xs font-bold {statusColor} shrink-0">{statusLabel}</span>

	<!-- Actions - always visible -->
	<div class="flex items-center gap-0.5 shrink-0">
		{#if section === 'staged'}
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
				onclick={(e) => { e.stopPropagation(); onUnstage?.(file.path); }}
				title="Unstage"
			>
				<Icon name="lucide:minus" class="w-3.5 h-3.5" />
			</button>
		{:else if section === 'unstaged' || section === 'untracked'}
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors bg-transparent border-none cursor-pointer"
				onclick={(e) => { e.stopPropagation(); onDiscard?.(file.path); }}
				title="Discard Changes"
			>
				<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
			</button>
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-500 transition-colors bg-transparent border-none cursor-pointer"
				onclick={(e) => { e.stopPropagation(); onStage?.(file.path); }}
				title="Stage Changes"
			>
				<Icon name="lucide:plus" class="w-3.5 h-3.5" />
			</button>
		{:else if section === 'conflicted'}
			<button
				type="button"
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-500 transition-colors bg-transparent border-none cursor-pointer"
				onclick={(e) => { e.stopPropagation(); onResolve?.(file.path); }}
				title="Resolve Conflict"
			>
				<Icon name="lucide:wrench" class="w-3.5 h-3.5" />
			</button>
		{/if}
	</div>
</div>

<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getGitStatusLabel, getGitStatusColor } from '$frontend/utils/git-status';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { GitFileDiff } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		commitHash: string;
		commitHashShort: string;
		commitMessage: string;
		commitBody?: string;
		commitAuthor: string;
		files: GitFileDiff[];
		isLoading: boolean;
		activeFilePath?: string | null;
		onBack: () => void;
		onViewFile: (file: GitFileDiff) => void;
	}

	const {
		commitHash,
		commitHashShort,
		commitMessage,
		commitBody = '',
		commitAuthor,
		files,
		isLoading,
		activeFilePath = null,
		onBack,
		onViewFile
	}: Props = $props();

	// The body is hidden by default — it can be long, so the user opts in to
	// reveal it via a toggle.
	let bodyExpanded = $state(false);

	// Collapse again whenever the commit changes.
	$effect(() => {
		commitHash;
		bodyExpanded = false;
	});

	function splitPath(path: string): { fileName: string; dirPath: string } {
		const parts = path.split(/[\\/]/);
		const fileName = parts.pop() || path;
		return { fileName, dirPath: parts.join('/') };
	}

	async function copyCommitHash() {
		try {
			await navigator.clipboard.writeText(commitHash);
			addNotification({ type: 'success', title: 'Copied', message: `Commit ${commitHashShort} copied to clipboard`, duration: 2000 });
		} catch {
			addNotification({ type: 'error', title: 'Failed', message: 'Could not copy to clipboard', duration: 3000 });
		}
	}
</script>

<div class="flex-1 min-h-0 flex flex-col">
	<!-- Header: back button + commit summary -->
	<div class="flex items-start gap-2 px-2 py-[0.57rem] border-b border-slate-200 dark:border-slate-700">
		<button
			type="button"
			class="flex items-center justify-center w-7 h-7 mt-0.5 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300 transition-colors bg-transparent border-none cursor-pointer flex-shrink-0"
			onclick={onBack}
			title="Back to commits"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
		</button>
		<div class="flex-1 min-w-0 pt-0.5">
			<p class="text-sm font-medium text-slate-900 dark:text-slate-100 leading-snug break-words" title={commitMessage}>
				{commitMessage}
			</p>
			<div class="flex items-center gap-1.5 mt-1">
				<button
					type="button"
					class="text-xs font-mono text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 bg-transparent border-none cursor-pointer p-0 shrink-0 transition-colors"
					onclick={copyCommitHash}
					title="Copy commit hash"
				>
					{commitHashShort}
				</button>
				<span class="text-xs text-slate-500 truncate">{commitAuthor}</span>
			</div>
			{#if commitBody}
				<div class="mt-1.5">
					<button
						type="button"
						class="flex items-center gap-1 text-xs font-medium text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 bg-transparent border-none cursor-pointer p-0 transition-colors"
						onclick={() => (bodyExpanded = !bodyExpanded)}
						aria-expanded={bodyExpanded}
					>
						<Icon name="lucide:chevron-right" class="w-3.5 h-3.5 transition-transform {bodyExpanded ? 'rotate-90' : ''}" />
						{bodyExpanded ? 'Hide description' : 'Show description'}
					</button>
					{#if bodyExpanded}
						<pre
							class="mt-1.5 whitespace-pre-wrap break-words font-mono text-xs text-slate-600 dark:text-slate-400 leading-relaxed max-h-64 overflow-y-auto pr-1"
						>{commitBody}</pre>
					{/if}
				</div>
			{/if}
		</div>
	</div>

	<!-- Files list -->
	<div class="flex-1 overflow-y-auto pt-1">
		{#if isLoading}
			<div class="flex items-center justify-center py-8">
				<div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
			</div>
		{:else if files.length === 0}
			<div class="flex flex-col items-center justify-center gap-2 py-8 text-slate-500 text-xs">
				<Icon name="lucide:file-diff" class="w-6 h-6 opacity-30" />
				<span>No files changed</span>
			</div>
		{:else}
			<div class="px-2 pb-2">
				{#each files as file (file.newPath || file.oldPath)}
					{@const path = file.newPath || file.oldPath}
					{@const parts = splitPath(path)}
					{@const isActive = activeFilePath === path}
					<div
						class="group flex items-center gap-1.5 min-h-9 py-1.5 px-2 rounded-md cursor-pointer transition-colors
							{isActive
								? 'bg-violet-500/10 dark:bg-violet-500/15 text-slate-900 dark:text-slate-100'
								: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
						role="button"
						tabindex="0"
						onclick={() => onViewFile(file)}
						onkeydown={(e) => e.key === 'Enter' && onViewFile(file)}
						title={path}
					>
						<Icon name={getFileIcon(parts.fileName) as IconName} class="w-4 h-4 shrink-0" />
						<div class="flex items-baseline gap-1.5 min-w-0 flex-1">
							<span class="text-sm font-medium truncate">{parts.fileName}</span>
							{#if parts.dirPath}
								<span
									class="text-2xs text-slate-400 dark:text-slate-500 truncate min-w-0"
									dir="rtl"
								>{parts.dirPath}</span>
							{/if}
						</div>
						<span class="w-4 text-center text-sm font-bold {getGitStatusColor(file.status)} shrink-0">{getGitStatusLabel(file.status)}</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

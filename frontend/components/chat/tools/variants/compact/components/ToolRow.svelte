<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/utils/folder-icon-mappings';
	import { requestRevealFile } from '$frontend/stores/core/files.svelte';
	import { getVisiblePanels, workspaceState } from '$frontend/stores/ui/workspace.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface DiffStat {
		additions?: number;
		deletions?: number;
	}

	interface Props {
		/** Icon for the operation (lucide icon name) */
		icon: IconName;
		/** Action label e.g. "Edited", "Read", "Ran command" */
		label: string;
		/** Full file path — triggers file pill */
		filePath?: string;
		/** Override displayed filename */
		fileName?: string;
		/** Whether the path points to a directory/folder */
		isDirectory?: boolean;
		/** Right-side meta text e.g. "lines 100 to 140" */
		meta?: string;
		/** Diff stats shown inline after file pill */
		diff?: DiffStat;
		/** Sub-detail shown as a code pill below (for search patterns, commands) */
		subDetail?: string;
		/** Extra tag chips shown after label */
		chips?: string[];
		/** Whether this row has expandable content (adds chevron) */
		expandable?: boolean;
		/** Whether the expandable content is shown */
		expanded?: boolean;
		/** Called when header row is clicked (for expandable rows) */
		onclick?: () => void;
	}

	let {
		icon,
		label,
		filePath = '',
		fileName,
		isDirectory = false,
		meta = '',
		diff,
		subDetail = '',
		chips = [],
		expandable = false,
		expanded = $bindable(false),
		onclick,
	}: Props = $props();

	const displayName = $derived(fileName || (filePath ? filePath.split(/[/\\]/).pop() || filePath : ''));
	const fileIconName = $derived.by(() => {
		if (!displayName) return 'lucide:file';
		if (isDirectory) return getFolderIcon(displayName, false) as IconName;
		return getFileIcon(displayName) as IconName;
	});
	const hasFile = $derived(Boolean(displayName));
	const hasDiff = $derived(Boolean(diff && (diff.additions || diff.deletions)));

	function handleFileClick(e: MouseEvent) {
		e.stopPropagation();
		if (!filePath) return;
		const panels = getVisiblePanels(workspaceState.layout);
		if (panels.includes('files')) requestRevealFile(filePath);
	}

	function handleRowClick() {
		if (expandable) {
			expanded = !expanded;
			onclick?.();
		}
	}
</script>

<!-- Main tool row -->
<div
	class="flex items-center gap-2 py-[3px] min-w-0 {expandable ? 'cursor-pointer' : ''}"
	role={expandable ? 'button' : undefined}
	tabindex={expandable ? 0 : undefined}
	onclick={handleRowClick}
	onkeydown={(e) => e.key === 'Enter' && handleRowClick()}
>
	<!-- Operation icon — same size as timeline dot area -->
	<span class="shrink-0 w-[14px] flex items-center justify-center text-slate-500 dark:text-slate-400">
		<Icon name={icon} class="w-[13px] h-[13px]" />
	</span>

	<!-- Row content: label + file pill + diff + meta -->
	<div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 flex-1 min-w-0">
		<!-- Action label -->
		<span class="text-[12px] text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">{label}</span>

		<!-- File pill -->
		{#if hasFile}
			<button
				type="button"
				class="inline-flex items-center gap-[5px] px-[3px] rounded border border-transparent hover:border-slate-200 dark:hover:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700/60 transition-colors shrink-0 cursor-pointer"
				onclick={handleFileClick}
				title={filePath}
			>
				<Icon name={fileIconName} class="w-[11px] h-[11px] shrink-0 {isDirectory ? 'text-amber-500 dark:text-amber-400' : 'text-red-500 dark:text-red-400'}" />
				<span class="font-mono text-[11px] font-medium text-slate-700 dark:text-slate-200 max-w-[180px] truncate">{displayName}</span>
			</button>
		{/if}

		<!-- Diff stats (inline after file pill) -->
		{#if hasDiff}
			{#if diff?.additions}
				<span class="text-[11px] font-semibold text-emerald-500 dark:text-emerald-400 shrink-0">+{diff.additions}</span>
			{/if}
			{#if diff?.deletions}
				<span class="text-[11px] font-semibold text-red-500 dark:text-red-400 shrink-0">-{diff.deletions}</span>
			{/if}
		{/if}

		<!-- Chips -->
		{#each chips as chip}
			<span class="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0 font-mono">{chip}</span>
		{/each}

		<!-- Right meta -->
		{#if meta}
			<span class="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0">{meta}</span>
		{/if}

		<!-- Expandable chevron -->
		{#if expandable}
			<Icon
				name={expanded ? 'lucide:chevron-down' : 'lucide:chevron-right'}
				class="w-3 h-3 text-slate-400 dark:text-slate-500 shrink-0 ml-auto"
			/>
		{/if}
	</div>
</div>

<!-- Sub-detail code pill (command, pattern, etc.) -->
{#if subDetail}
	<div class="pl-[22px] mt-0.5 mb-0.5">
		<code class="text-[10px] font-mono bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700/60 flex items-center max-w-full min-w-0" title={subDetail}>
			<span class="truncate">{subDetail}</span>
		</code>
	</div>
{/if}
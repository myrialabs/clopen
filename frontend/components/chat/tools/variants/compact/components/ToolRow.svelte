<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/utils/folder-icon-mappings';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
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
		/** Inline highlighted code shown within the row (patterns, commands, queries) */
		inlineCode?: string;
		/** Plain primary text shown within the row (titles, names, prose values) */
		detail?: string;
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
		inlineCode = '',
		detail = '',
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
		revealFile(filePath);
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
	class="flex items-start gap-2 py-[2px] min-w-0 {expandable ? 'cursor-pointer' : ''}"
	role={expandable ? 'button' : undefined}
	tabindex={expandable ? 0 : undefined}
	onclick={handleRowClick}
	onkeydown={(e) => e.key === 'Enter' && handleRowClick()}
>
	<!-- Operation icon — sits on the timeline rail (node masks it), top-aligned with the first line -->
	<span class="relative shrink-0 w-[14px] mt-[1px] flex items-center justify-center text-slate-500 dark:text-slate-400 z-10">
		<span class="absolute inset-0 -m-[3px] rounded bg-slate-50 dark:bg-slate-900"></span>
		<Icon name={icon} class="relative w-[13px] h-[13px]" />
	</span>

	<!-- Row content: label + file pill + diff + meta -->
	<div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 flex-1 min-w-0">
		<!-- Action label -->
		<span class="text-[12px] text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">{label}</span>

		<!-- Inline highlighted code (pattern, command, query). A single logical line stays an inline
		     pill (may wrap visually); a multi-line command becomes a per-line block on its own row. -->
		{#if inlineCode}
			{#if inlineCode.includes('\n')}
				<pre
					class="font-mono text-[11px] text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/70 rounded px-2 py-1 basis-full min-w-0 overflow-x-auto whitespace-pre leading-snug"
					title={inlineCode}>{inlineCode}</pre>
			{:else}
				<code
					class="font-mono text-[11px] text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/70 rounded px-1.5 py-[1px] min-w-0 break-all whitespace-pre-wrap leading-snug"
					title={inlineCode}
				>{inlineCode}</code>
			{/if}
		{/if}

		<!-- Plain primary detail (title, name, prose value) -->
		{#if detail}
			<span class="text-[12px] text-slate-700 dark:text-slate-200 min-w-0 break-words">{detail}</span>
		{/if}

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
			<span class="text-[10px] text-slate-400 dark:text-slate-500 min-w-0 break-all">{meta}</span>
		{/if}
	</div>
</div>
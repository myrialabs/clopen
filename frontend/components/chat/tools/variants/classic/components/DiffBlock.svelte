<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { runDiff, isDiffAbort } from '$frontend/services/diff/diff-pool';
	import type { DiffBlockRow } from '$frontend/utils/diff-block';
	import { debug } from '$shared/utils/logger';

	const MAX_LINES = 60;
	/** Every row is one `leading-5` line: whitespace-pre never wraps. */
	const ROW_HEIGHT = 20;
	/** Rows rendered beyond each edge of the viewport while scrolling. */
	const OVERSCAN = 30;

	interface Props {
		oldString: string;
		newString: string;
		label?: string;
	}

	const { oldString, newString, label }: Props = $props();

	let expanded = $state(false);
	/** null while the worker is still diffing. Raw: tens of thousands of rows, never mutated. */
	let rows = $state.raw<DiffBlockRow[] | null>(null);
	let failed = $state(false);
	let scrollTop = $state(0);
	let viewportHeight = $state(384);

	// The diff runs in the worker pool, never here: conflict previews hand this
	// whole files. A newer pair of strings, or unmounting, drops the old job.
	$effect(() => {
		const input = { oldString, newString, highlights: true };
		const controller = new AbortController();
		rows = null;
		failed = false;
		runDiff('block', input, controller.signal)
			.then((result) => {
				rows = result;
			})
			.catch((error) => {
				if (isDiffAbort(error, controller.signal)) return;
				debug.warn('chat', 'Diff block failed:', error);
				failed = true;
			});
		return () => controller.abort();
	});

	const hasChanges = $derived(rows !== null && rows.some((row) => row.type !== 'unchanged'));
	const truncated = $derived(!expanded && rows !== null && rows.length > MAX_LINES);

	/**
	 * Expanded, only the rows in view are in the DOM — a whole-file diff as one
	 * HTML string was its own way of freezing the tab, however fast the diff.
	 */
	const windowRange = $derived.by(() => {
		if (rows === null) return { start: 0, end: 0 };
		if (!expanded) return { start: 0, end: Math.min(rows.length, MAX_LINES) };
		const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
		const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
		return { start, end };
	});

	/** Widest row in characters, so the horizontal extent does not jump while scrolling. */
	const widestRow = $derived.by(() => {
		if (!expanded || rows === null) return 0;
		let widest = 0;
		for (const row of rows) {
			let width = row.content.length;
			for (let i = 0; i < row.content.length; i++) if (row.content.charCodeAt(i) === 9) width += 7;
			if (width > widest) widest = width;
		}
		return widest;
	});

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function renderLineContent(line: DiffBlockRow, colorClass: string, highlightClass: string): string {
		if (line.highlights && line.highlights.length > 0) {
			let html = '';
			const content = line.content;
			for (let idx = 0; idx < line.highlights.length; idx++) {
				const highlight = line.highlights[idx];
				if (idx === 0 && highlight.start > 0) {
					html += `<span class="${colorClass}">${escapeHtml(content.substring(0, highlight.start))}</span>`;
				}
				html += `<span class="${highlightClass}">${escapeHtml(content.substring(highlight.start, highlight.end))}</span>`;
				if (idx < line.highlights.length - 1) {
					html += `<span class="${colorClass}">${escapeHtml(content.substring(highlight.end, line.highlights[idx + 1].start))}</span>`;
				} else if (highlight.end < content.length) {
					html += `<span class="${colorClass}">${escapeHtml(content.substring(highlight.end))}</span>`;
				}
			}
			return html;
		}
		return `<span class="${colorClass}">${escapeHtml(line.content)}</span>`;
	}

	function renderRow(row: DiffBlockRow): string {
		if (row.type === 'unchanged') {
			return `<div class="relative flex"><div class="sticky left-0 w-1 bg-slate-50 dark:bg-slate-950"></div><pre class="flex-1 px-3 text-slate-600 dark:text-slate-400 whitespace-pre">${escapeHtml(row.content)}</pre></div>`;
		}
		if (row.type === 'removed') {
			return `<div class="relative flex bg-red-100 dark:bg-red-500/10"><div class="sticky left-0 w-1 bg-red-500 dark:bg-red-500/80"></div><pre class="flex-1 px-3 whitespace-pre">${renderLineContent(row, 'text-red-700 dark:text-red-300', 'bg-red-300 dark:bg-red-400/30 text-red-900 dark:text-red-100 px-0.5')}</pre></div>`;
		}
		return `<div class="relative flex bg-green-100 dark:bg-green-500/10"><div class="sticky left-0 w-1 bg-green-500 dark:bg-green-500/80"></div><pre class="flex-1 px-3 whitespace-pre">${renderLineContent(row, 'text-green-700 dark:text-green-300', 'bg-green-300 dark:bg-green-400/30 text-green-900 dark:text-green-100 px-0.5')}</pre></div>`;
	}

	const diffHtml = $derived(
		rows === null ? '' : rows.slice(windowRange.start, windowRange.end).map(renderRow).join('')
	);
</script>

<div>
	{#if label}
		<div class="flex items-center gap-2 mb-2">
			<Icon name="lucide:git-compare" class="text-violet-500 w-4 h-4" />
			<span class="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
		</div>
	{/if}

	<div
		class="relative max-h-96 bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800/60 rounded-md overflow-auto"
		bind:clientHeight={viewportHeight}
		onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
	>
		{#if rows === null}
			<div class="text-sm text-slate-500 dark:text-slate-400 px-3 py-2">
				{failed ? 'Could not compute the diff' : 'Computing diff…'}
			</div>
		{:else if hasChanges}
			<div
				class="text-xs font-mono leading-5 min-w-fit"
				style:min-width={expanded ? `calc(${widestRow}ch + 1.75rem)` : undefined}
			>
				{#if expanded}<div style:height="{windowRange.start * ROW_HEIGHT}px"></div>{/if}
				{@html diffHtml}
				{#if expanded}<div style:height="{(rows.length - windowRange.end) * ROW_HEIGHT}px"></div>{/if}
			</div>
			{#if truncated}
				<button
					onclick={() => expanded = true}
					class="w-full flex text-xs text-violet-600 dark:text-violet-400 px-3 py-2 border-t border-slate-200/60 dark:border-slate-800/60 hover:underline cursor-pointer"
				>
					Show all {rows.length} lines ({rows.length - MAX_LINES} more)
				</button>
			{/if}
		{:else}
			<div class="text-sm text-slate-600 dark:text-slate-400">
				No changes detected
			</div>
		{/if}
	</div>
</div>
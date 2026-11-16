<script lang="ts">
	import { runDiff, isDiffAbort } from '$frontend/services/diff/diff-pool';
	import type { DiffBlockRow } from '$frontend/utils/diff-block';
	import { debug } from '$shared/utils/logger';

	const MAX_LINES = 40;
	/** Every row is one `leading-4` line: whitespace-pre never wraps. */
	const ROW_HEIGHT = 16;
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
	let viewportHeight = $state(192);

	// The diff runs in the worker pool, never here. A newer pair of strings, or
	// unmounting, drops the old job.
	$effect(() => {
		const input = { oldString, newString, highlights: false };
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

	/** Expanded, only the rows in view are in the DOM. */
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
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function renderRow(row: DiffBlockRow): string {
		if (row.type === 'unchanged') {
			return `<div class="px-2 text-slate-500 dark:text-slate-500 whitespace-pre">${escapeHtml(row.content)}</div>`;
		}
		if (row.type === 'removed') {
			return `<div class="px-2 bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-300 whitespace-pre border-l border-red-400">${escapeHtml(row.content)}</div>`;
		}
		return `<div class="px-2 bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-300 whitespace-pre border-l border-green-400">${escapeHtml(row.content)}</div>`;
	}

	const diffHtml = $derived(
		rows === null ? '' : rows.slice(windowRange.start, windowRange.end).map(renderRow).join('')
	);
</script>

<div>
	{#if label}
		<span class="text-xs text-slate-400 dark:text-slate-500 mb-0.5 block">{label}:</span>
	{/if}
	<div
		class="max-h-48 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded overflow-auto"
		bind:clientHeight={viewportHeight}
		onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
	>
		{#if rows === null}
			<p class="text-xs text-slate-400 px-2 py-1">{failed ? 'Could not compute the diff' : 'Computing diff…'}</p>
		{:else if hasChanges}
			<div
				class="text-xs font-mono leading-4 min-w-fit"
				style:min-width={expanded ? `calc(${widestRow}ch + 1.125rem)` : undefined}
			>
				{#if expanded}<div style:height="{windowRange.start * ROW_HEIGHT}px"></div>{/if}
				{@html diffHtml}
				{#if expanded}<div style:height="{(rows.length - windowRange.end) * ROW_HEIGHT}px"></div>{/if}
			</div>
			{#if truncated}
				<button onclick={() => expanded = true} class="text-xs text-slate-500 px-2 py-1 hover:underline">
					+{rows.length - MAX_LINES} more lines
				</button>
			{/if}
		{:else}
			<p class="text-xs text-slate-400 px-2 py-1">No changes</p>
		{/if}
	</div>
</div>

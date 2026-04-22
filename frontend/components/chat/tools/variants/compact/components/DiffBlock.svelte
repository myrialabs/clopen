<script lang="ts">
	import { removeCommonIndentationFromLines } from '../../../../shared/utils';

	const MAX_LINES = 40;

	interface Props {
		oldString: string;
		newString: string;
		label?: string;
	}

	interface DiffLine {
		type: 'unchanged' | 'removed' | 'added';
		content: string;
	}

	interface GroupedDiff {
		type: 'unchanged' | 'change';
		removed?: DiffLine[];
		added?: DiffLine[];
		lines?: DiffLine[];
	}

	const { oldString, newString, label }: Props = $props();

	let expanded = $state(false);

	function findLCS(arr1: string[], arr2: string[]): number[][] {
		const m = arr1.length;
		const n = arr2.length;
		const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				dp[i][j] = arr1[i - 1] === arr2[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
		return dp;
	}

	function computeDiff(oldStr: string, newStr: string): GroupedDiff[] {
		const oldLines = oldStr.split('\n');
		const newLines = newStr.split('\n');
		const { lines: cleanOld } = removeCommonIndentationFromLines(oldLines);
		const { lines: cleanNew } = removeCommonIndentationFromLines(newLines);
		const dp = findLCS(cleanOld, cleanNew);
		const diffLines: DiffLine[] = [];
		let i = cleanOld.length, j = cleanNew.length;
		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && cleanOld[i - 1] === cleanNew[j - 1]) {
				diffLines.unshift({ type: 'unchanged', content: cleanOld[i - 1] }); i--; j--;
			} else if (j === 0 || (i > 0 && dp[i][j] === dp[i - 1][j])) {
				diffLines.unshift({ type: 'removed', content: cleanOld[i - 1] }); i--;
			} else {
				diffLines.unshift({ type: 'added', content: cleanNew[j - 1] }); j--;
			}
		}
		const grouped: GroupedDiff[] = [];
		let current: GroupedDiff | null = null;
		for (const line of diffLines) {
			if (line.type === 'unchanged') {
				if (current) { grouped.push(current); current = null; }
				grouped.push({ type: 'unchanged', lines: [line] });
			} else {
				if (!current) current = { type: 'change', removed: [], added: [] };
				if (line.type === 'removed') current.removed!.push(line); else current.added!.push(line);
			}
		}
		if (current) grouped.push(current);
		return grouped;
	}

	function escapeHtml(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function renderDiffHtml(groups: GroupedDiff[]): string {
		let html = '';
		for (const group of groups) {
			if (group.type === 'unchanged') {
				for (const line of group.lines || []) {
					html += `<div class="px-2 text-slate-500 dark:text-slate-500 whitespace-pre">${escapeHtml(line.content)}</div>`;
				}
			} else {
				for (const line of group.removed || []) {
					html += `<div class="px-2 bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-300 whitespace-pre border-l border-red-400">${escapeHtml(line.content)}</div>`;
				}
				for (const line of group.added || []) {
					html += `<div class="px-2 bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-300 whitespace-pre border-l border-green-400">${escapeHtml(line.content)}</div>`;
				}
			}
		}
		return html;
	}

	const diffGroups = $derived(computeDiff(oldString, newString));
	const hasChanges = $derived(diffGroups.some(g => g.type === 'change'));

	const displayData = $derived.by(() => {
		if (expanded) return { groups: diffGroups, truncated: false, totalLines: 0 };
		let total = 0;
		for (const g of diffGroups) {
			total += g.type === 'unchanged' ? (g.lines?.length ?? 0) : (g.removed?.length ?? 0) + (g.added?.length ?? 0);
		}
		if (total <= MAX_LINES) return { groups: diffGroups, truncated: false, totalLines: total };
		let count = 0;
		const truncated: GroupedDiff[] = [];
		for (const g of diffGroups) {
			const gLen = g.type === 'unchanged' ? (g.lines?.length ?? 0) : (g.removed?.length ?? 0) + (g.added?.length ?? 0);
			const rem = MAX_LINES - count;
			if (rem <= 0) break;
			if (gLen <= rem) { truncated.push(g); count += gLen; }
			else {
				if (g.type === 'unchanged') truncated.push({ type: 'unchanged', lines: g.lines!.slice(0, rem) });
				else truncated.push({ type: 'change', removed: g.removed!.slice(0, rem), added: [] });
				count += rem; break;
			}
		}
		return { groups: truncated, truncated: true, totalLines: total };
	});

	const diffHtml = $derived(renderDiffHtml(displayData.groups));
</script>

<div>
	{#if label}
		<span class="text-xs text-slate-400 dark:text-slate-500 mb-0.5 block">{label}:</span>
	{/if}
	<div class="max-h-48 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded overflow-auto">
		{#if hasChanges}
			<div class="text-xs font-mono leading-4 min-w-fit">{@html diffHtml}</div>
			{#if displayData.truncated}
				<button onclick={() => expanded = true} class="text-xs text-slate-500 px-2 py-1 hover:underline">
					+{displayData.totalLines - MAX_LINES} more lines
				</button>
			{/if}
		{:else}
			<p class="text-xs text-slate-400 px-2 py-1">No changes</p>
		{/if}
	</div>
</div>

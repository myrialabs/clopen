<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { removeCommonIndentationFromLines } from '../../shared/utils';

	interface Props {
		oldString: string;
		newString: string;
		label?: string;
	}

	interface DiffLine {
		type: 'unchanged' | 'removed' | 'added';
		content: string;
		highlights?: Array<{ start: number; end: number }>;
	}

	interface GroupedDiff {
		type: 'unchanged' | 'change';
		removed?: DiffLine[];
		added?: DiffLine[];
		lines?: DiffLine[];
	}

	const { oldString, newString, label }: Props = $props();

	// Myers diff algorithm for finding longest common subsequence
	function findLCS(arr1: string[], arr2: string[]): number[][] {
		const m = arr1.length;
		const n = arr2.length;
		const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (arr1[i - 1] === arr2[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
				} else {
					dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
				}
			}
		}

		return dp;
	}

	// Character-level diff for highlighting specific changes within lines
	function findCharacterDiff(oldLine: string, newLine: string): { oldHighlights: Array<{ start: number; end: number }>, newHighlights: Array<{ start: number; end: number }> } {
		// Use patience diff algorithm for better results
		const oldHighlights: Array<{ start: number; end: number }> = [];
		const newHighlights: Array<{ start: number; end: number }> = [];

		// Find common prefix
		let prefixLen = 0;
		const minLen = Math.min(oldLine.length, newLine.length);
		while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) {
			prefixLen++;
		}

		// Find common suffix
		let suffixLen = 0;
		const maxSuffixLen = minLen - prefixLen;
		while (suffixLen < maxSuffixLen &&
			   oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]) {
			suffixLen++;
		}

		// Extract the differing middle parts
		const oldMiddleStart = prefixLen;
		const oldMiddleEnd = oldLine.length - suffixLen;
		const newMiddleStart = prefixLen;
		const newMiddleEnd = newLine.length - suffixLen;

		if (oldMiddleStart < oldMiddleEnd || newMiddleStart < newMiddleEnd) {
			// There are differences
			const oldMiddle = oldLine.substring(oldMiddleStart, oldMiddleEnd);
			const newMiddle = newLine.substring(newMiddleStart, newMiddleEnd);

			// If the middle parts are completely different or one is empty, highlight the whole middle
			if (oldMiddle.length === 0 || newMiddle.length === 0 ||
				!hasCommonSubstring(oldMiddle, newMiddle)) {
				if (oldMiddle.length > 0) {
					oldHighlights.push({ start: oldMiddleStart, end: oldMiddleEnd });
				}
				if (newMiddle.length > 0) {
					newHighlights.push({ start: newMiddleStart, end: newMiddleEnd });
				}
			} else {
				// Find fine-grained differences using recursive approach
				const middleDiff = findFineDiff(oldMiddle, newMiddle);

				// Adjust positions relative to full string
				for (const range of middleDiff.oldRanges) {
					oldHighlights.push({
						start: oldMiddleStart + range.start,
						end: oldMiddleStart + range.end
					});
				}
				for (const range of middleDiff.newRanges) {
					newHighlights.push({
						start: newMiddleStart + range.start,
						end: newMiddleStart + range.end
					});
				}
			}
		}

		return { oldHighlights, newHighlights };
	}

	// Helper function to check if strings have common substrings
	function hasCommonSubstring(str1: string, str2: string, minLength: number = 3): boolean {
		if (str1.length < minLength || str2.length < minLength) return false;

		for (let i = 0; i <= str1.length - minLength; i++) {
			const substr = str1.substring(i, i + minLength);
			if (str2.includes(substr)) return true;
		}
		return false;
	}

	// Fine-grained diff for the middle differing part
	function findFineDiff(oldStr: string, newStr: string): {
		oldRanges: Array<{ start: number; end: number }>,
		newRanges: Array<{ start: number; end: number }>
	} {
		const oldRanges: Array<{ start: number; end: number }> = [];
		const newRanges: Array<{ start: number; end: number }> = [];

		// Use word-based chunking for better diff
		const oldChunks = splitIntoChunks(oldStr);
		const newChunks = splitIntoChunks(newStr);

		// Find LCS of chunks
		const dp = findLCS(oldChunks.map(c => c.text), newChunks.map(c => c.text));

		let i = oldChunks.length;
		let j = newChunks.length;

		// Backtrack to find differences
		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && oldChunks[i - 1].text === newChunks[j - 1].text) {
				// Chunks match
				i--;
				j--;
			} else if (j === 0 || (i > 0 && dp[i][j] === dp[i - 1][j])) {
				// Chunk deleted from old
				const chunk = oldChunks[i - 1];
				oldRanges.unshift({ start: chunk.start, end: chunk.end });
				i--;
			} else {
				// Chunk added to new
				const chunk = newChunks[j - 1];
				newRanges.unshift({ start: chunk.start, end: chunk.end });
				j--;
			}
		}

		// Merge adjacent ranges
		return {
			oldRanges: mergeRanges(oldRanges),
			newRanges: mergeRanges(newRanges)
		};
	}

	// Split string into chunks (words and delimiters)
	function splitIntoChunks(str: string): Array<{ text: string; start: number; end: number }> {
		const chunks: Array<{ text: string; start: number; end: number }> = [];
		const regex = /(\w+|[^\w]+)/g;
		let match;

		while ((match = regex.exec(str)) !== null) {
			chunks.push({
				text: match[0],
				start: match.index,
				end: match.index + match[0].length
			});
		}

		return chunks;
	}

	// Merge adjacent or overlapping ranges
	function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
		if (ranges.length === 0) return [];

		ranges.sort((a, b) => a.start - b.start);
		const merged: Array<{ start: number; end: number }> = [];
		let current = ranges[0];

		for (let i = 1; i < ranges.length; i++) {
			const next = ranges[i];
			if (next.start <= current.end) {
				// Merge overlapping or adjacent regions
				current = { start: current.start, end: Math.max(current.end, next.end) };
			} else {
				merged.push(current);
				current = next;
			}
		}
		merged.push(current);

		return merged;
	}

	function computeDiff(oldStr: string, newStr: string): GroupedDiff[] {
		const oldLines = oldStr.split('\n');
		const newLines = newStr.split('\n');

		// Remove common indentation from both old and new strings
		const { lines: cleanOldLines } = removeCommonIndentationFromLines(oldLines);
		const { lines: cleanNewLines } = removeCommonIndentationFromLines(newLines);

		// Compute line-level diff using LCS
		const dp = findLCS(cleanOldLines, cleanNewLines);

		const diffLines: DiffLine[] = [];
		let i = cleanOldLines.length;
		let j = cleanNewLines.length;

		// Backtrack to generate diff
		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && cleanOldLines[i - 1] === cleanNewLines[j - 1]) {
				diffLines.unshift({ type: 'unchanged', content: cleanOldLines[i - 1] });
				i--;
				j--;
			} else if (j === 0 || (i > 0 && dp[i][j] === dp[i - 1][j])) {
				diffLines.unshift({ type: 'removed', content: cleanOldLines[i - 1] });
				i--;
			} else {
				diffLines.unshift({ type: 'added', content: cleanNewLines[j - 1] });
				j--;
			}
		}

		// Group consecutive changes and apply character-level diff
		const grouped: GroupedDiff[] = [];
		let current: GroupedDiff | null = null;

		for (const line of diffLines) {
			if (line.type === 'unchanged') {
				if (current) {
					grouped.push(current);
					current = null;
				}
				grouped.push({ type: 'unchanged', lines: [line] });
			} else {
				if (!current) {
					current = { type: 'change', removed: [], added: [] };
				}
				if (line.type === 'removed') {
					current.removed!.push(line);
				} else {
					current.added!.push(line);
				}
			}
		}

		if (current) {
			grouped.push(current);
		}

		// Apply character-level diff to changed line pairs
		for (const group of grouped) {
			if (group.type === 'change' && group.removed && group.added) {
				const minLen = Math.min(group.removed.length, group.added.length);

				// For paired lines, compute character-level diff
				for (let idx = 0; idx < minLen; idx++) {
					const oldLine = group.removed[idx];
					const newLine = group.added[idx];

					// Only compute character diff if lines are similar enough
					if (oldLine.content.length > 0 && newLine.content.length > 0) {
						const similarity = computeSimilarity(oldLine.content, newLine.content);
						if (similarity > 0.3) { // Lines are at least 30% similar
							const { oldHighlights, newHighlights } = findCharacterDiff(oldLine.content, newLine.content);
							if (oldHighlights.length > 0) {
								oldLine.highlights = oldHighlights;
							}
							if (newHighlights.length > 0) {
								newLine.highlights = newHighlights;
							}
						}
					}
				}
			}
		}

		return grouped;
	}

	// Compute similarity ratio between two strings
	function computeSimilarity(str1: string, str2: string): number {
		const chars1 = str1.split('');
		const chars2 = str2.split('');
		const dp = findLCS(chars1, chars2);
		const lcsLength = dp[chars1.length][chars2.length];
		const maxLen = Math.max(chars1.length, chars2.length);
		return maxLen === 0 ? 0 : lcsLength / maxLen;
	}

	// Render text with highlights
	function renderLineWithHighlights(line: DiffLine): string {
		if (!line.highlights || line.highlights.length === 0) {
			return line.content;
		}

		let result = '';
		let lastEnd = 0;

		for (const highlight of line.highlights) {
			// Add non-highlighted part
			if (highlight.start > lastEnd) {
				result += line.content.substring(lastEnd, highlight.start);
			}
			// Add highlighted part with special marker
			result += '{{HIGHLIGHT_START}}' + line.content.substring(highlight.start, highlight.end) + '{{HIGHLIGHT_END}}';
			lastEnd = highlight.end;
		}

		// Add any remaining non-highlighted part
		if (lastEnd < line.content.length) {
			result += line.content.substring(lastEnd);
		}

		return result;
	}

	const diffGroups = computeDiff(oldString, newString);
	const hasChanges = diffGroups.some(group => group.type === 'change');
</script>

<div>
	{#if label}
		<div class="flex items-center gap-2 mb-2">
			<Icon name="lucide:git-compare" class="text-violet-500 w-4 h-4" />
			<span class="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
		</div>
	{/if}

	<div class="relative max-h-96 bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800/60 rounded-md overflow-auto">
		{#if hasChanges}
			<div class="text-xs font-mono leading-5 min-w-fit"><!--
			-->{#each diffGroups as group}<!--
				-->{#if group.type === 'unchanged'}<!--
					-->{#each group.lines || [] as line}<!--
				--><div class="relative flex"><!--
					--><div class="sticky left-0 w-1 bg-slate-50 dark:bg-slate-950"></div><!--
					--><pre class="flex-1 px-3 text-slate-600 dark:text-slate-400 whitespace-pre">{line.content}</pre><!--
				--></div><!--
					-->{/each}<!--
				-->{:else if group.type === 'change'}<!--
					-->{#each group.removed || [] as line}<!--
				--><div class="relative flex bg-red-100 dark:bg-red-500/10"><!--
					--><div class="sticky left-0 w-1 bg-red-500 dark:bg-red-500/80"></div><!--
					--><pre class="flex-1 px-3 whitespace-pre"><!--
						-->{#if line.highlights && line.highlights.length > 0}<!--
							-->{@const rendered = line.content}<!--
							-->{#each line.highlights as highlight, idx}<!--
								-->{#if idx === 0 && highlight.start > 0}<!--
									--><span class="text-red-700 dark:text-red-300">{rendered.substring(0, highlight.start)}</span><!--
								-->{/if}<!--
								--><span class="bg-red-300 dark:bg-red-400/30 text-red-900 dark:text-red-100 px-0.5">{rendered.substring(highlight.start, highlight.end)}</span><!--
								-->{#if idx < line.highlights.length - 1}<!--
									--><span class="text-red-700 dark:text-red-300">{rendered.substring(highlight.end, line.highlights[idx + 1].start)}</span><!--
								-->{:else if highlight.end < rendered.length}<!--
									--><span class="text-red-700 dark:text-red-300">{rendered.substring(highlight.end)}</span><!--
								-->{/if}<!--
							-->{/each}<!--
						-->{:else}<!--
							--><span class="text-red-700 dark:text-red-300">{line.content}</span><!--
						-->{/if}<!--
					--></pre><!--
				--></div><!--
					-->{/each}<!--
					-->{#each group.added || [] as line}<!--
				--><div class="relative flex bg-green-100 dark:bg-green-500/10"><!--
					--><div class="sticky left-0 w-1 bg-green-500 dark:bg-green-500/80"></div><!--
					--><pre class="flex-1 px-3 whitespace-pre"><!--
						-->{#if line.highlights && line.highlights.length > 0}<!--
							-->{@const rendered = line.content}<!--
							-->{#each line.highlights as highlight, idx}<!--
								-->{#if idx === 0 && highlight.start > 0}<!--
									--><span class="text-green-700 dark:text-green-300">{rendered.substring(0, highlight.start)}</span><!--
								-->{/if}<!--
								--><span class="bg-green-300 dark:bg-green-400/30 text-green-900 dark:text-green-100 px-0.5">{rendered.substring(highlight.start, highlight.end)}</span><!--
								-->{#if idx < line.highlights.length - 1}<!--
									--><span class="text-green-700 dark:text-green-300">{rendered.substring(highlight.end, line.highlights[idx + 1].start)}</span><!--
								-->{:else if highlight.end < rendered.length}<!--
									--><span class="text-green-700 dark:text-green-300">{rendered.substring(highlight.end)}</span><!--
								-->{/if}<!--
							-->{/each}<!--
						-->{:else}<!--
							--><span class="text-green-700 dark:text-green-300">{line.content}</span><!--
						-->{/if}<!--
					--></pre><!--
				--></div>
<!--
					-->{/each}<!--
				-->{/if}<!--
			-->{/each}<!--
			--></div>
		{:else}
			<div class="text-sm text-slate-600 dark:text-slate-400">
				No changes detected
			</div>
		{/if}
	</div>
</div>
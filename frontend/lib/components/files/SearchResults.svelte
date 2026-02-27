<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/lib/utils/folder-icon-mappings';
	import { normalizePath } from '$shared/utils/path';
	import type { IconName } from '$shared/types/ui/icons';

	interface FileSearchResult {
		name: string;
		type: 'file' | 'directory';
		path: string;
		relativePath: string;
		size?: number;
		modified: string;
		extension?: string;
		score?: number;
	}

	interface CodeMatch {
		line: number;
		column: number;
		text: string;
		beforeContext?: string;
		afterContext?: string;
	}

	interface CodeSearchResult {
		file: string;
		relativePath: string;
		matches: CodeMatch[];
		totalMatches: number;
	}

	interface Props {
		mode?: 'files' | 'code';
		query?: string;
		fileResults?: FileSearchResult[];
		codeResults?: CodeSearchResult[];
		isLoading?: boolean;
		useRegex?: boolean;
		onFileClick?: (file: FileSearchResult) => void;
		onCodeMatchClick?: (result: CodeSearchResult, match: CodeMatch) => void;
	}

	const {
		mode = 'files',
		query = '',
		fileResults = [],
		codeResults = [],
		isLoading = false,
		useRegex = false,
		onFileClick,
		onCodeMatchClick
	}: Props = $props();

	// Track how many matches to show per file (initially 10)
	const INITIAL_SHOW = 10;
	const LOAD_MORE_STEP = 20;
	let showCountMap = $state(new Map<string, number>());

	// Reset show counts when results change
	$effect(() => {
		// Reading codeResults to track it
		if (codeResults) {
			showCountMap = new Map();
		}
	});

	function getShowCount(key: string): number {
		return showCountMap.get(key) || INITIAL_SHOW;
	}

	function handleShowMore(key: string, matchesLength: number) {
		const current = getShowCount(key);
		const next = Math.min(current + LOAD_MORE_STEP, matchesLength);
		showCountMap.set(key, next);
		showCountMap = new Map(showCountMap);
	}

	function getDisplayIcon(fileName: string, isDirectory: boolean): IconName {
		if (isDirectory) {
			return getFolderIcon(fileName, false);
		}
		return getFileIcon(fileName);
	}

	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}

	function escapeHtml(str: string): string {
		return str
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	// Highlight match for file search (highlights first occurrence only)
	function highlightFileName(text: string, q: string): string {
		if (!q) return escapeHtml(text);
		const escaped = escapeHtml(text);
		const escapedQuery = escapeHtml(q);
		try {
			const regex = new RegExp(`(${escapeRegex(escapedQuery)})`, 'i');
			return escaped.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-600/50 text-slate-900 dark:text-slate-100 rounded-sm px-0.5">$1</mark>');
		} catch {
			return escaped;
		}
	}

	// Render code match snippet with highlight at specific column position
	function renderMatchSnippet(text: string, q: string, column: number, isRegex: boolean): string {
		const maxLength = 35;
		const matchStart = Math.max(0, column - 1); // 0-based

		// Find actual match length
		let matchLength = q.length;
		if (isRegex) {
			try {
				const regex = new RegExp(q);
				const m = text.substring(matchStart).match(regex);
				if (m) matchLength = m[0].length;
			} catch {
				matchLength = q.length;
			}
		}

		// Validate position
		if (matchStart >= text.length) {
			const truncated = text.trim().substring(0, maxLength);
			return escapeHtml(truncated) + (text.trim().length > maxLength ? '…' : '');
		}

		// Calculate window around the match
		const contextSize = Math.floor((maxLength - matchLength) / 2);
		let start = Math.max(0, matchStart - contextSize);
		let end = Math.min(text.length, matchStart + matchLength + contextSize);

		// Adjust boundaries
		if (start === 0) {
			end = Math.min(text.length, maxLength);
		} else if (end === text.length) {
			start = Math.max(0, text.length - maxLength);
		}

		// Build parts
		const prefix = start > 0 ? '…' : '';
		const suffix = end < text.length ? '…' : '';

		const before = escapeHtml(text.substring(start, matchStart)).trim();
		const matched = escapeHtml(text.substring(matchStart, matchStart + matchLength));
		const after = escapeHtml(text.substring(matchStart + matchLength, end)).trim();

		return `${prefix}${before}<mark class="bg-yellow-200 dark:bg-yellow-600/50 text-slate-900 dark:text-slate-100 rounded-sm px-0.5">${matched}</mark>${after}${suffix}`;
	}

	// Extract filename from path
	function getFileName(filePath: string): string {
		return filePath.split(/[/\\]/).pop() || filePath;
	}
</script>

<div class="flex flex-col h-full overflow-hidden">
	{#if isLoading}
		<div class="flex flex-col items-center justify-center flex-1 space-y-3 py-12 px-3">
			<div class="w-8 h-8 border-2 border-violet-600 border-t-transparent rounded-full animate-spin"></div>
			<p class="text-sm text-slate-600 dark:text-slate-400 font-medium">
				Searching {mode === 'files' ? 'files' : 'code'}...
			</p>
		</div>
	{:else if mode === 'files'}
		{#if fileResults.length === 0}
			<div class="flex flex-col items-center justify-center flex-1 space-y-3 py-12 px-3">
				<div class="w-12 h-12 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
					<Icon name="lucide:search-x" class="w-6 h-6 text-slate-500" />
				</div>
				<p class="text-sm text-slate-600 dark:text-slate-400 text-center">
					{query ? `No files found for "${query}"` : 'Enter a search query'}
				</p>
			</div>
		{:else}
			<div class="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
				<p class="text-xs text-slate-600 dark:text-slate-400 font-medium">
					{fileResults.length} {fileResults.length === 1 ? 'result' : 'results'}
				</p>
			</div>

			<div class="flex-1 overflow-auto space-y-0.5 p-2">
				{#each fileResults as result (result.path)}
					<button
						class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-left group"
						title={normalizePath(result.relativePath)}
						onclick={() => onFileClick?.(result)}
					>
						<span class="flex-shrink-0">
							<Icon name={getDisplayIcon(result.name, result.type === 'directory')} />
						</span>

						<div class="flex-1 min-w-0">
							<p class="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">
								{@html highlightFileName(result.name, query)}
							</p>
							<p class="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">
								{normalizePath(result.relativePath)}
							</p>
						</div>

						{#if result.type === 'file' && result.size}
							<span class="flex-shrink-0 text-xs text-slate-400 dark:text-slate-500">
								{formatFileSize(result.size)}
							</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	{:else}
		{#if codeResults.length === 0}
			<div class="flex flex-col items-center justify-center flex-1 space-y-3 py-12 px-3">
				<div class="w-12 h-12 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center">
					<Icon name="lucide:search-x" class="w-6 h-6 text-slate-500" />
				</div>
				<p class="text-sm text-slate-600 dark:text-slate-400 text-center">
					{query ? `No code matches found for "${query}"` : 'Enter a search query'}
				</p>
			</div>
		{:else}
			<div class="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
				<p class="text-xs text-slate-600 dark:text-slate-400 font-medium">
					{codeResults.length} {codeResults.length === 1 ? 'file' : 'files'} · {codeResults.reduce((sum, r) => sum + (r.totalMatches || r.matches.length), 0)}
				</p>
			</div>

			<div class="flex-1 overflow-auto space-y-2 p-2">
				{#each codeResults as result (normalizePath(result.relativePath))}
					{@const resultKey = normalizePath(result.relativePath)}
					{@const visibleCount = getShowCount(resultKey)}
					{@const visibleMatches = result.matches.slice(0, visibleCount)}
					{@const hiddenInArray = result.matches.length - visibleCount}
					{@const hiddenTotal = (result.totalMatches || result.matches.length) - visibleCount}
					<div class="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden bg-white dark:bg-slate-800/50">
						<!-- File header: icon + filename + path + count in 1 line -->
						<div class="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
							<div class="flex items-center gap-2">
								<Icon name={getFileIcon(result.file)} class="flex-shrink-0 w-4 h-4" />
								<p class="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">
									{getFileName(result.file)}
								</p>
								<p class="text-xs text-slate-400 dark:text-slate-500 truncate font-mono flex-1 min-w-0">
									{resultKey}
								</p>
								<span class="flex-shrink-0 text-xs text-violet-600 dark:text-violet-400 font-bold tabular-nums">
									{result.totalMatches || result.matches.length}
								</span>
							</div>
						</div>

						<div class="divide-y divide-slate-100 dark:divide-slate-700/50">
							{#each visibleMatches as match (match.line + ':' + match.column)}
								<button
									class="w-full px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors text-left"
									onclick={() => onCodeMatchClick?.(result, match)}
								>
									<div class="flex items-center gap-2">
										<span class="flex-shrink-0 text-xs text-slate-400 dark:text-slate-500 font-mono w-8 text-right tabular-nums">
											{match.line}
										</span>
										<span class="flex-1 min-w-0 text-xs text-slate-600 dark:text-slate-400 font-mono truncate">{@html renderMatchSnippet(match.text, query, match.column, useRegex)}</span>
									</div>
								</button>
							{/each}

							{#if hiddenTotal > 0}
								<button
									class="w-full px-3 py-1.5 text-center hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors cursor-pointer"
									onclick={() => handleShowMore(resultKey, result.matches.length)}
								>
									<p class="text-xs text-violet-600 dark:text-violet-400 font-medium">
										{#if hiddenInArray > 0}
											Show {Math.min(LOAD_MORE_STEP, hiddenInArray)} more ({hiddenTotal} remaining)
										{:else}
											+{hiddenTotal} more (not loaded)
										{/if}
									</p>
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

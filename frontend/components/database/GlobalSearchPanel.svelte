<script lang="ts">
	import { fade, slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbGlobalSearchState,
		closeGlobalSearch,
		runGlobalSearch,
		fetchSuggestions,
		clearSuggestions,
		focusMatch
	} from '$frontend/stores/features/db-global-search.svelte';
	import { selectTable, dbManagerState, setFilters } from '$frontend/stores/features/db-manager.svelte';
	import type { GlobalSearchMatch } from '$shared/types/db-manager';
	import type { GlobalSearchSuggestion } from '$frontend/stores/features/db-global-search.svelte';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	let queryInput = $state('');
	let inputRef: HTMLInputElement | undefined = $state();
	let showSuggestions = $state(false);
	let highlightedSuggestionIdx = $state(-1);

	// Debounce timers
	let suggestTimer: ReturnType<typeof setTimeout> | null = null;
	let searchTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Derived ────────────────────────────────────────────────────────────────

	const groupedMatches = $derived(() => {
		if (!dbGlobalSearchState.result) return [];
		const map = new Map<string, { tableName: string; tableSchema?: string; pkColumn?: string; matches: GlobalSearchMatch[] }>();
		for (const match of dbGlobalSearchState.result.matches) {
			const key = match.tableSchema ? `${match.tableSchema}.${match.tableName}` : match.tableName;
			if (!map.has(key)) {
				map.set(key, { tableName: match.tableName, tableSchema: match.tableSchema, pkColumn: match.pkColumn, matches: [] });
			}
			map.get(key)!.matches.push(match);
		}
		return Array.from(map.values());
	});

	const totalMatches = $derived(dbGlobalSearchState.result?.matches.length ?? 0);
	const suggestions = $derived(dbGlobalSearchState.suggestions);

	// ─── Input handling ─────────────────────────────────────────────────────────

	function handleInput() {
		highlightedSuggestionIdx = -1;

		// Cancel pending timers
		if (suggestTimer) clearTimeout(suggestTimer);
		if (searchTimer) clearTimeout(searchTimer);

		const q = queryInput.trim();

		if (!q) {
			clearSuggestions();
			showSuggestions = false;
			return;
		}

		showSuggestions = true;

		// Suggestions: 220ms debounce (fast)
		suggestTimer = setTimeout(() => {
			fetchSuggestions(connectionId, q);
		}, 220);

		// Auto-search: 500ms debounce (after typing slows)
		if (q.length >= 2) {
			searchTimer = setTimeout(async () => {
				showSuggestions = false;
				dbGlobalSearchState.query = q;
				await runGlobalSearch(connectionId, q);
			}, 500);
		}
	}

	function handleInputKeydown(e: KeyboardEvent) {
		if (!showSuggestions || !suggestions.length) {
			if (e.key === 'Escape') closeGlobalSearch();
			return;
		}

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlightedSuggestionIdx = Math.min(highlightedSuggestionIdx + 1, suggestions.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlightedSuggestionIdx = Math.max(highlightedSuggestionIdx - 1, -1);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (highlightedSuggestionIdx >= 0) {
				applySuggestion(suggestions[highlightedSuggestionIdx]);
			} else {
				commitSearch();
			}
		} else if (e.key === 'Escape') {
			showSuggestions = false;
			highlightedSuggestionIdx = -1;
		}
	}

	function applySuggestion(s: GlobalSearchSuggestion) {
		if (suggestTimer) clearTimeout(suggestTimer);
		if (searchTimer) clearTimeout(searchTimer);
		queryInput = s.value;
		showSuggestions = false;
		highlightedSuggestionIdx = -1;
		commitSearch();
	}

	async function commitSearch() {
		if (suggestTimer) clearTimeout(suggestTimer);
		if (searchTimer) clearTimeout(searchTimer);
		const q = queryInput.trim();
		if (!q) return;
		showSuggestions = false;
		dbGlobalSearchState.query = q;
		await runGlobalSearch(connectionId, q);
	}

	async function handleFormSubmit(e: SubmitEvent) {
		e.preventDefault();
		await commitSearch();
	}

	// ─── Result navigation ───────────────────────────────────────────────────────

	async function handleNavigate(match: GlobalSearchMatch) {
		focusMatch(match);
		closeGlobalSearch();
		await selectTable(match.tableName, match.tableSchema);
		if (match.pkColumn) {
			const pkVal = match.row[match.pkColumn];
			if (pkVal !== null && pkVal !== undefined) {
				await setFilters([{ column: match.pkColumn, operator: 'eq', value: String(pkVal) }]);
			}
		}
	}

	// ─── Highlight helpers ──────────────────────────────────────────────────────

	function getColumnPreview(match: GlobalSearchMatch): string {
		const val = match.row[match.columnName];
		if (val === null || val === undefined) return '';
		const str = String(val);
		const q = dbGlobalSearchState.result?.query ?? '';
		if (!q) return str.slice(0, 80);
		const idx = str.toLowerCase().indexOf(q.toLowerCase());
		if (idx === -1) return str.slice(0, 80);
		const start = Math.max(0, idx - 30);
		const end = Math.min(str.length, idx + q.length + 50);
		return (start > 0 ? '…' : '') + str.slice(start, end) + (end < str.length ? '…' : '');
	}

	function highlight(text: string, q: string): string {
		if (!q) return escapeHtml(text);
		const idx = text.toLowerCase().indexOf(q.toLowerCase());
		if (idx === -1) return escapeHtml(text);
		return (
			escapeHtml(text.slice(0, idx)) +
			`<mark class="bg-amber-200 dark:bg-amber-700/60 text-amber-900 dark:text-amber-100 rounded px-0.5">${escapeHtml(text.slice(idx, idx + q.length))}</mark>` +
			escapeHtml(text.slice(idx + q.length))
		);
	}

	function escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function getPkValue(match: GlobalSearchMatch): unknown {
		if (!match.pkColumn) return null;
		return match.row[match.pkColumn] ?? null;
	}

	// ─── Window keydown ─────────────────────────────────────────────────────────

	function handleWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !showSuggestions) closeGlobalSearch();
	}

	// Focus input on open
	$effect(() => {
		if (dbGlobalSearchState.isOpen && inputRef) {
			setTimeout(() => inputRef?.focus(), 50);
		}
	});
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
	class="fixed inset-0 z-[200] flex items-start justify-center pt-16 px-4"
	in:fade={{ duration: 150, easing: cubicOut }}
	out:fade={{ duration: 100, easing: cubicOut }}
>
	<!-- Backdrop -->
	<div
		class="absolute inset-0 bg-black/40 backdrop-blur-sm"
		role="button"
		tabindex="0"
		aria-label="Close search"
		onclick={closeGlobalSearch}
		onkeydown={(e) => e.key === 'Enter' && closeGlobalSearch()}
	></div>

	<!-- Panel -->
	<div
		class="relative z-10 w-full max-w-2xl flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden max-h-[75dvh]"
		role="dialog"
		aria-label="Global Database Search"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
		in:slide={{ duration: 200, easing: cubicOut, axis: 'y' }}
		out:slide={{ duration: 150, easing: cubicOut, axis: 'y' }}
	>
		<!-- Search bar + suggestions wrapper -->
		<div class="relative shrink-0">
			<form
				class="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800"
				onsubmit={handleFormSubmit}
			>
				<Icon name="lucide:search" class="w-4 h-4 text-slate-400 shrink-0" />
				<input
					bind:this={inputRef}
					bind:value={queryInput}
					type="text"
					placeholder="Search across all tables and columns…"
					autocomplete="off"
					class="flex-1 bg-transparent text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-400 outline-none"
					oninput={handleInput}
					onkeydown={handleInputKeydown}
					onfocus={() => { if (queryInput.trim() && suggestions.length) showSuggestions = true; }}
				/>
				{#if dbGlobalSearchState.isSearching || dbGlobalSearchState.isSuggesting}
					<svg class="w-4 h-4 animate-spin text-violet-500 shrink-0" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
				{:else}
					<button
						type="submit"
						disabled={!queryInput.trim()}
						class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors shrink-0"
					>
						<Icon name="lucide:search" class="w-3 h-3" />
						Search
					</button>
				{/if}
				<button
					type="button"
					onclick={closeGlobalSearch}
					class="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</form>

			<!-- Autocomplete suggestions dropdown -->
			{#if showSuggestions && suggestions.length > 0}
				<div
					class="absolute top-full left-0 right-0 z-20 bg-white dark:bg-slate-900 border-b border-x border-slate-200 dark:border-slate-700 rounded-b-2xl shadow-lg overflow-hidden"
					in:slide={{ duration: 120, easing: cubicOut, axis: 'y' }}
					out:slide={{ duration: 80, easing: cubicOut, axis: 'y' }}
				>
					<div class="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-100 dark:border-slate-800">
						<Icon name="lucide:sparkles" class="w-3 h-3 text-violet-400" />
						<span class="text-3xs text-slate-400 dark:text-slate-500 font-medium uppercase tracking-wide">Suggestions</span>
					</div>
					{#each suggestions as s, i (i)}
						<button
							type="button"
							class="w-full flex items-center gap-3 px-4 py-2 text-left transition-colors
								{highlightedSuggestionIdx === i
									? 'bg-violet-50 dark:bg-violet-900/20'
									: 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}"
							onclick={() => applySuggestion(s)}
							onmouseenter={() => (highlightedSuggestionIdx = i)}
						>
							<Icon name="lucide:corner-down-right" class="w-3 h-3 text-slate-300 dark:text-slate-600 shrink-0" />
							<span class="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-200 truncate">
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								{@html highlight(s.value, queryInput)}
							</span>
							<span class="shrink-0 flex items-center gap-1 text-3xs font-mono text-slate-400 dark:text-slate-500">
								<span class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">{s.tableName}</span>
								<span class="text-slate-300 dark:text-slate-600">·</span>
								<span>{s.columnName}</span>
							</span>
						</button>
					{/each}
					<div class="flex items-center gap-1.5 px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60">
						<kbd class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-3xs border border-slate-200 dark:border-slate-700 text-slate-500">↑↓</kbd>
						<span class="text-3xs text-slate-400">navigate</span>
						<kbd class="ml-2 px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-3xs border border-slate-200 dark:border-slate-700 text-slate-500">↵</kbd>
						<span class="text-3xs text-slate-400">select</span>
						<kbd class="ml-2 px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-3xs border border-slate-200 dark:border-slate-700 text-slate-500">Esc</kbd>
						<span class="text-3xs text-slate-400">dismiss</span>
					</div>
				</div>
			{/if}
		</div>

		<!-- Results area -->
		<div class="flex-1 min-h-0 overflow-y-auto">
			{#if dbGlobalSearchState.isSearching}
				<div class="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
					<svg class="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					<span class="text-sm">Searching all tables…</span>
					{#if queryInput.trim()}
						<span class="text-xs text-slate-300 dark:text-slate-600">for <em class="not-italic font-medium text-slate-500 dark:text-slate-400">"{queryInput.trim()}"</em></span>
					{/if}
				</div>

			{:else if dbGlobalSearchState.result && !dbGlobalSearchState.result.error}
				<!-- Stats bar -->
				<div class="flex items-center gap-3 px-4 py-2 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 shrink-0">
					<span>
						<strong class="text-slate-700 dark:text-slate-300">{totalMatches}</strong>
						{totalMatches === 1 ? 'match' : 'matches'}
					</span>
					<span class="text-slate-300 dark:text-slate-600">·</span>
					<span>{dbGlobalSearchState.result.tablesSearched} tables</span>
					<span class="text-slate-300 dark:text-slate-600">·</span>
					<span>{dbGlobalSearchState.result.columnsSearched} columns</span>
					<span class="text-slate-300 dark:text-slate-600">·</span>
					<span>{dbGlobalSearchState.result.executionTimeMs}ms</span>
					{#if dbGlobalSearchState.result.truncated}
						<span class="ml-auto flex items-center gap-1 text-amber-600 dark:text-amber-400">
							<Icon name="lucide:triangle-alert" class="w-3 h-3" />
							Truncated
						</span>
					{/if}
				</div>

				{#if totalMatches === 0}
					<div class="flex flex-col items-center justify-center py-14 gap-3 text-slate-400">
						<Icon name="lucide:search-x" class="w-8 h-8 opacity-30" />
						<span class="text-sm">No matches for <em class="not-italic font-medium text-slate-600 dark:text-slate-300">"{dbGlobalSearchState.result.query}"</em></span>
					</div>
				{:else}
					<div class="divide-y divide-slate-100 dark:divide-slate-800">
						{#each groupedMatches() as group (group.tableName + (group.tableSchema ?? ''))}
							<div>
								<!-- Table header -->
								<div class="flex items-center gap-2 px-4 py-2 bg-slate-50/70 dark:bg-slate-800/30 sticky top-0 z-10 border-b border-slate-100 dark:border-slate-800">
									<Icon name="lucide:table-2" class="w-3.5 h-3.5 text-violet-500 shrink-0" />
									<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">
										{#if group.tableSchema}
											<span class="text-slate-400 dark:text-slate-500">{group.tableSchema}.</span>
										{/if}
										{group.tableName}
									</span>
									<span class="ml-1 px-1.5 py-0.5 rounded-full text-3xs font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400">
										{group.matches.length}
									</span>
								</div>

								{#each group.matches as match, i (i)}
									<button
										type="button"
										class="w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-violet-50 dark:hover:bg-violet-900/10 transition-colors group border-b border-slate-50 dark:border-slate-800/50 last:border-b-0"
										onclick={() => handleNavigate(match)}
									>
										<span class="mt-0.5 shrink-0 px-1.5 py-0.5 rounded text-3xs font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
											{match.columnName}
										</span>
										<span class="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-300 leading-relaxed line-clamp-2">
											<!-- eslint-disable-next-line svelte/no-at-html-tags -->
											{@html highlight(getColumnPreview(match), dbGlobalSearchState.result?.query ?? '')}
										</span>
										{#if match.pkColumn && getPkValue(match) !== null}
											<span class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-3xs font-mono text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
												<Icon name="lucide:key" class="w-2.5 h-2.5" />
												{String(getPkValue(match))}
											</span>
										{/if}
										<Icon name="lucide:arrow-right" class="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 group-hover:text-violet-500 transition-colors shrink-0 mt-0.5" />
									</button>
								{/each}
							</div>
						{/each}
					</div>
				{/if}

			{:else if dbGlobalSearchState.result?.error}
				<div class="flex flex-col items-center justify-center py-14 gap-3 text-slate-400">
					<Icon name="lucide:circle-alert" class="w-8 h-8 text-red-400 opacity-60" />
					<span class="text-sm text-red-500 dark:text-red-400">{dbGlobalSearchState.result.error}</span>
				</div>

			{:else}
				<!-- Empty state -->
				<div class="flex flex-col items-center justify-center py-14 gap-3 text-slate-400">
					<Icon name="lucide:search" class="w-8 h-8 opacity-20" />
					<div class="text-center">
						<p class="text-sm">Search across all tables and columns</p>
						<p class="text-xs text-slate-400 dark:text-slate-500 mt-1">Finds text matches in VARCHAR, TEXT, and other string columns</p>
					</div>
					<div class="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
						<span>Start typing for instant suggestions</span>
						<span class="text-slate-300 dark:text-slate-600">·</span>
						<kbd class="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-3xs border border-slate-200 dark:border-slate-700">Enter</kbd>
						<span>to search</span>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>

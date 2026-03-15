<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbSqlEditorState,
		fetchHistory,
		deleteHistoryEntry,
		toggleFavorite,
		clearHistory
	} from '$frontend/stores/features/db-sql-editor.svelte';
	import { dbManagerState } from '$frontend/stores/features/db-manager.svelte';

	interface Props {
		connectionId: string | null;
		onSelectEntry: (sql: string) => void;
	}

	let { connectionId, onSelectEntry }: Props = $props();

	// Filtered entries based on search
	const filteredEntries = $derived(() => {
		const search = dbSqlEditorState.historySearch.toLowerCase();
		if (!search) return dbSqlEditorState.historyEntries;
		return dbSqlEditorState.historyEntries.filter((e) =>
			e.sql.toLowerCase().includes(search)
		);
	});

	// Group entries by date
	function getDateGroup(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const yesterday = new Date(today.getTime() - 86400000);
		const entryDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

		if (entryDate.getTime() === today.getTime()) return 'Today';
		if (entryDate.getTime() === yesterday.getTime()) return 'Yesterday';
		return entryDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	// Build grouped list from filtered entries
	const groupedEntries = $derived(() => {
		const entries = filteredEntries();
		const groups: { label: string; entries: typeof entries }[] = [];
		const seen = new Map<string, number>();

		for (const entry of entries) {
			const label = getDateGroup(entry.executedAt);
			if (!seen.has(label)) {
				seen.set(label, groups.length);
				groups.push({ label, entries: [] });
			}
			groups[seen.get(label)!].entries.push(entry);
		}
		return groups;
	});

	function formatTime(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatTimestamp(dateStr: string): string {
		return new Date(dateStr).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}

	async function handleClearHistory() {
		if (!connectionId) return;
		await clearHistory(connectionId);
	}

	onMount(async () => {
		await fetchHistory(connectionId ?? undefined);
	});
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- Search -->
	<div class="px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
		<div class="relative">
			<Icon name="lucide:search" class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
			<input
				type="text"
				bind:value={dbSqlEditorState.historySearch}
				placeholder="Search history..."
				class="w-full pl-7 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
			/>
		</div>
	</div>

	<!-- Entry list -->
	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if dbSqlEditorState.isLoadingHistory}
			<div class="flex items-center justify-center h-24 gap-2 text-slate-400 text-xs">
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				Loading history...
			</div>
		{:else if groupedEntries().length === 0}
			<div class="flex flex-col items-center justify-center h-24 gap-2 text-slate-400 text-xs">
				<Icon name="lucide:clock" class="w-5 h-5 opacity-40" />
				<span>{dbSqlEditorState.historySearch ? 'No results found' : 'No history yet'}</span>
			</div>
		{:else}
			{#each groupedEntries() as group}
				<div class="sticky top-0 z-10 px-3 py-1 text-xs font-semibold text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
					{group.label}
				</div>
				{#each group.entries as entry}
					<div
						class="w-full text-left px-3 py-2 hover:bg-violet-50 dark:hover:bg-violet-900/20 border-b border-slate-100 dark:border-slate-800/50 transition-colors group cursor-pointer"
						onclick={() => onSelectEntry(entry.sql)}
						onkeydown={(e) => e.key === 'Enter' && onSelectEntry(entry.sql)}
						role="button"
						tabindex="0"
					>
						<div class="flex items-start gap-2">
							<!-- SQL preview -->
							<div class="flex-1 min-w-0">
								<p class="text-xs font-mono text-slate-700 dark:text-slate-300 truncate leading-relaxed">
									{entry.sql.slice(0, 80)}{entry.sql.length > 80 ? '…' : ''}
								</p>
								<div class="flex items-center gap-2 mt-1">
									<span class="text-xs text-slate-400">{formatTimestamp(entry.executedAt)}</span>
									{#if !entry.error}
										<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400">
											{formatTime(entry.executionTimeMs)}
										</span>
										<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
											{entry.rowCount} rows
										</span>
									{:else}
										<span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400">
											error
										</span>
									{/if}
								</div>
							</div>

							<!-- Actions -->
							<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
								<button
									type="button"
									class="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
									onclick={(e) => { e.stopPropagation(); toggleFavorite(entry.id); }}
									title={entry.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
								>
									<Icon
										name={entry.isFavorite ? 'lucide:star' : 'lucide:star'}
										class="w-3.5 h-3.5 {entry.isFavorite ? 'text-amber-500 fill-amber-500' : 'text-slate-400'}"
									/>
								</button>
								<button
									type="button"
									class="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
									onclick={(e) => { e.stopPropagation(); deleteHistoryEntry(entry.id); }}
									title="Delete"
								>
									<Icon name="lucide:trash-2" class="w-3.5 h-3.5 text-slate-400 hover:text-red-500" />
								</button>
							</div>
						</div>
					</div>
				{/each}
			{/each}
		{/if}
	</div>

	<!-- Footer -->
	{#if connectionId && dbSqlEditorState.historyEntries.some((e) => e.connectionId === connectionId)}
		<div class="px-3 py-2 border-t border-slate-200 dark:border-slate-800 shrink-0">
			<button
				type="button"
				class="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-600 transition-colors"
				onclick={handleClearHistory}
			>
				<Icon name="lucide:trash-2" class="w-3 h-3" />
				Clear history for this connection
			</button>
		</div>
	{/if}
</div>

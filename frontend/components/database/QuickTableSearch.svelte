<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbManagerState, selectTable } from '$frontend/stores/features/db-manager.svelte';

	interface Props {
		onClose: () => void;
	}

	let { onClose }: Props = $props();

	let query = $state('');
	let selectedIndex = $state(0);
	let inputEl: HTMLInputElement | undefined = $state();

	const filteredTables = $derived.by(() => {
		const q = query.toLowerCase().trim();
		if (!q) return dbManagerState.tables.slice(0, 20);
		return dbManagerState.tables
			.filter(
				(t) =>
					t.name.toLowerCase().includes(q) ||
					(t.schema && t.schema.toLowerCase().includes(q))
			)
			.slice(0, 20);
	});

	// Reset selection when filter changes
	$effect(() => {
		// Track filteredTables length to reset index
		void filteredTables.length;
		selectedIndex = 0;
	});

	// Auto-focus input on mount
	$effect(() => {
		if (inputEl) {
			inputEl.focus();
		}
	});

	function handleSelect(name: string, schema: string | null | undefined) {
		selectTable(name, schema ?? undefined);
		onClose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, filteredTables.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const table = filteredTables[selectedIndex];
			if (table) handleSelect(table.name, table.schema);
		}
	}
</script>

<div
	class="fixed inset-0 z-[200] flex items-start justify-center pt-[14vh]"
	role="dialog"
	aria-modal="true"
	aria-label="Quick Table Search"
	in:fade={{ duration: 100 }}
	out:fade={{ duration: 80 }}
>
	<!-- Backdrop -->
	<div
		class="absolute inset-0 bg-black/40 backdrop-blur-sm"
		onclick={onClose}
		onkeydown={(e) => e.key === 'Escape' && onClose()}
		role="button"
		tabindex="-1"
		aria-label="Close quick search"
	></div>

	<!-- Panel -->
	<div
		class="relative z-10 w-full max-w-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden"
		in:scale={{ duration: 150, easing: cubicOut, start: 0.96 }}
		out:scale={{ duration: 100, easing: cubicOut, start: 0.96 }}
		onkeydown={handleKeydown}
		role="none"
	>
		<!-- Search input row -->
		<div class="flex items-center gap-2.5 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
			<Icon name="lucide:search" class="w-4 h-4 text-slate-400 shrink-0" />
			<input
				bind:this={inputEl}
				bind:value={query}
				type="text"
				placeholder="Search tables…"
				class="flex-1 text-sm bg-transparent text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 outline-none"
				aria-label="Search tables"
				aria-controls="quick-search-results"
				aria-activedescendant={`qsr-item-${selectedIndex}`}
				autocomplete="off"
				spellcheck="false"
			/>
			<kbd class="px-1.5 py-0.5 text-3xs font-mono bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-400">ESC</kbd>
		</div>

		<!-- Results list -->
		<div
			id="quick-search-results"
			class="max-h-64 overflow-y-auto py-1"
			role="listbox"
			aria-label="Matching tables"
		>
			{#if !dbManagerState.activeConnectionId}
				<div class="px-4 py-8 text-center text-xs text-slate-400 dark:text-slate-500">
					Connect to a database first
				</div>
			{:else if dbManagerState.isLoadingTables}
				<div class="flex items-center justify-center py-8 gap-2 text-slate-400 text-xs">
					<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					Loading tables…
				</div>
			{:else if filteredTables.length === 0}
				<div class="px-4 py-8 text-center text-xs text-slate-400 dark:text-slate-500">
					No tables found{query ? ` matching "${query}"` : ''}
				</div>
			{:else}
				{#each filteredTables as table, i (table.name + (table.schema ?? ''))}
					{@const isActive = dbManagerState.activeTableName === table.name && dbManagerState.activeTableSchema === (table.schema ?? null)}
					<button
						id={`qsr-item-${i}`}
						type="button"
						class="w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors
							{i === selectedIndex
								? 'bg-violet-500/10 dark:bg-violet-500/15'
								: 'hover:bg-slate-50 dark:hover:bg-slate-800/60'}
							{isActive
								? 'text-violet-600 dark:text-violet-400'
								: 'text-slate-700 dark:text-slate-300'}"
						role="option"
						aria-selected={i === selectedIndex}
						onclick={() => handleSelect(table.name, table.schema)}
						onmouseenter={() => (selectedIndex = i)}
					>
						<Icon name="lucide:table-2" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
						<span class="text-xs font-medium truncate flex-1">{table.name}</span>
						{#if table.schema && table.schema !== 'default' && table.schema !== 'public' && table.schema !== 'main'}
							<span class="text-3xs text-slate-400 dark:text-slate-500 shrink-0">{table.schema}</span>
						{/if}
						{#if isActive}
							<Icon name="lucide:check" class="w-3 h-3 text-violet-500 shrink-0" />
						{/if}
					</button>
				{/each}
			{/if}
		</div>

		<!-- Footer hints -->
		<div class="flex items-center gap-3 px-3 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
			<span class="text-3xs text-slate-400 dark:text-slate-500"><kbd class="font-mono">↑↓</kbd> navigate</span>
			<span class="text-3xs text-slate-400 dark:text-slate-500"><kbd class="font-mono">↵</kbd> select</span>
			<span class="text-3xs text-slate-400 dark:text-slate-500"><kbd class="font-mono">ESC</kbd> close</span>
			{#if filteredTables.length > 0}
				<span class="ml-auto text-3xs text-slate-400 dark:text-slate-500">{filteredTables.length} table{filteredTables.length !== 1 ? 's' : ''}</span>
			{/if}
		</div>
	</div>
</div>

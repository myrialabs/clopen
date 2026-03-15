<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbManagerState,
		switchToTab,
		closeTab,
		openNewTabForConnection
	} from '$frontend/stores/features/db-manager.svelte';

	let showPicker = $state(false);
	let pickerRef = $state<HTMLDivElement | null>(null);

	function handlePickerKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') showPicker = false;
	}

	function handlePickerOpen(connectionId: string) {
		openNewTabForConnection(connectionId);
		showPicker = false;
	}
</script>

<div class="flex items-center border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60 shrink-0 overflow-x-auto min-w-0" role="tablist">
	{#each dbManagerState.tabs as tab (tab.id)}
		{@const isActive = tab.id === dbManagerState.activeTabId}
		<div
			class="group flex items-center gap-1.5 px-3 min-w-0 max-w-[180px] shrink-0 h-9 cursor-pointer select-none border-r border-slate-200 dark:border-slate-800 transition-colors relative
				{isActive
					? 'bg-white dark:bg-slate-950 border-t-2 -mt-[2px]'
					: 'hover:bg-white/70 dark:hover:bg-slate-800/50'}"
			style:border-top-color={isActive ? tab.color : 'transparent'}
			role="tab"
			aria-selected={isActive}
			tabindex="0"
			onclick={() => switchToTab(tab.id)}
			onkeydown={(e) => e.key === 'Enter' && switchToTab(tab.id)}
		>
			<!-- Connection color dot -->
			<span
				class="w-2 h-2 rounded-full shrink-0 transition-all {isActive ? 'scale-110' : ''}"
				style:background-color={tab.color}
			></span>

			<!-- Tab label -->
			<span
				class="text-xs font-medium truncate flex-1 min-w-0 transition-colors
					{isActive
						? 'text-slate-800 dark:text-slate-100'
						: 'text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-300'}"
			>
				{tab.label}
			</span>

			<!-- Close button -->
			<button
				type="button"
				class="flex items-center justify-center w-4 h-4 rounded shrink-0 opacity-0 group-hover:opacity-100 {isActive ? 'opacity-60' : ''} hover:bg-slate-200 dark:hover:bg-slate-700 hover:!opacity-100 transition-all"
				onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
				aria-label="Close tab"
				title="Close tab"
			>
				<Icon name="lucide:x" class="w-2.5 h-2.5 text-slate-400" />
			</button>
		</div>
	{/each}

	<!-- New tab button with connection picker -->
	<div class="relative shrink-0">
		<button
			type="button"
			class="flex items-center justify-center w-8 h-9 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-all"
			onclick={() => (showPicker = !showPicker)}
			aria-label="Open new tab"
			title="Open new tab"
			aria-haspopup="listbox"
			aria-expanded={showPicker}
		>
			<Icon name="lucide:plus" class="w-3.5 h-3.5" />
		</button>

		{#if showPicker}
			<!-- Backdrop -->
			<div
				class="fixed inset-0 z-40"
				role="button"
				tabindex="-1"
				aria-label="Close picker"
				onclick={() => (showPicker = false)}
				onkeydown={handlePickerKeydown}
			></div>

			<!-- Connection picker dropdown -->
			<div
				bind:this={pickerRef}
				class="absolute top-full left-0 mt-1 z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden min-w-[200px] max-w-[260px]"
				role="listbox"
				aria-label="Open connection in new tab"
			>
				<div class="px-3 py-2 border-b border-slate-100 dark:border-slate-800">
					<p class="text-xs font-medium text-slate-500 dark:text-slate-400">Open in new tab</p>
				</div>
				{#if dbManagerState.connections.length === 0}
					<p class="px-3 py-3 text-xs text-slate-400">No connections saved yet</p>
				{:else}
					<div class="py-1 max-h-60 overflow-y-auto">
						{#each dbManagerState.connections as conn (conn.id)}
							<button
								type="button"
								class="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-violet-500/8 dark:hover:bg-violet-500/12 transition-colors"
								role="option"
								aria-selected={false}
								onclick={() => handlePickerOpen(conn.id)}
							>
								<span class="w-2 h-2 rounded-full shrink-0" style:background-color={conn.color ?? '#8b5cf6'}></span>
								<span class="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{conn.name}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

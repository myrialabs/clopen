<!--
	Terminal Tabs Component
	Manages terminal session tabs with close and new tab functionality
-->
<script lang="ts">
	import type { TerminalSession } from '$shared/types/terminal';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	const {
		sessions = [],
		activeSessionId,
		onSwitchSession,
		onCloseSession,
		onNewSession
	}: {
		sessions: TerminalSession[];
		activeSessionId: string | null;
		onSwitchSession?: (sessionId: string) => void;
		onCloseSession?: (sessionId: string) => void;
		onNewSession?: () => void;
	} = $props();

	// Check for duplicate sessions (for debugging)
	$effect(() => {
		const ids = sessions.map(s => s.id);
		const uniqueIds = new Set(ids);
		if (ids.length !== uniqueIds.size) {
			// Duplicate session IDs detected in TerminalTabs
			// Sessions:
		}
	});
</script>

<!-- Compact Terminal Tabs -->
<div class="flex items-center gap-1.5 overflow-x-auto flex-1">
	{#each sessions as session (session.id)}
		<div
			class="group relative flex items-center gap-2 pl-3 pr-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded-lg transition-all duration-200 min-w-0 max-w-xs cursor-pointer
				{session.isActive
					? 'bg-slate-100 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
					: 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'}"
			onclick={() => onSwitchSession?.(session.id)}
			role="tab"
			tabindex="0"
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onSwitchSession?.(session.id);
				}
			}}
		>
			<!-- Terminal icon -->
			<Icon name="lucide:terminal" class="w-3 h-3 flex-shrink-0" />

			<!-- Session name -->
			<span class="text-xs font-medium truncate max-w-37.5">
				{session.name}
			</span>

			<!-- Close button -->
			<button
				onclick={(e) => {
					e.stopPropagation();
					onCloseSession?.(session.id);
				}}
				class="flex hover:bg-slate-300 dark:hover:bg-slate-600 rounded p-0.5 transition-all duration-200 flex-shrink-0"
				title="Close terminal"
				aria-label="Close terminal session"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		</div>
	{/each}

	<!-- New terminal button -->
	{#if onNewSession}
		<button
			onclick={onNewSession}
			class="flex items-center justify-center w-5 h-5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-all duration-200 flex-shrink-0"
			title="New terminal"
			aria-label="New terminal session"
		>
			<Icon name="lucide:plus" class="w-3 h-3" />
		</button>
	{/if}
</div>


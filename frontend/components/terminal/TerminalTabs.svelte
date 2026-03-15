<!--
	Terminal Tabs Component
	Manages terminal session tabs with close and new tab functionality
-->
<script lang="ts">
	import type { TerminalSession } from '$shared/types/terminal';
	import Icon from '$frontend/components/common/display/Icon.svelte';

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

<!-- Terminal Tabs (Git-style underline tabs) -->
<div class="relative flex items-center overflow-x-auto flex-1">
	{#each sessions as session (session.id)}
		{@const isActive = session.isActive}
		<button
			type="button"
			class="group relative flex items-center justify-center gap-1 pr-2 pl-3 py-2 text-xs font-medium transition-colors min-w-0 max-w-xs cursor-pointer
				{isActive
					? 'text-violet-600 dark:text-violet-400'
					: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
			onclick={() => onSwitchSession?.(session.id)}
			role="tab"
			tabindex="0"
		>
			<span class="truncate max-w-28">{session.name}</span>
			<!-- Close button -->
			<span
				role="button"
				tabindex="0"
				onclick={(e) => {
					e.stopPropagation();
					onCloseSession?.(session.id);
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.stopPropagation();
						onCloseSession?.(session.id);
					}
				}}
				class="flex items-center justify-center w-4 h-4 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-all duration-200 flex-shrink-0"
				title="Close terminal"
				aria-label="Close terminal session"
			>
				<Icon name="lucide:x" class="w-2.5 h-2.5" />
			</span>
			{#if isActive}
				<span class="absolute bottom-0 inset-x-0 h-px bg-violet-600 dark:bg-violet-400"></span>
			{/if}
		</button>
	{/each}

	<!-- New terminal button -->
	{#if onNewSession}
		<button
			type="button"
			onclick={onNewSession}
			class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-all duration-200 flex-shrink-0 ml-1"
			title="New terminal"
			aria-label="New terminal session"
		>
			<Icon name="lucide:plus" class="w-3 h-3" />
		</button>
	{/if}
</div>


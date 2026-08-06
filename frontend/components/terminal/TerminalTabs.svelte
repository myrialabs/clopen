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
		onNewSession,
		onRenameSession,
		onReorderSession,
		onCloseAllSessions
	}: {
		sessions: TerminalSession[];
		activeSessionId: string | null;
		onSwitchSession?: (sessionId: string) => void;
		onCloseSession?: (sessionId: string) => void;
		onNewSession?: () => void;
		onRenameSession?: (sessionId: string, name: string) => void;
		onReorderSession?: (sessionId: string, targetSessionId: string) => void;
		onCloseAllSessions?: () => void;
	} = $props();

	let editingSessionId = $state<string | null>(null);
	let draftName = $state('');

	let stripElement = $state<HTMLDivElement | undefined>();
	let draggingSessionId = $state<string | null>(null);
	let dragOverSessionId = $state<string | null>(null);

	/**
	 * Vertical wheel scrolls the strip horizontally, matching an editor tab bar —
	 * without it, overflowed tabs are unreachable on a mouse.
	 */
	function handleWheel(event: WheelEvent) {
		if (!stripElement) return;
		if (event.deltaY === 0 || event.shiftKey) return;
		if (stripElement.scrollWidth <= stripElement.clientWidth) return;

		event.preventDefault();
		stripElement.scrollLeft += event.deltaY;
	}

	// Keep the active tab visible when it changes from outside the strip.
	$effect(() => {
		const id = activeSessionId;
		if (!id || !stripElement) return;

		queueMicrotask(() => {
			stripElement
				?.querySelector(`[data-session-id="${CSS.escape(id)}"]`)
				?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		});
	});

	function focusAndSelect(node: HTMLInputElement) {
		queueMicrotask(() => {
			node.focus();
			node.select();
		});
	}

	function startRename(session: TerminalSession) {
		editingSessionId = session.id;
		draftName = session.name;
	}

	function cancelRename() {
		editingSessionId = null;
		draftName = '';
	}

	function saveRename(sessionId: string) {
		const normalizedName = draftName.trim();
		if (normalizedName) {
			onRenameSession?.(sessionId, normalizedName);
		}
		cancelRename();
	}

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
<!--
	The tab actions live inside the scroller as a sticky block: beside the last
	tab while there is room, pinned to the right edge once the tabs overflow.
-->
<div bind:this={stripElement} onwheel={handleWheel} class="tab-strip flex items-center overflow-x-auto">
	{#each sessions as session (session.id)}
		{@const isActive = session.isActive}
		<button
			type="button"
			data-session-id={session.id}
			draggable={editingSessionId === session.id ? false : true}
			ondragstart={(event) => {
				draggingSessionId = session.id;
				event.dataTransfer?.setData('text/plain', session.id);
				if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
			}}
			ondragover={(event) => {
				if (!draggingSessionId || draggingSessionId === session.id) return;
				// Default is "reject the drop"; allowing it is what makes `drop` fire.
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
				dragOverSessionId = session.id;
			}}
			ondragleave={() => {
				if (dragOverSessionId === session.id) dragOverSessionId = null;
			}}
			ondrop={(event) => {
				event.preventDefault();
				const sourceId = draggingSessionId ?? event.dataTransfer?.getData('text/plain');
				if (sourceId && sourceId !== session.id) onReorderSession?.(sourceId, session.id);
				draggingSessionId = null;
				dragOverSessionId = null;
			}}
			ondragend={() => {
				draggingSessionId = null;
				dragOverSessionId = null;
			}}
			class="group relative flex shrink-0 items-center justify-center gap-1 pr-2 pl-3 py-2 text-xs font-medium transition-colors max-w-xs cursor-pointer
				{isActive
					? 'text-violet-600 dark:text-violet-400'
					: 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}
				{draggingSessionId === session.id ? 'opacity-40' : ''}
				{dragOverSessionId === session.id ? 'bg-violet-500/10' : ''}"
			onclick={() => onSwitchSession?.(session.id)}
			ondblclick={() => startRename(session)}
			role="tab"
			aria-selected={isActive}
			tabindex="0"
		>
			{#if editingSessionId === session.id}
				<input
					bind:value={draftName}
					class="w-28 min-w-0 rounded border border-violet-300 bg-white/90 px-1.5 py-0.5 text-xs text-slate-800 outline-none dark:border-violet-500/60 dark:bg-slate-900 dark:text-slate-100"
					onclick={(e) => e.stopPropagation()}
					onblur={() => saveRename(session.id)}
					onkeydown={(e) => {
						e.stopPropagation();
						if (e.key === 'Enter') {
							e.preventDefault();
							saveRename(session.id);
						} else if (e.key === 'Escape') {
							e.preventDefault();
							cancelRename();
						}
					}}
					use:focusAndSelect
				/>
			{:else}
				<span class="truncate max-w-28">{session.name}</span>
			{/if}
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

	<!-- Sticky, and opaque so tabs scroll underneath rather than through. -->
	<div class="sticky right-0 z-10 flex shrink-0 items-center gap-0.5 bg-white px-1 dark:bg-slate-900">
		{#if onNewSession}
			<button
				type="button"
				onclick={onNewSession}
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-all duration-200 flex-shrink-0"
				title="New terminal"
				aria-label="New terminal session"
			>
				<Icon name="lucide:plus" class="w-3 h-3" />
			</button>
		{/if}

		{#if onCloseAllSessions && sessions.length > 1}
			<button
				type="button"
				onclick={onCloseAllSessions}
				class="flex items-center justify-center w-6 h-6 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-all duration-200 flex-shrink-0"
				title="Close all terminals"
				aria-label="Close all terminal sessions"
			>
				<Icon name="lucide:list-x" class="w-3.5 h-3.5" />
			</button>
		{/if}
	</div>
</div>

<style>
	/* Thin scrollbar so overflowed tabs stay reachable without a bar that
	   visually competes with a 32px-tall row. */
	.tab-strip {
		scrollbar-width: thin;
	}

	.tab-strip::-webkit-scrollbar {
		height: 3px;
	}

	.tab-strip::-webkit-scrollbar-thumb {
		background: rgb(148 163 184 / 0.5);
		border-radius: 999px;
	}

	.tab-strip::-webkit-scrollbar-track {
		background: transparent;
	}
</style>

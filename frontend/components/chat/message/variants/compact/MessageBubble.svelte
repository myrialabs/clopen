<!--
  Compact Message Bubble
  No header for most types — user messages show a slim header row.
-->

<script lang="ts">
	import { tick } from 'svelte';
	import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MessageFormatter from '../../../formatters/MessageFormatter.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';

	const {
		message,
		roleCategory,
		messageTimestamp,
		isLastUserMessage = false,
		senderName,
		formatTime,
		onRestore,
		onEdit,
	}: {
		message: FrontendMessage;
		messageTimestamp: string;
		isLastUserMessage?: boolean;
		roleConfig: { gradient: string; icon: IconName; name: string };
		roleCategory: 'user' | 'assistant' | 'agent' | string;
		agentStatus: 'processing' | 'waiting' | 'success' | 'error' | null;
		senderName: string | null;
		formatTime: (timestamp?: string) => string;
		onCopy: () => void;
		onRestore: () => void;
		onEdit: () => void;
		onShowDebug: () => void;
	} = $props();

	let scrollContainer: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (roleCategory !== 'system' && roleCategory !== 'compact') return;
		if (!scrollContainer) return;
		const _track = message.type === 'stream_event' ? message.text : message;
		void _track;
		tick().then(() => {
			if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
		});
	});

	$effect(() => {
		if (roleCategory !== 'assistant') return;
		if (message.type !== 'stream_event') return;
		const _track = message.text;
		void _track;
	});

	// Reasoning is always received complete — no partial state exists.
	// "Thinking..." is shown only while loading AND no text generation has started
	// for THIS specific reasoning block (checked by position in the messages array).
	// Checking globally for any stream_event is wrong: agent sub-tools stream their
	// own events inside subActivities (not top-level), so there would be no top-level
	// stream_event during agent execution even though this reasoning block is done.
	const isThinkingInProgress = $derived.by(() => {
		if (!appState.isLoading) return false;
		const msgs = sessionState.messages;
		const idx = msgs.findIndex(
			m => m === message ||
			('messageId' in m && 'messageId' in message && (m as any).messageId === (message as any).messageId)
		);
		if (idx === -1) return false;
		return !msgs.slice(idx + 1).some(m => m.type === 'stream_event' || m.type === 'assistant');
	});
</script>

{#if roleCategory === 'user'}
	<div class="space-y-1 rounded-sm px-2 py-1.5 bg-slate-100 dark:bg-slate-700/30">
		<!-- Slim user header -->
		<div class="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
			<span class="shrink-0">{formatTime(messageTimestamp)}</span>
			<span class="font-medium text-slate-500 dark:text-slate-400 truncate">
				{senderName || 'You'}
			</span>
			<div class="flex items-center gap-1 ml-auto shrink-0">
				{#if !isLastUserMessage}
					<button
						type="button"
						onclick={(e) => { e.stopPropagation(); onRestore(); }}
						disabled={appState.isLoading}
						class="flex p-0.5 rounded transition-colors {appState.isLoading ? 'opacity-40 cursor-not-allowed' : 'hover:bg-slate-200 dark:hover:bg-slate-700'}"
						title="Undo to checkpoint"
					>
						<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
					</button>
				{/if}
				<button
					type="button"
					onclick={(e) => { e.stopPropagation(); onEdit(); }}
					disabled={appState.isLoading}
					class="flex p-0.5 rounded transition-colors {appState.isLoading ? 'opacity-40 cursor-not-allowed' : 'hover:bg-slate-200 dark:hover:bg-slate-700'}"
					title="Edit"
				>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
		<!-- Message content -->
		<div class="text-slate-900 dark:text-slate-100">
			<MessageFormatter {message} />
		</div>
	</div>
{:else}
	<div
		bind:this={scrollContainer}
		class="text-slate-900 dark:text-slate-100 {roleCategory === 'system' || roleCategory === 'compact' ? 'max-h-48 overflow-y-auto' : ''}"
	>
		{#if roleCategory === 'reasoning'}
			<div class="text-xs text-slate-400 dark:text-slate-500">
				{#if isThinkingInProgress}
					<span class="animate-pulse">Thinking...</span>
				{:else}
					<span>Thought for a moment</span>
				{/if}
			</div>
		{:else}
			<MessageFormatter {message} />
		{/if}
	</div>
{/if}

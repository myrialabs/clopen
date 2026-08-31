<!--
  Message Bubble Component

  Features:
  - Message content wrapper
  - Card styling
  - Header and content sections
  - Hover effects
-->

<script lang="ts">
	import { tick } from 'svelte';
	import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import Card from '$frontend/components/common/display/Card.svelte';
	import MessageFormatter from '../../../formatters/MessageFormatter.svelte';
	import MessageHeader from './MessageHeader.svelte';

	const {
		message,
		messageTimestamp,
		isLastUserMessage = false,
		roleConfig,
		roleCategory,
		agentStatus,
		senderName,
		formatTime,
		onCopy,
		onRestore,
		onEdit,
		onShowDebug
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
	let stickToBottom = $state(true);

	function handleScroll() {
		if (!scrollContainer) return;
		const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
		stickToBottom = distanceFromBottom <= 16;
	}

	// Auto-scroll reasoning/system/compact content to bottom while receiving partial text,
	// but only when the user is already at the bottom (stickToBottom).
	$effect(() => {
		if (roleCategory !== 'reasoning' && roleCategory !== 'system' && roleCategory !== 'compact') return;
		if (!scrollContainer) return;
		const _track = message.type === 'stream_event'
			? message.text
			: message;
		void _track;
		if (!stickToBottom) return;
		tick().then(() => {
			if (scrollContainer && stickToBottom) {
				scrollContainer.scrollTop = scrollContainer.scrollHeight;
			}
		});
	});

	// Force reactive tracking for assistant text streaming.
	// Without an explicit $effect that reads text, Svelte 5's derived chain
	// may not re-render the component when text changes on a proxied object.
	// Reasoning gets this implicitly via the auto-scroll effect above.
	$effect(() => {
		if (roleCategory !== 'assistant') return;
		if (message.type !== 'stream_event') return;
		const _track = message.text;
	});
</script>

<div class="relative overflow-hidden">
	<Card
		variant="outlined"
		padding="none"
		class="bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 overflow-hidden"
	>
		<!-- Message Header -->
		<MessageHeader
			{message}
			{messageTimestamp}
			{isLastUserMessage}
			{roleConfig}
			{roleCategory}
			{agentStatus}
			{senderName}
			{formatTime}
			{onCopy}
			{onRestore}
			{onEdit}
			{onShowDebug}
		/>

		<!-- Message Content -->
		<div
			bind:this={scrollContainer}
			onscroll={handleScroll}
			class="p-3 md:p-4 {roleCategory === 'reasoning' || roleCategory === 'system' || roleCategory === 'compact' ? 'max-h-80 overflow-y-auto' : ''}"
		>
			<div class="max-w-none space-y-4">
				<!-- Content rendering using MessageFormatter component -->
				<MessageFormatter {message} />
			</div>
		</div>
	</Card>

</div>

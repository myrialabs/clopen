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
	import MessageFormatter from '../formatters/MessageFormatter.svelte';
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

	// Auto-scroll reasoning/system content to bottom while receiving partial text
	$effect(() => {
		if (roleCategory !== 'reasoning' && roleCategory !== 'system' && roleCategory !== 'compact') return;
		if (!scrollContainer) return;
		// Track message content changes (text for streaming, message for final)
		const _track = message.type === 'stream_event'
			? message.text
			: message;
		tick().then(() => {
			if (scrollContainer) {
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
			class="p-3 md:p-4 {roleCategory === 'reasoning' || roleCategory === 'system' || roleCategory === 'compact' ? 'max-h-80 overflow-y-auto' : ''}"
		>
			<div class="max-w-none space-y-4">
				<!-- Content rendering using MessageFormatter component -->
				<MessageFormatter {message} />
			</div>
		</div>
	</Card>

</div>

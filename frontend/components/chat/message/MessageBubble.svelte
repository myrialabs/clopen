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
	import type { SDKMessageFormatter } from '$shared/types/database/schema';
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
		hasTokenUsageData,
		formatTime,
		onCopy,
		onRestore,
		onEdit,
		onShowTokenUsage,
		onShowDebug
	}: {
		message: SDKMessageFormatter;
		messageTimestamp: string;
		isLastUserMessage?: boolean;
		roleConfig: { gradient: string; icon: IconName; name: string };
		roleCategory: 'user' | 'assistant' | 'agent' | string;
		agentStatus: 'processing' | 'waiting' | 'success' | 'error' | null;
		senderName: string | null;
		hasTokenUsageData: any;
		formatTime: (timestamp?: string) => string;
		onCopy: () => void;
		onRestore: () => void;
		onEdit: () => void;
		onShowTokenUsage: () => void;
		onShowDebug: () => void;
	} = $props();

	let scrollContainer: HTMLDivElement | undefined = $state();

	// Auto-scroll reasoning/system content to bottom while receiving partial text
	$effect(() => {
		if (roleCategory !== 'reasoning' && roleCategory !== 'system') return;
		if (!scrollContainer) return;
		// Track message content changes (partialText for streaming, message for final)
		const _track = message.type === 'stream_event' && 'partialText' in message
			? message.partialText
			: message;
		tick().then(() => {
			if (scrollContainer) {
				scrollContainer.scrollTop = scrollContainer.scrollHeight;
			}
		});
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
			{hasTokenUsageData}
			{formatTime}
			{onCopy}
			{onRestore}
			{onEdit}
			{onShowTokenUsage}
			{onShowDebug}
		/>

		<!-- Message Content -->
		<div
			bind:this={scrollContainer}
			class="p-3 md:p-4 {roleCategory === 'reasoning' || roleCategory === 'system' ? 'max-h-80 overflow-y-auto' : ''}"
		>
			<div class="max-w-none space-y-4">
				<!-- Content rendering using MessageFormatter component -->
				<MessageFormatter {message} />
			</div>
		</div>
	</Card>

	<!-- Hover glow effect -->
	<div class="absolute inset-0 bg-gradient-to-r from-violet-500/5 to-violet-500/5 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity -z-10 blur-xl"></div>
</div>

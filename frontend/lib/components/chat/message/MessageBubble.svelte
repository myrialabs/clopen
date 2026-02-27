<!--
  Message Bubble Component

  Features:
  - Message content wrapper
  - Card styling
  - Header and content sections
  - Hover effects
-->

<script lang="ts">
	import type { SDKMessageFormatter } from '$shared/types/database/schema';
	import type { IconName } from '$shared/types/ui/icons';
	import Card from '$frontend/lib/components/common/Card.svelte';
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
		agentStatus: 'processing' | 'success' | 'error' | null;
		senderName: string | null;
		hasTokenUsageData: any;
		formatTime: (timestamp?: string) => string;
		onCopy: () => void;
		onRestore: () => void;
		onEdit: () => void;
		onShowTokenUsage: () => void;
		onShowDebug: () => void;
	} = $props();
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
		<div class="p-3 md:p-4">
			<div class="max-w-none">
				<!-- Content rendering using MessageFormatter component -->
				<MessageFormatter {message} />
			</div>
		</div>
	</Card>

	<!-- Hover glow effect -->
	<div class="absolute inset-0 bg-gradient-to-r from-violet-500/5 to-violet-500/5 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity -z-10 blur-xl"></div>
</div>

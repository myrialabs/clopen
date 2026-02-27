<!--
  Message Header Component

  Features:
  - Timestamp display
  - Sender name and role badge
  - Agent status indicator
  - Action buttons (copy, undo, edit, token usage, debug)
-->

<script lang="ts">
	import type { SDKMessageFormatter } from '$shared/types/database/schema';
	import type { IconName } from '$shared/types/ui/icons';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { appState } from '$frontend/lib/stores/core/app.svelte';

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

	// State untuk copy button
	let isCopied = $state(false);

	// Handle copy dengan perubahan icon
	function handleCopy() {
		onCopy();
		isCopied = true;
		setTimeout(() => {
			isCopied = false;
		}, 1000);
	}
</script>

<div class="flex items-center justify-between gap-5 px-3 md:px-4 py-1 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
	<!-- Timestamp and Type -->
	<div class="flex items-center gap-2">
		<span class="text-xs text-slate-500 dark:text-slate-400 font-medium">
			{formatTime(messageTimestamp)}
		</span>
		<span class="w-1 h-1 bg-current rounded-full opacity-50"></span>
		<div class="flex items-center gap-1.5">
			<span class="text-xs text-slate-400 dark:text-slate-500 capitalize">
				{roleCategory === 'user' && senderName ? senderName : roleConfig.name}
			</span>
			<!-- Agent Status Indicator -->
			{#if agentStatus}
				{#if agentStatus === 'processing'}
					<span title="Agent is processing...">
						<Icon name="lucide:loader" class="w-3 h-3 text-violet-500 dark:text-violet-400 animate-spin" />
					</span>
				{:else if agentStatus === 'success'}
					<span title="Agent completed successfully">
						<Icon name="lucide:check" class="w-3 h-3 text-green-500 dark:text-green-400" />
					</span>
				{:else if agentStatus === 'error'}
					<span title="Agent encountered an error">
						<Icon name="lucide:x" class="w-3 h-3 text-red-500 dark:text-red-400" />
					</span>
				{/if}
			{/if}
		</div>
	</div>

	<!-- Compact Actions - Always visible but subtle -->
	<div class="flex items-center space-x-1 -mr-1">
		<!-- Copy button - hanya untuk user dan assistant (tidak untuk agent) -->
		{#if roleCategory === 'user' || roleCategory === 'assistant'}
			<button
				onclick={handleCopy}
				class="inline-flex p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors opacity-60 hover:opacity-100"
				aria-label="Copy message"
				title="Copy message"
			>
				<Icon name={isCopied ? "lucide:check" : "lucide:copy"} class="w-3.5 h-3.5" />
			</button>
		{/if}

		<!-- Undo and Edit buttons for user messages (disabled saat streaming) -->
		{#if roleCategory === 'user'}
			<!-- Undo button (not shown for last user message) -->
			{#if !isLastUserMessage}
				<button
					onclick={onRestore}
					disabled={appState.isLoading}
					class="inline-flex p-1.5 rounded-md transition-colors {appState.isLoading ? 'cursor-not-allowed opacity-40' : 'hover:bg-slate-200 dark:hover:bg-slate-600 opacity-60 hover:opacity-100'}"
					aria-label="Undo to this checkpoint"
					title="Undo to this checkpoint"
				>
					<Icon name="lucide:undo-2" class="w-3.5 h-3.5" />
				</button>
			{/if}

			<!-- Edit button for user messages -->
			<button
				onclick={onEdit}
				disabled={appState.isLoading}
				class="inline-flex p-1.5 rounded-md transition-colors {appState.isLoading ? 'cursor-not-allowed opacity-40' : 'hover:bg-slate-200 dark:hover:bg-slate-600 opacity-60 hover:opacity-100'}"
				aria-label="Edit message"
				title="Edit message"
			>
				<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
			</button>
		{/if}

		<!-- Token Usage button -->
		{#if hasTokenUsageData}
			<button
				onclick={onShowTokenUsage}
				class="inline-flex p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors opacity-60 hover:opacity-100"
				aria-label="Show token usage info"
				title="Token usage"
			>
				<Icon name="lucide:zap" class="w-3.5 h-3.5" />
			</button>
		{/if}

		<!-- Debug toggle button -->
		{#if 'parent_tool_use_id' in message}
			<button
				onclick={onShowDebug}
				class="inline-flex p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors opacity-60 hover:opacity-100"
				aria-label="Show debug info"
				title="Debug info"
			>
				<Icon name="lucide:bug" class="w-3.5 h-3.5" />
			</button>
		{/if}
	</div>
</div>

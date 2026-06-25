<!--
  Compact Message Bubble
  - User: slim rounded card
  - Agent: inline timeline with bold summary header + ALL items (tools + text) connected
  - Assistant/Reasoning: plain text
-->

<script lang="ts">
	import { tick } from 'svelte';
	import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MessageFormatter from '../../../formatters/MessageFormatter.svelte';
	import Tools from '../../../formatters/Tools.svelte';
	import TextMessage from '../../../formatters/TextMessage.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { HIDDEN_TOOLS } from '../../../tools/registry';
	import type { KnownToolName } from '$shared/types/unified';

	const {
		message,
		roleCategory,
		messageTimestamp,
		isLastUserMessage = false,
		senderName,
		formatTime,
		onCopy,
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
	let isCopied = $state(false);
	let stickToBottom = $state(true);
	let isCollapsed = $state(false);

	function handleCopy() {
		onCopy();
		isCopied = true;
		setTimeout(() => { isCopied = false; }, 1000);
	}

	function handleScroll() {
		if (!scrollContainer) return;
		const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
		stickToBottom = distanceFromBottom <= 16;
	}

	$effect(() => {
		if (roleCategory !== 'system') return;
		if (!scrollContainer) return;
		const _track = message.type === 'stream_event' ? message.text : message;
		void _track;
		if (!stickToBottom) return;
		tick().then(() => {
			if (scrollContainer && stickToBottom) scrollContainer.scrollTop = scrollContainer.scrollHeight;
		});
	});

	const compactTrigger = $derived(message.type === 'compact_boundary' ? message.trigger : null);

	$effect(() => {
		if (roleCategory !== 'assistant') return;
		if (message.type !== 'stream_event') return;
		const _track = message.text;
		void _track;
	});

	const isThinkingInProgress = $derived(message.type === 'stream_event');

	let thinkingDotCount = $state(1);
	$effect(() => {
		if (!isThinkingInProgress) return;
		const interval = setInterval(() => {
			thinkingDotCount = (thinkingDotCount % 8) + 1;
		}, 400);
		return () => clearInterval(interval);
	});
	const thinkingDots = $derived('.'.repeat(thinkingDotCount));

	// ─── Agent message parsing ─────────────────────────────────────────────────
	type ContentItem = { type: string; id?: string; [key: string]: any };

	/** All content items in original order, skipping hidden tools */
	const agentItems = $derived.by(() => {
		if (roleCategory !== 'agent') return [] as ContentItem[];
		if (message.type !== 'assistant' || !('content' in message)) return [] as ContentItem[];
		return (message.content as ContentItem[]).filter(item => {
			if (item.type === 'tool_use') {
				// Skip tools that are hidden from the stream
				return !HIDDEN_TOOLS.has(item.name as KnownToolName);
			}
			if (item.type === 'text') {
				return (item.text as string || '').trim().length > 0;
			}
			return false;
		});
	});

	/** First text block used as summary header */
	const firstTextItem = $derived(agentItems.find(i => i.type === 'text'));
	const summaryText = $derived((firstTextItem?.text as string || '').trim());
	const summaryFirstWord = $derived(summaryText.split(/\s+/)[0] || '');
	const summaryRest = $derived.by(() => {
		const spaceIdx = summaryText.indexOf(' ');
		return spaceIdx >= 0 ? summaryText.slice(spaceIdx) : '';
	});

	/** All items AFTER the first text block go into the timeline body */
	const timelineItems = $derived.by(() => {
		const firstTextIdx = agentItems.findIndex(i => i.type === 'text');
		// If there's a leading text block, show rest in timeline; otherwise show all
		return firstTextIdx >= 0 ? agentItems.slice(firstTextIdx + 1) : agentItems;
	});

	/** Aggregate diff across edit/write tools */
	const agentDiff = $derived.by(() => {
		let additions = 0;
		let deletions = 0;
		for (const item of agentItems) {
			if (item.type !== 'tool_use') continue;
			if (item.name === 'Edit' || item.name === 'Patch') {
				const inp = item.input || {};
				if (inp.newString) additions += (inp.newString as string).split('\n').length;
				if (inp.oldString) deletions += (inp.oldString as string).split('\n').length;
			}
			if (item.name === 'Write') {
				const inp = item.input || {};
				if (inp.content) additions += (inp.content as string).split('\n').length;
			}
		}
		return { additions, deletions };
	});

	const hasDiff = $derived(agentDiff.additions > 0 || agentDiff.deletions > 0);
	const totalItems = $derived(agentItems.length);
</script>

{#if roleCategory === 'user'}
	<!-- User message: slim rounded card -->
	<div class="space-y-1 rounded-sm px-3 py-2 bg-slate-100 dark:bg-slate-700/30">
		<div class="flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
			<span class="shrink-0">{formatTime(messageTimestamp)}</span>
			<span class="font-medium text-slate-500 dark:text-slate-400 truncate">{senderName || 'You'}</span>
			<div class="flex items-center gap-1 ml-auto shrink-0">
				<button
					type="button"
					onclick={(e) => { e.stopPropagation(); handleCopy(); }}
					class="flex p-0.5 rounded transition-colors hover:bg-slate-200 dark:hover:bg-slate-700"
					title="Copy message"
				>
					<Icon name={isCopied ? "lucide:check" : "lucide:copy"} class="w-3.5 h-3.5" />
				</button>
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
		<div class="text-slate-900 dark:text-slate-100">
			<MessageFormatter {message} />
		</div>
	</div>

{:else if roleCategory === 'compact'}
	<div class="text-xs text-slate-400 dark:text-slate-500">
		<span>Context compacted{compactTrigger ? ` (${compactTrigger})` : ''}</span>
	</div>

{:else if roleCategory === 'agent'}
	<!-- Agent: inline timeline layout — ONE connected vertical line for everything -->
	<div class="min-w-0">

		<!-- ── Summary / header row (first text block or fallback) ──────────── -->
		<button
			type="button"
			class="w-full flex items-start gap-1.5 min-w-0 pl-[22px] text-left bg-transparent border-none cursor-pointer py-0.5 group/header {summaryFirstWord ? '' : 'hidden'}"
			onclick={() => isCollapsed = !isCollapsed}
		>
			<span class="flex-1 min-w-0 text-[13px] text-slate-800 dark:text-slate-200 font-normal leading-snug">
				<strong class="font-semibold">{summaryFirstWord}</strong>{summaryRest}
			</span>
			{#if hasDiff}
				<span class="flex items-center gap-1 shrink-0 mt-0.5">
					{#if agentDiff.additions > 0}
						<span class="text-[11px] font-semibold text-emerald-500 dark:text-emerald-400">+{agentDiff.additions}</span>
					{/if}
					{#if agentDiff.deletions > 0}
						<span class="text-[11px] font-semibold text-red-500 dark:text-red-400">-{agentDiff.deletions}</span>
					{/if}
				</span>
			{/if}
			<Icon
				name={isCollapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'}
				class="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0 mt-0.5 opacity-50 group-hover/header:opacity-100 transition-opacity"
			/>
		</button>

		{#if (!isCollapsed || !summaryFirstWord) && timelineItems.length > 0}
			<div class="relative mt-0.5">
				{#each timelineItems as item, i (item.id ?? `item-${i}`)}
					<div class="relative">
						{#if item.type === 'tool_use'}
							<!-- Tool item -->
							<Tools toolInput={item as any} />
						{:else if item.type === 'text'}
							<!-- Text / bullet block inline in timeline — aligned with tool content -->
							<div class="py-[3px] pl-[22px]">
								<div class="text-[12px] text-slate-600 dark:text-slate-300 leading-relaxed prose-compact">
									<TextMessage content={item.text as string} />
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

	</div>

{:else}
	<!-- Assistant / reasoning / system -->
	<div
		bind:this={scrollContainer}
		onscroll={handleScroll}
		class="text-slate-900 dark:text-slate-100 {roleCategory === 'system' ? 'max-h-48 overflow-y-auto' : ''}"
	>
		{#if roleCategory === 'reasoning'}
			<!-- Reasoning row — same icon, indent, color and font as the tool rows -->
			<div class="flex items-start gap-2 py-[2px] min-w-0">
				<span class="relative shrink-0 w-[14px] mt-[1px] flex items-center justify-center text-slate-500 dark:text-slate-400 z-10">
					<span class="absolute inset-0 -m-[3px] rounded bg-slate-50 dark:bg-slate-900"></span>
					<Icon name="lucide:sparkles" class="relative w-[13px] h-[13px]" />
				</span>
				<span class="text-[12px] text-slate-500 dark:text-slate-400">
					{#if isThinkingInProgress}Thinking{thinkingDots}{:else}Thought for a moment{/if}
				</span>
			</div>
		{:else}
			<MessageFormatter {message} />
		{/if}
	</div>
{/if}

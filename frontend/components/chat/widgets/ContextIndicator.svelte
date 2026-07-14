<!--
  Context Window Indicator (compact)

  Displays remaining context window as a mini progress bar in the PanelHeader.
  Click to show detail popover with token breakdown.
  Uses the session's actual model to determine context window size.
-->

<script lang="ts">
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { getContextUsage } from '$frontend/utils/context-manager';
	import type { TokenUsage } from '$shared/types/unified';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { formatTokens } from '$frontend/utils/format';

	interface Props {
		isMobile?: boolean;
	}

	const { isMobile = false }: Props = $props();

	// Resolve model: prefer session model (actual), fallback to selected model
	const model = $derived(
		modelStore.getById(sessionState.currentSession?.model_id || settings.selectedModelId)
	);

	const usage = $derived(
		model ? getContextUsage(sessionState.messages, model.limit.input) : null
	);

	const barColor = $derived.by(() => {
		if (!usage) return 'bg-slate-400';
		if (usage.percentage >= 90) return 'bg-red-500';
		if (usage.percentage >= 80) return 'bg-amber-500';
		if (usage.percentage >= 60) return 'bg-yellow-500';
		return 'bg-emerald-500';
	});

	// Stroke variant of the threshold color for the compact ring gauge
	const ringColor = $derived.by(() => {
		if (!usage) return 'stroke-slate-400';
		if (usage.percentage >= 90) return 'stroke-red-500';
		if (usage.percentage >= 80) return 'stroke-amber-500';
		if (usage.percentage >= 60) return 'stroke-yellow-500';
		return 'stroke-emerald-500';
	});

	// Ring geometry — radius 8 in a 20x20 viewBox
	const RING_CIRCUMFERENCE = 2 * Math.PI * 8;
	const ringOffset = $derived(
		usage ? RING_CIRCUMFERENCE * (1 - Math.min(usage.percentage, 100) / 100) : RING_CIRCUMFERENCE
	);

	const textColor = $derived.by(() => {
		if (!usage) return 'text-slate-400';
		if (usage.percentage >= 90) return 'text-red-500';
		if (usage.percentage >= 80) return 'text-amber-500';
		if (usage.percentage >= 60) return 'text-yellow-500';
		return 'text-slate-500';
	});

	// Popover state
	let showPopover = $state(false);
	let containerRef = $state<HTMLDivElement | null>(null);

	function togglePopover(e: MouseEvent) {
		e.stopPropagation();
		showPopover = !showPopover;
	}

	$effect(() => {
		if (showPopover) {
			const handleClickOutside = (e: MouseEvent) => {
				if (containerRef && !containerRef.contains(e.target as Node)) {
					showPopover = false;
				}
			};
			document.addEventListener('click', handleClickOutside, true);
			return () => document.removeEventListener('click', handleClickOutside, true);
		}
	});


	// Get last assistant message usage for detail breakdown
	const lastUsage = $derived.by((): TokenUsage | null => {
		for (let i = sessionState.messages.length - 1; i >= 0; i--) {
			const msg = sessionState.messages[i];
			if (msg.type === 'assistant' && 'usage' in msg && msg.usage) {
				return msg.usage as TokenUsage;
			}
		}
		return null;
	});
</script>

{#if usage}
	<div class="relative" bind:this={containerRef}>
		<button
			type="button"
			class="flex items-center justify-center px-2 @max-[26rem]:px-0 {isMobile ? 'h-8 @max-[26rem]:w-9' : 'h-6 @max-[26rem]:w-7'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 group"
			onclick={togglePopover}
			title="Context: {formatTokens(usage.current)} / {formatTokens(usage.max)} ({Math.round(usage.percentage)}%)"
		>
			<div class="flex items-center gap-1.5">
				<!-- Default: linear bar + %. Collapses to a ring-only when the panel/dock is narrow (container query on PanelHeader). -->
				<div class="flex items-center gap-1.5 @max-[26rem]:hidden">
					<div class="{isMobile ? 'w-14' : 'w-12'} h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
						<div
							class="{barColor} h-full transition-all duration-500"
							style="width: {Math.min(usage.percentage, 100)}%"
						></div>
					</div>
					<span class="text-2xs font-medium {textColor} tabular-nums group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">
						{Math.round(usage.percentage)}%
					</span>
				</div>

				<!-- Narrow / dock kecil: ring only -->
				<svg
					class="hidden @max-[26rem]:block {isMobile ? 'w-4.5 h-4.5' : 'w-4 h-4'} -rotate-90 shrink-0"
					viewBox="0 0 20 20"
					fill="none"
				>
					<circle cx="10" cy="10" r="8" stroke-width="2.5" class="stroke-slate-200 dark:stroke-slate-700" />
					<circle
						cx="10"
						cy="10"
						r="8"
						stroke-width="2.5"
						stroke-linecap="round"
						class="{ringColor} transition-all duration-500"
						stroke-dasharray={RING_CIRCUMFERENCE}
						stroke-dashoffset={ringOffset}
					/>
				</svg>
			</div>
		</button>

		<!-- Detail popover -->
		{#if showPopover}
			<div class="fixed inset-0 z-40" onclick={() => showPopover = false}></div>
			<div class="absolute top-full right-0 mt-2 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg min-w-60 p-3.5">
				<div class="flex items-center gap-2 mb-3">
					<Icon name="lucide:brain" class="w-4 h-4 text-violet-500" />
					<span class="text-xs font-semibold text-slate-900 dark:text-slate-100">Context Window</span>
				</div>

				<!-- Progress bar (larger) -->
				<div class="mb-3">
					<div class="w-full h-2.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
						<div
							class="{barColor} h-full transition-all duration-500"
							style="width: {Math.min(usage.percentage, 100)}%"
						></div>
					</div>
					<div class="flex justify-between mt-1.5">
						<span class="text-2xs text-slate-500">{formatTokens(usage.current)} used</span>
						<span class="text-2xs text-slate-500">{formatTokens(usage.max)} max</span>
					</div>
				</div>

				<!-- Token breakdown -->
				{#if lastUsage}
					<div class="space-y-2 border-t border-slate-200 dark:border-slate-700 pt-2.5">
						{#if model}
							<div class="flex justify-between items-center">
								<span class="text-2xs text-slate-500">Model</span>
								<span class="text-2xs font-mono font-medium text-slate-700 dark:text-slate-300 truncate max-w-32">
									{model.engine.model.name}
								</span>
							</div>
						{/if}
						<div class="flex justify-between items-center">
							<span class="text-2xs text-slate-500">Input</span>
							<span class="text-2xs font-mono font-medium text-slate-700 dark:text-slate-300">
								{(lastUsage.inputTokens ?? 0).toLocaleString()}
							</span>
						</div>
						<div class="flex justify-between items-center">
							<span class="text-2xs text-slate-500">Output</span>
							<span class="text-2xs font-mono font-medium text-slate-700 dark:text-slate-300">
								{(lastUsage.outputTokens ?? 0).toLocaleString()}
							</span>
						</div>
						{#if lastUsage.cacheReadInputTokens > 0}
							<div class="flex justify-between items-center">
								<span class="text-2xs text-slate-500">Cache Read</span>
								<span class="text-2xs font-mono font-medium text-emerald-600 dark:text-emerald-400">
									{(lastUsage.cacheReadInputTokens).toLocaleString()}
								</span>
							</div>
						{/if}
						{#if lastUsage.cacheCreationInputTokens > 0}
							<div class="flex justify-between items-center">
								<span class="text-2xs text-slate-500">Cache Write</span>
								<span class="text-2xs font-mono font-medium text-slate-700 dark:text-slate-300">
									{(lastUsage.cacheCreationInputTokens).toLocaleString()}
								</span>
							</div>
						{/if}
					</div>
				{/if}

				<!-- Remaining -->
				<div class="border-t border-slate-200 dark:border-slate-700 pt-2.5 mt-2.5">
					<div class="flex justify-between items-center">
						<span class="text-2xs font-medium text-slate-600 dark:text-slate-400">Remaining</span>
						<span class="text-2xs font-mono font-semibold {textColor}">
							{formatTokens(Math.max(0, usage.max - usage.current))} tokens
						</span>
					</div>
				</div>
			</div>
		{/if}
	</div>
{/if}

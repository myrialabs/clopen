<!--
  Usage Quota Indicator (compact)

  Displays remaining usage quota as a bar/text or mini progress ring depending on width.
  Click to show detail popover with quota breakdown and manual refresh.
-->

<script lang="ts">
	import { chatModelState } from '$frontend/stores/ui/chat-model.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { UsageSnapshot } from '$shared/types/unified';
	import ws from '$frontend/utils/ws';
	import { claudeAccountsStore } from '$frontend/stores/features/claude-accounts.svelte';
	import { copilotAccountsStore } from '$frontend/stores/features/copilot-accounts.svelte';
	import { codexAccountsStore } from '$frontend/stores/features/codex-accounts.svelte';
	import { opencodeProvidersStore } from '$frontend/stores/features/opencode-providers.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';

	interface Props {
		isMobile?: boolean;
	}

	const { isMobile = false }: Props = $props();

	// Quota/Usage state
	let usageSnapshot = $state<UsageSnapshot | null>(null);
	let isLoading = $state(false);
	let usageError = $state('');

	const remainingPercent = $derived(
		usageSnapshot?.quotas?.[0]?.percentRemaining
	);

	const hasAccounts = $derived.by(() => {
		const engine = chatModelState.engine;
		if (engine === 'claude-code') return claudeAccountsStore.accounts.length > 0;
		if (engine === 'copilot') return copilotAccountsStore.accounts.length > 0;
		if (engine === 'codex') return codexAccountsStore.accounts.length > 0;
		if (engine === 'opencode') {
			return opencodeProvidersStore.providers.some(p => p.slug !== 'opencode' && p.accounts.length > 0);
		}
		return false;
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

	async function fetchUsage(engineType: string, accountId?: number) {
		if (engineType === 'qwen' || !hasAccounts) {
			usageSnapshot = null;
			return;
		}
		isLoading = true;
		usageError = '';
		try {
			const result = await ws.http('engine:get-usage', { engineType, accountId });
			if (result.success && result.snapshot) {
				usageSnapshot = result.snapshot;
			} else {
				usageSnapshot = null;
				usageError = result.error || 'Failed to fetch usage';
			}
		} catch (err: any) {
			usageSnapshot = null;
			usageError = err?.message || 'Failed to fetch usage';
		} finally {
			isLoading = false;
		}
	}

	function handleRefresh(e: MouseEvent) {
		e.stopPropagation();
		if (chatModelState.engine && hasAccounts) {
			fetchUsage(chatModelState.engine, chatModelState.accountId ?? undefined);
		}
	}

	$effect(() => {
		const engine = chatModelState.engine;
		const accountId = chatModelState.accountId;
		// Track message generation loading state to trigger updates
		sessionState.isLoading;
		if (engine && hasAccounts) {
			fetchUsage(engine, accountId ?? undefined);
		}
	});

	const textColorClass = $derived.by(() => {
		if (remainingPercent === undefined) return 'text-slate-500';
		if (remainingPercent > 40) return 'text-emerald-500 dark:text-emerald-400';
		if (remainingPercent > 15) return 'text-amber-500 dark:text-amber-400';
		return 'text-rose-500 dark:text-rose-400';
	});
</script>

{#if chatModelState.engine !== 'qwen' && hasAccounts}
	<div class="relative" bind:this={containerRef}>
		<button
			type="button"
			class="flex items-center justify-center px-1.5 {isMobile ? 'h-8' : 'h-6'} bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 group"
			onclick={togglePopover}
			title={remainingPercent !== undefined ? `Quota: ${Math.round(remainingPercent)}% left` : usageError ? `Error: ${usageError}` : 'Loading quota...'}
		>
			<div class="flex items-center gap-1.5">
				{#if isLoading && remainingPercent === undefined}
					<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
				{:else if usageError}
					<!-- Error/Failed state: warning icon -->
					<div class="flex items-center gap-1 text-rose-500 dark:text-rose-400">
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
						<span class="text-2xs font-semibold @max-[32rem]:hidden">Error</span>
					</div>
				{:else if remainingPercent !== undefined}
					<!-- Default: Gauge + % text -->
					<div class="flex items-center gap-1.5 @max-[32rem]:hidden">
						<Icon name="lucide:gauge" class="w-3.5 h-3.5 text-violet-500" />
						<span class="text-2xs font-medium tabular-nums text-slate-500 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">
							{Math.round(remainingPercent)}%
						</span>
					</div>

					<!-- Narrow / dock kecil: percentage text only, color-coded -->
					<div class="hidden @max-[32rem]:block">
						<span class="text-2xs font-bold tabular-nums {textColorClass}">
							{Math.round(remainingPercent)}%
						</span>
					</div>
				{/if}
			</div>
		</button>

		<!-- Detail popover -->
		{#if showPopover}
			<div class="fixed inset-0 z-40" onclick={() => showPopover = false}></div>
			<div class="absolute top-full right-0 mt-2 z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg min-w-60 p-3.5 space-y-3">
				<div class="flex items-center justify-between">
					<div class="flex items-center gap-1.5">
						<Icon name="lucide:gauge" class="w-4 h-4 text-violet-500" />
						<span class="text-xs font-semibold text-slate-900 dark:text-slate-100">Usage Quota</span>
					</div>
					<button
						type="button"
						class="flex items-center gap-1 text-3xs font-medium text-violet-600 dark:text-violet-400 hover:text-violet-700 hover:underline bg-transparent border-none cursor-pointer p-0 disabled:opacity-50"
						disabled={isLoading}
						onclick={handleRefresh}
					>
						{#if isLoading}
							<Icon name="lucide:loader" class="w-3 h-3 animate-spin" />
							Refreshing...
						{:else}
							<Icon name="lucide:refresh-cw" class="w-2.5 h-2.5" />
							Refresh
						{/if}
					</button>
				</div>

				{#if usageSnapshot?.quotas && usageSnapshot.quotas.length > 0}
					<div class="space-y-3">
						{#each usageSnapshot.quotas as quota}
							{@const qPct = quota.percentRemaining}
							{@const colorClass = qPct > 40 ? 'bg-emerald-500' : qPct > 15 ? 'bg-amber-500' : 'bg-rose-500'}
							{@const textClass = qPct > 40 ? 'text-emerald-600 dark:text-emerald-400' : qPct > 15 ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400'}
							<div class="space-y-1.5">
								<div class="flex items-center justify-between text-3xs font-medium">
									<span class="text-slate-600 dark:text-slate-400">{quota.quotaType}</span>
									<span class="font-mono {textClass}">{Math.round(qPct)}% left</span>
								</div>
								<div class="w-full h-1 bg-slate-200 dark:bg-slate-700/60 rounded-full overflow-hidden">
									<div class="h-full rounded-full transition-all duration-300 {colorClass}" style="width: {qPct}%"></div>
								</div>
								{#if quota.resetText || quota.resetsAt}
									<div class="flex items-center justify-between text-4xs text-slate-400 dark:text-slate-500">
										<span>{quota.resetText || ''}</span>
										{#if quota.resetsAt}
											<span>Resets {new Date(quota.resetsAt).toLocaleString()}</span>
										{/if}
									</div>
								{/if}
							</div>
						{/each}
					</div>
				{:else if usageError}
					<div class="text-3xs text-rose-500">{usageError}</div>
				{:else}
					<div class="text-3xs text-slate-500 italic">No usage quota information.</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

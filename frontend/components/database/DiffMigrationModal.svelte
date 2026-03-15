<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { dbDiffState, applyMigration } from '$frontend/stores/features/db-diff.svelte';

	let activeTab = $state<'up' | 'down'>('up');
	let showApplyConfirm = $state(false);

	const migration = $derived(dbDiffState.migration);
	const warnings = $derived(migration?.warnings ?? []);

	function close(): void {
		dbDiffState.showMigrationModal = false;
		showApplyConfirm = false;
		activeTab = 'up';
	}

	async function copyToClipboard(text: string): Promise<void> {
		await navigator.clipboard.writeText(text);
		addNotification({ type: 'success', title: 'Copied', message: 'SQL copied to clipboard', duration: 2000 });
	}

	async function handleApply(): Promise<void> {
		showApplyConfirm = false;
		await applyMigration();
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') close();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if dbDiffState.showMigrationModal && migration}
	<div
		class="fixed inset-0 z-[200] flex items-center justify-center md:p-4 bg-black/60 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Migration Script"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) close(); }}
		onkeydown={handleKeydown}
		in:fade={{ duration: 150, easing: cubicOut }}
		out:fade={{ duration: 100, easing: cubicOut }}
	>
		<div
			class="flex flex-col w-full max-w-3xl h-[80dvh] max-h-[680px] bg-white dark:bg-slate-950 border border-violet-500/20 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)] max-md:max-w-full max-md:h-dvh max-md:max-h-dvh max-md:rounded-none"
			role="presentation"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			in:scale={{ duration: 200, easing: cubicOut, start: 0.96 }}
			out:scale={{ duration: 120, easing: cubicOut, start: 0.96 }}
		>
			<!-- Header -->
			<header class="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
					<Icon name="lucide:file-code" class="w-4 h-4 text-violet-600" />
				</div>
				<div class="flex-1 min-w-0">
					<h2 class="text-sm font-bold text-slate-800 dark:text-slate-200">Migration Script</h2>
					<p class="text-3xs text-slate-400">
						{migration.warnings.length > 0 ? `${migration.warnings.length} warning(s) — review before applying` : 'Review SQL before applying to target database'}
					</p>
				</div>
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
					onclick={close}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</header>

			<!-- Tabs -->
			<div class="flex items-center gap-1 px-4 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<button
					type="button"
					class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
						{activeTab === 'up'
							? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
							: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					onclick={() => (activeTab = 'up')}
				>
					<Icon name="lucide:arrow-up" class="w-3.5 h-3.5" />
					UP — Apply changes
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
						{activeTab === 'down'
							? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
							: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					onclick={() => (activeTab = 'down')}
				>
					<Icon name="lucide:arrow-down" class="w-3.5 h-3.5" />
					DOWN — Rollback
				</button>

				<div class="flex-1"></div>

				<button
					type="button"
					class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
					onclick={() => copyToClipboard(activeTab === 'up' ? migration.up : migration.down)}
				>
					<Icon name="lucide:copy" class="w-3.5 h-3.5" />
					Copy
				</button>
			</div>

			<!-- Warnings (if any) -->
			{#if warnings.length > 0}
				<div class="shrink-0 mx-4 mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/40">
					<div class="flex items-center gap-1.5 mb-1.5">
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
						<span class="text-xs font-semibold text-amber-700 dark:text-amber-400">
							{warnings.length} warning{warnings.length > 1 ? 's' : ''}
						</span>
					</div>
					<ul class="space-y-0.5">
						{#each warnings as warning}
							<li class="text-3xs text-amber-700 dark:text-amber-300 leading-relaxed">• {warning}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<!-- SQL Code view -->
			<div class="flex-1 min-h-0 overflow-auto mx-4 mt-3 mb-1 rounded-lg bg-slate-950 dark:bg-black/40 border border-slate-800">
				<pre class="p-4 text-3xs font-mono leading-relaxed text-slate-300 whitespace-pre-wrap break-all">{activeTab === 'up' ? migration.up : migration.down}</pre>
			</div>

			<!-- Footer -->
			<footer class="shrink-0 px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
				<p class="text-3xs text-slate-400">
					Applying will execute the <strong class="text-slate-600 dark:text-slate-300">UP</strong> script against the target database.
				</p>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
						onclick={close}
					>
						Close
					</button>

					{#if showApplyConfirm}
						<div class="flex items-center gap-1.5">
							<span class="text-xs text-amber-600 dark:text-amber-400 font-medium">Confirm apply?</span>
							<button
								type="button"
								class="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors
									{dbDiffState.isApplying ? 'opacity-60 cursor-not-allowed' : ''}"
								disabled={dbDiffState.isApplying}
								onclick={handleApply}
							>
								{dbDiffState.isApplying ? 'Applying…' : 'Yes, Apply'}
							</button>
							<button
								type="button"
								class="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
								onclick={() => (showApplyConfirm = false)}
							>
								Cancel
							</button>
						</div>
					{:else}
						<button
							type="button"
							class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
							onclick={() => (showApplyConfirm = true)}
						>
							<Icon name="lucide:play" class="w-3.5 h-3.5" />
							Apply to Target
						</button>
					{/if}
				</div>
			</footer>
		</div>
	</div>
{/if}

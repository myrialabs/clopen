<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { dbManagerState } from '$frontend/stores/features/db-manager.svelte';
	import {
		maskingState,
		getActiveMaskRules,
		setMaskRule,
		removeMaskRule,
		clearAllMaskRules,
		closeMaskingModal,
		applyMask,
		type MaskMethod
	} from '$frontend/stores/features/db-data-masking.svelte';

	const METHODS: { value: MaskMethod; label: string; example: string }[] = [
		{ value: 'partial', label: 'Partial', example: 'j***@example.com' },
		{ value: 'stars', label: 'Stars', example: '***' },
		{ value: 'random', label: 'Random', example: 'xqwz@yrtgd.zms' }
	];

	const columns = $derived(dbManagerState.columns);
	const activeRules = $derived(getActiveMaskRules());
	const tableName = $derived(dbManagerState.activeTableName ?? '');
	const activeCount = $derived(activeRules.filter((r) => r.enabled).length);

	function getRuleForColumn(column: string) {
		return activeRules.find((r) => r.column === column) ?? null;
	}

	function previewValue(column: string): string {
		// Try to find a sample value from the current browse result
		const row = dbManagerState.browseResult?.rows?.[0];
		if (!row) return 'example';
		const val = row[column];
		if (val === null || val === undefined) return 'null';
		return String(val).slice(0, 30);
	}

	function handleToggle(column: string, checked: boolean) {
		if (checked) {
			setMaskRule(column, 'partial', true);
		} else {
			removeMaskRule(column);
		}
	}

	function handleMethodChange(column: string, method: MaskMethod) {
		setMaskRule(column, method, true);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') closeMaskingModal();
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if maskingState.showModal}
	<div
		class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Data Masking"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) closeMaskingModal(); }}
		onkeydown={handleKeydown}
		in:fade={{ duration: 150, easing: cubicOut }}
		out:fade={{ duration: 100, easing: cubicOut }}
	>
		<div
			class="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<!-- Header -->
			<div class="flex items-center gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
				<div class="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/30">
					<Icon name="lucide:eye-off" class="w-4 h-4 text-amber-600 dark:text-amber-400" />
				</div>
				<div class="flex-1 min-w-0">
					<h2 class="text-sm font-semibold text-slate-800 dark:text-slate-200">Dynamic Data Masking</h2>
					<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
						{tableName} — display-only, original data is never changed
					</p>
				</div>
				<button
					type="button"
					class="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					onclick={closeMaskingModal}
					title="Close"
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<!-- Info banner -->
			<div class="flex items-start gap-2 px-5 py-2.5 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-800/50 shrink-0">
				<Icon name="lucide:shield-check" class="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
				<p class="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
					Masking is applied client-side only. The database is not affected. Exported data reflects original values.
				</p>
			</div>

			<!-- Column list -->
			<div class="flex-1 overflow-y-auto">
				{#if columns.length === 0}
					<div class="flex flex-col items-center justify-center py-12 gap-2 text-slate-400 text-sm">
						<Icon name="lucide:columns-2" class="w-6 h-6 opacity-40" />
						<span>No columns available</span>
					</div>
				{:else}
					<div class="divide-y divide-slate-100 dark:divide-slate-800">
						{#each columns as col}
							{@const rule = getRuleForColumn(col.name)}
							{@const isMasked = rule !== null}
							<div class="flex items-center gap-3 px-5 py-3 {isMasked ? 'bg-amber-50/60 dark:bg-amber-900/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/30'} transition-colors">
								<!-- Toggle -->
								<label class="relative inline-flex items-center cursor-pointer shrink-0" title="{isMasked ? 'Disable' : 'Enable'} masking for {col.name}">
									<input
										type="checkbox"
										class="sr-only peer"
										checked={isMasked}
										onchange={(e) => handleToggle(col.name, (e.currentTarget as HTMLInputElement).checked)}
									/>
									<div class="w-8 h-4 bg-slate-200 dark:bg-slate-700 peer-checked:bg-amber-500 rounded-full transition-colors peer-focus:ring-1 peer-focus:ring-amber-400"></div>
									<div class="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4"></div>
								</label>

								<!-- Column info -->
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-1.5">
										<span class="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">{col.name}</span>
										{#if col.primaryKey}
											<span class="px-1 py-0 rounded text-[10px] font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400">PK</span>
										{/if}
										{#if isMasked}
											<Icon name="lucide:eye-off" class="w-3 h-3 text-amber-500 shrink-0" />
										{/if}
									</div>
									<div class="flex items-center gap-2 mt-0.5">
										<span class="text-[11px] text-slate-400 dark:text-slate-500 font-mono">{col.type}</span>
										{#if isMasked && rule}
											{@const sample = previewValue(col.name)}
											{@const masked = applyMask(sample, rule.method)}
											<span class="text-[11px] text-amber-600 dark:text-amber-400 font-mono truncate max-w-32" title="Preview: {sample} → {masked}">
												{sample} → {masked}
											</span>
										{/if}
									</div>
								</div>

								<!-- Method selector (shown when masked) -->
								{#if isMasked && rule}
									<select
										class="px-2 py-1 rounded-md text-xs bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-300 focus:outline-none focus:ring-1 focus:ring-amber-400 shrink-0"
										value={rule.method}
										onchange={(e) => handleMethodChange(col.name, (e.currentTarget as HTMLSelectElement).value as MaskMethod)}
									>
										{#each METHODS as m}
											<option value={m.value}>{m.label} — {m.example}</option>
										{/each}
									</select>
								{/if}
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Footer -->
			<div class="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50 shrink-0">
				<div class="flex items-center gap-3">
					<span class="text-xs text-slate-500 dark:text-slate-400">
						{#if activeCount > 0}
							{activeCount} column{activeCount !== 1 ? 's' : ''} masked
						{:else}
							No columns masked
						{/if}
					</span>
					{#if activeCount > 0}
						<button
							type="button"
							class="text-xs text-red-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
							onclick={clearAllMaskRules}
						>
							Clear all
						</button>
					{/if}
				</div>
				<button
					type="button"
					class="px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white transition-colors"
					onclick={closeMaskingModal}
				>
					Done
				</button>
			</div>
		</div>
	</div>
{/if}

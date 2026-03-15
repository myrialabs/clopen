<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		datagenState,
		closeDatagen,
		startGeneration,
		setColumnStrategy,
		setColumnSkip,
		setColumnOptions
	} from '$frontend/stores/features/db-data-generator.svelte';
	import {
		FAKER_STRATEGY_LABELS,
		FAKER_STRATEGY_GROUPS
	} from '$shared/types/data-generator';
	import type { FakerStrategy } from '$shared/types/data-generator';

	// ─── Row count presets ────────────────────────────────────────────────────

	const rowPresets = [100, 500, 1000, 5000, 10000];

	// ─── Derived ──────────────────────────────────────────────────────────────

	const isBusy = $derived(datagenState.isGenerating || datagenState.isInspecting);
	const activeColCount = $derived(datagenState.columnConfigs.filter((c) => !c.skip).length);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !isBusy) closeDatagen();
	}

	function handleRowCountInput(e: Event) {
		const val = parseInt((e.target as HTMLInputElement).value, 10);
		if (!isNaN(val) && val >= 1 && val <= 10000) {
			datagenState.rowCount = val;
		}
	}

	function strategyForCol(columnName: string): FakerStrategy {
		return (
			(datagenState.columnConfigs.find((c) => c.columnName === columnName)
				?.strategy as FakerStrategy) ?? 'text'
		);
	}

	function isSkipped(columnName: string): boolean {
		return datagenState.columnConfigs.find((c) => c.columnName === columnName)?.skip ?? false;
	}

	/** FK badge text for a column */
	function fkBadge(columnName: string): string | null {
		const info = datagenState.columnInfos.find((i) => i.columnName === columnName);
		if (!info?.fkTable || !info.fkColumn) return null;
		return `→ ${info.fkTable}.${info.fkColumn}`;
	}

	/** Whether a column is a primary key */
	function isPK(columnName: string): boolean {
		return datagenState.columnInfos.find((i) => i.columnName === columnName)?.primaryKey ?? false;
	}

	/** Whether strategy supports min/max options */
	function hasNumericOptions(strategy: FakerStrategy): boolean {
		return strategy === 'integer' || strategy === 'float';
	}

	function getOptions(columnName: string) {
		return datagenState.columnConfigs.find((c) => c.columnName === columnName)?.options;
	}

	function handleMinChange(columnName: string, val: string) {
		const n = parseFloat(val);
		if (!isNaN(n)) {
			const current = getOptions(columnName) ?? {};
			setColumnOptions(columnName, { ...current, min: n });
		}
	}

	function handleMaxChange(columnName: string, val: string) {
		const n = parseFloat(val);
		if (!isNaN(n)) {
			const current = getOptions(columnName) ?? {};
			setColumnOptions(columnName, { ...current, max: n });
		}
	}

	function handleDecimalsChange(columnName: string, val: string) {
		const n = parseInt(val, 10);
		if (!isNaN(n) && n >= 0 && n <= 10) {
			const current = getOptions(columnName) ?? {};
			setColumnOptions(columnName, { ...current, decimals: n });
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if datagenState.isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Data Generator"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget && !isBusy) closeDatagen();
		}}
		onkeydown={handleKeydown}
		in:fade={{ duration: 150, easing: cubicOut }}
		out:fade={{ duration: 100, easing: cubicOut }}
	>
		<!-- Modal -->
		<div
			class="flex flex-col w-full max-w-2xl max-h-[88dvh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<!-- ─── Header ───────────────────────────────────────────────────── -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="flex items-center gap-2.5">
					<div class="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
						<Icon name="lucide:sparkles" class="w-4 h-4 text-emerald-600" />
					</div>
					<div>
						<h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Data Generator</h2>
						<p class="text-xs text-slate-400 dark:text-slate-500 font-mono">{datagenState.tableName}</p>
					</div>
				</div>
				{#if !isBusy}
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
						onclick={closeDatagen}
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				{/if}
			</div>

			<!-- ─── Body ─────────────────────────────────────────────────────── -->
			<div class="flex-1 min-h-0 overflow-y-auto">
				{#if datagenState.isInspecting}
					<!-- Loading skeleton -->
					<div class="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
						<svg class="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						<span class="text-sm">Inspecting table schema…</span>
					</div>
				{:else if datagenState.columnInfos.length > 0}
					<div class="p-5 space-y-5">
						<!-- Row count -->
						<div class="space-y-2">
							<label class="block text-xs font-semibold text-slate-700 dark:text-slate-300">
								Number of Rows
							</label>
							<div class="flex items-center gap-2 flex-wrap">
								{#each rowPresets as preset}
									<button
										type="button"
										disabled={isBusy}
										class="px-3 py-1.5 text-xs font-medium rounded-lg border-2 transition-all
											{datagenState.rowCount === preset
												? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
												: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-emerald-400 dark:hover:border-emerald-600'}"
										onclick={() => (datagenState.rowCount = preset)}
									>
										{preset.toLocaleString()}
									</button>
								{/each}
								<input
									type="number"
									min="1"
									max="10000"
									disabled={isBusy}
									value={datagenState.rowCount}
									oninput={handleRowCountInput}
									class="w-28 px-3 py-1.5 text-xs font-mono border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
									placeholder="Custom…"
								/>
							</div>
							<p class="text-xs text-slate-400 dark:text-slate-500">
								Between 1 and 10,000 rows. Large counts are streamed in batches of {datagenState.batchSize.toLocaleString()}.
							</p>
						</div>

						<!-- Column config table -->
						<div class="space-y-1.5">
							<div class="flex items-center justify-between">
								<label class="text-xs font-semibold text-slate-700 dark:text-slate-300">
									Column Strategies
								</label>
								<span class="text-xs text-slate-400">
									{activeColCount} of {datagenState.columnConfigs.length} columns active
								</span>
							</div>

							<!-- Legend -->
							<div class="flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500 mb-1">
								<span class="flex items-center gap-1">
									<span class="inline-block w-2 h-2 rounded-full bg-amber-400"></span>PK
								</span>
								<span class="flex items-center gap-1">
									<span class="inline-block w-2 h-2 rounded-full bg-violet-400"></span>FK
								</span>
							</div>

							<div class="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
								<!-- Table header -->
								<div class="grid grid-cols-[1.5rem_1fr_1fr_auto] gap-0 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700 px-3 py-2">
									<div></div>
									<span class="text-xs font-medium text-slate-500 dark:text-slate-400">Column</span>
									<span class="text-xs font-medium text-slate-500 dark:text-slate-400">Strategy</span>
									<span class="text-xs font-medium text-slate-500 dark:text-slate-400">Options</span>
								</div>

								<!-- Column rows -->
								<div class="divide-y divide-slate-100 dark:divide-slate-800">
									{#each datagenState.columnInfos as info (info.columnName)}
										{@const skipped = isSkipped(info.columnName)}
										{@const strategy = strategyForCol(info.columnName)}
										{@const fk = fkBadge(info.columnName)}
										{@const pk = isPK(info.columnName)}
										{@const opts = getOptions(info.columnName)}

										<div
											class="grid grid-cols-[1.5rem_1fr_1fr_auto] gap-2 items-start px-3 py-2.5 transition-colors
												{skipped ? 'opacity-40' : ''}"
										>
											<!-- Checkbox -->
											<input
												type="checkbox"
												checked={!skipped}
												disabled={isBusy}
												onchange={(e) =>
													setColumnSkip(info.columnName, !(e.target as HTMLInputElement).checked)}
												class="mt-0.5 w-3.5 h-3.5 rounded border-slate-300 dark:border-slate-600 text-emerald-600 cursor-pointer"
											/>

											<!-- Column info -->
											<div class="min-w-0">
												<div class="flex items-center gap-1.5 flex-wrap">
													{#if pk}
														<span class="w-2 h-2 rounded-full bg-amber-400 shrink-0" title="Primary Key"></span>
													{/if}
													{#if fk}
														<span class="w-2 h-2 rounded-full bg-violet-400 shrink-0" title="Foreign Key"></span>
													{/if}
													<span class="text-xs font-mono font-medium text-slate-800 dark:text-slate-200 truncate">
														{info.columnName}
													</span>
													{#if info.autoIncrement}
														<span class="text-3xs px-1 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-400 rounded font-medium">AUTO</span>
													{/if}
												</div>
												<span class="text-3xs text-slate-400 dark:text-slate-500 font-mono block truncate mt-0.5">
													{info.columnType}{info.nullable ? '' : ' NOT NULL'}
												</span>
												{#if fk}
													<span class="text-3xs text-violet-500 dark:text-violet-400 block mt-0.5">
														{fk}
													</span>
												{/if}
											</div>

											<!-- Strategy select -->
											<div class="min-w-0">
												<select
													disabled={skipped || isBusy}
													value={strategy}
													onchange={(e) =>
														setColumnStrategy(
															info.columnName,
															(e.target as HTMLSelectElement).value as FakerStrategy
														)}
													class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 disabled:opacity-50"
												>
													{#each FAKER_STRATEGY_GROUPS as group}
														<optgroup label={group.label}>
															{#each group.strategies as s}
																<option value={s}>{FAKER_STRATEGY_LABELS[s]}</option>
															{/each}
														</optgroup>
													{/each}
												</select>
											</div>

											<!-- Numeric options -->
											<div class="flex items-center gap-1 shrink-0">
												{#if hasNumericOptions(strategy) && !skipped}
													<input
														type="number"
														disabled={isBusy}
														value={opts?.min ?? 0}
														oninput={(e) =>
															handleMinChange(info.columnName, (e.target as HTMLInputElement).value)}
														class="w-16 px-1.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono"
														placeholder="min"
														title="Minimum value"
													/>
													<span class="text-slate-300 dark:text-slate-600 text-xs">–</span>
													<input
														type="number"
														disabled={isBusy}
														value={opts?.max ?? 1000}
														oninput={(e) =>
															handleMaxChange(info.columnName, (e.target as HTMLInputElement).value)}
														class="w-16 px-1.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono"
														placeholder="max"
														title="Maximum value"
													/>
													{#if strategy === 'float'}
														<input
															type="number"
															disabled={isBusy}
															min="0"
															max="10"
															value={opts?.decimals ?? 2}
															oninput={(e) =>
																handleDecimalsChange(
																	info.columnName,
																	(e.target as HTMLInputElement).value
																)}
															class="w-12 px-1.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-mono"
															placeholder="dec"
															title="Decimal places"
														/>
													{/if}
												{/if}
											</div>
										</div>
									{/each}
								</div>
							</div>
						</div>

						<!-- Progress (shown while generating) -->
						{#if datagenState.isGenerating}
							<div class="space-y-2">
								<div class="flex items-center justify-between text-xs">
									<span class="text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
										<svg class="w-3.5 h-3.5 animate-spin text-emerald-500" fill="none" viewBox="0 0 24 24">
											<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
											<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
										</svg>
										Generating…
									</span>
									<span class="text-slate-500 dark:text-slate-400 tabular-nums">
										{datagenState.insertedTotal.toLocaleString()} / {datagenState.rowCount.toLocaleString()} rows
									</span>
								</div>
								<div class="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
									<div
										class="h-full bg-emerald-500 rounded-full transition-all duration-300"
										style="width: {datagenState.progressPct}%"
									></div>
								</div>
								{#if datagenState.failedTotal > 0}
									<p class="text-xs text-red-500">
										{datagenState.failedTotal.toLocaleString()} rows failed
									</p>
								{/if}
							</div>
						{/if}

						<!-- Errors -->
						{#if datagenState.errors.length > 0}
							<div class="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 space-y-1">
								<p class="text-xs font-semibold text-red-700 dark:text-red-400">Errors</p>
								{#each datagenState.errors as err}
									<p class="text-xs text-red-600 dark:text-red-300 font-mono break-all">{err}</p>
								{/each}
							</div>
						{/if}

						<!-- FK info banner -->
						{#if datagenState.columnInfos.some((i) => i.fkTable)}
							<div class="flex items-start gap-2 px-3 py-2.5 bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-800 rounded-xl">
								<Icon name="lucide:link" class="w-3.5 h-3.5 text-violet-600 dark:text-violet-400 shrink-0 mt-0.5" />
								<p class="text-xs text-violet-700 dark:text-violet-300 leading-relaxed">
									Foreign key constraints detected. The generator will automatically sample valid values from the referenced tables to ensure referential integrity.
								</p>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- ─── Footer ───────────────────────────────────────────────────── -->
			<div class="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0">
				<div class="text-xs text-slate-400 dark:text-slate-500">
					{#if datagenState.isGenerating}
						{datagenState.progressPct}% complete
					{:else if activeColCount > 0}
						{activeColCount} column{activeColCount !== 1 ? 's' : ''} · {datagenState.rowCount.toLocaleString()} rows
					{/if}
				</div>
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="px-3 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
						onclick={closeDatagen}
						disabled={isBusy}
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={isBusy || activeColCount === 0}
						onclick={startGeneration}
						class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
					>
						{#if datagenState.isGenerating}
							<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
							</svg>
							Generating…
						{:else}
							<Icon name="lucide:sparkles" class="w-3.5 h-3.5" />
							Generate {datagenState.rowCount.toLocaleString()} Rows
						{/if}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

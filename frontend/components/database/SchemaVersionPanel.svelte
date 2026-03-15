<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbSchemaVersionState,
		loadVersions,
		selectVersion,
		openDiff,
		openRollback,
		exportVersion,
		startEditLabel,
		cancelEditLabel,
		saveLabel
	} from '$frontend/stores/features/db-schema-versioning.svelte';
	import SchemaVersionDiffModal from './SchemaVersionDiffModal.svelte';
	import SchemaRollbackModal from './SchemaRollbackModal.svelte';
	import type { SchemaVersionSummary } from '$shared/types/schema-versioning';

	interface Props {
		connectionId: string;
		tableName: string;
		onRollbackSuccess?: () => void;
	}

	const { connectionId, tableName, onRollbackSuccess }: Props = $props();

	// ─── Helpers ────────────────────────────────────────────────────────────────

	function formatTimestamp(dateStr: string): string {
		return new Date(dateStr).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function versionLabel(v: SchemaVersionSummary): string {
		return v.label ?? `v${v.versionNumber}`;
	}

	function changesSummary(v: SchemaVersionSummary): string {
		if (v.changesCount === 0) return 'Rollback entry';
		return `${v.changesCount} change${v.changesCount !== 1 ? 's' : ''}`;
	}

	// ─── Diff selector (pick two versions to compare) ────────────────────────

	let compareSelectId = $state<string | null>(null);

	function startCompare(id: string): void {
		if (!compareSelectId) {
			compareSelectId = id;
		} else if (compareSelectId === id) {
			compareSelectId = null;
		} else {
			openDiff(compareSelectId, id);
			compareSelectId = null;
		}
	}

	function cancelCompare(): void {
		compareSelectId = null;
	}

	onMount(async () => {
		if (connectionId !== dbSchemaVersionState.connectionId || tableName !== dbSchemaVersionState.tableName) {
			dbSchemaVersionState.connectionId = connectionId;
			dbSchemaVersionState.tableName = tableName;
		}
		await loadVersions();
	});
</script>

<div class="flex flex-col h-full min-h-0">
	<!-- ─── Header ───────────────────────────────────────────────────────────── -->
	<div class="shrink-0 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/60 flex items-center gap-2">
		<Icon name="lucide:history" class="w-4 h-4 text-violet-500 shrink-0" />
		<div class="flex-1 min-w-0">
			<p class="text-xs font-semibold text-slate-800 dark:text-slate-200">Schema Version History</p>
			<p class="text-3xs text-slate-400 truncate">{tableName}</p>
		</div>
		<button
			type="button"
			class="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
			onclick={() => loadVersions()}
			title="Refresh"
		>
			<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 text-slate-400" />
		</button>
	</div>

	<!-- ─── Compare mode banner ─────────────────────────────────────────────── -->
	{#if compareSelectId}
		<div class="shrink-0 px-3 py-2 bg-violet-50 dark:bg-violet-900/20 border-b border-violet-200 dark:border-violet-800/40 flex items-center gap-2">
			<Icon name="lucide:git-compare" class="w-3.5 h-3.5 text-violet-500 shrink-0" />
			<span class="text-xs text-violet-700 dark:text-violet-300 flex-1">
				Select a second version to compare
			</span>
			<button
				type="button"
				class="text-xs text-violet-500 hover:text-violet-700 dark:hover:text-violet-300"
				onclick={cancelCompare}
			>
				Cancel
			</button>
		</div>
	{/if}

	<!-- ─── Version list ─────────────────────────────────────────────────────── -->
	<div class="flex-1 min-h-0 overflow-y-auto">
		{#if dbSchemaVersionState.isLoading}
			<div class="flex items-center justify-center h-24 gap-2 text-slate-400 text-xs">
				<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				Loading versions…
			</div>
		{:else if dbSchemaVersionState.versions.length === 0}
			<div class="flex flex-col items-center justify-center h-32 gap-2 p-4 text-center">
				<Icon name="lucide:git-branch" class="w-7 h-7 text-slate-300 dark:text-slate-600" />
				<p class="text-xs font-medium text-slate-500 dark:text-slate-400">No schema versions yet</p>
				<p class="text-3xs text-slate-400 dark:text-slate-500">
					Apply ALTER TABLE changes via Table Architect to start tracking versions.
				</p>
			</div>
		{:else}
			<!-- Timeline list -->
			<div class="relative px-3 py-2 space-y-1">
				<!-- Vertical timeline line -->
				<div class="absolute left-[22px] top-4 bottom-4 w-px bg-slate-200 dark:bg-slate-700"></div>

				{#each dbSchemaVersionState.versions as version (version.id)}
					{@const isSelected = dbSchemaVersionState.selectedVersion?.id === version.id}
					{@const isCompareTarget = compareSelectId === version.id}
					{@const isRolledBack = version.status === 'rolled_back'}
					{@const isRollbackEntry = version.changesCount === 0}

					<div class="relative">
						<!-- Timeline dot -->
						<div class="absolute left-0 top-3 z-10 flex items-center justify-center w-5 h-5 rounded-full border-2
							{isRolledBack ? 'border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800' :
							 isRollbackEntry ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/30' :
							 'border-violet-400 bg-white dark:bg-slate-900'}">
							{#if isRolledBack}
								<div class="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-500"></div>
							{:else if isRollbackEntry}
								<Icon name="lucide:rotate-ccw" class="w-2.5 h-2.5 text-amber-500" />
							{:else}
								<div class="w-1.5 h-1.5 rounded-full bg-violet-500"></div>
							{/if}
						</div>

						<!-- Version card -->
						<div class="ml-7 rounded-lg border transition-all
							{isCompareTarget ? 'border-violet-400 bg-violet-50 dark:bg-violet-900/20' :
							 isSelected ? 'border-violet-300 dark:border-violet-700 bg-violet-50/50 dark:bg-violet-900/10' :
							 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 hover:border-slate-300 dark:hover:border-slate-700'}">
							<!-- Card header (clickable) -->
							<!-- svelte-ignore a11y_interactive_supports_focus -->
							<div
								role="button"
								class="w-full text-left px-3 py-2 cursor-pointer"
								onclick={() => selectVersion(version.id)}
								onkeydown={(e) => e.key === 'Enter' && selectVersion(version.id)}
							>
								<div class="flex items-start gap-2">
									<!-- Version badge + label -->
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-1.5 flex-wrap">
											<span class="font-mono text-3xs font-bold
												{isRolledBack ? 'text-slate-400' : 'text-violet-600 dark:text-violet-400'}">
												v{version.versionNumber}
											</span>

											{#if dbSchemaVersionState.editingLabelId === version.id}
												<!-- Label edit inline -->
												<input
													type="text"
													bind:value={dbSchemaVersionState.editingLabelValue}
													class="flex-1 text-3xs px-1.5 py-0.5 rounded border border-violet-400 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-500"
													placeholder="Add label…"
													onclick={(e) => e.stopPropagation()}
													onkeydown={(e) => {
														if (e.key === 'Enter') { e.stopPropagation(); saveLabel(); }
														if (e.key === 'Escape') { e.stopPropagation(); cancelEditLabel(); }
													}}
												/>
												<button
													type="button"
													class="text-3xs text-violet-600 font-medium"
													onclick={(e) => { e.stopPropagation(); saveLabel(); }}
												>Save</button>
												<button
													type="button"
													class="text-3xs text-slate-400"
													onclick={(e) => { e.stopPropagation(); cancelEditLabel(); }}
												>Cancel</button>
											{:else}
												<span
													class="text-xs font-medium truncate
														{isRolledBack ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-200'}"
												>
													{versionLabel(version)}
												</span>
												{#if !isRolledBack}
													<button
														type="button"
														class="opacity-0 group-hover:opacity-100 p-0.5 text-slate-300 hover:text-violet-500 transition-all"
														onclick={(e) => { e.stopPropagation(); startEditLabel(version.id, version.label); }}
														title="Edit label"
													>
														<Icon name="lucide:pencil" class="w-2.5 h-2.5" />
													</button>
												{/if}
											{/if}

											<!-- Status badge -->
											{#if isRolledBack}
												<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-500">
													rolled back
												</span>
											{:else if isRollbackEntry}
												<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">
													rollback
												</span>
											{/if}
										</div>

										<!-- Meta -->
										<div class="flex items-center gap-2 mt-0.5 flex-wrap">
											<span class="text-3xs text-slate-400">{formatTimestamp(version.appliedAt)}</span>
											<span class="text-3xs text-slate-400">by {version.appliedByName}</span>
											<span class="text-3xs text-slate-400">{changesSummary(version)}</span>
										</div>
									</div>

									<!-- Chevron -->
									<Icon
										name={isSelected ? 'lucide:chevron-down' : 'lucide:chevron-right'}
										class="w-3.5 h-3.5 shrink-0 text-slate-400 mt-1"
									/>
								</div>
							</div>

							<!-- Expanded detail -->
							{#if isSelected && dbSchemaVersionState.selectedVersion?.id === version.id}
								{@const detail = dbSchemaVersionState.selectedVersion}
								<div class="border-t border-slate-100 dark:border-slate-800 px-3 py-2 space-y-2">
									{#if dbSchemaVersionState.isLoadingDetail}
										<div class="flex items-center gap-2 text-3xs text-slate-400 py-2">
											<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
												<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
												<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
											</svg>
											Loading…
										</div>
									{:else if detail}
										<!-- Changes list -->
										{#if detail.changes.length > 0}
											<div>
												<p class="text-3xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Changes</p>
												<div class="space-y-0.5">
													{#each detail.changes as change}
														<div class="flex items-center gap-1.5 text-3xs">
															<span class="font-mono font-bold w-10 shrink-0
																{change.type === 'add' ? 'text-emerald-600 dark:text-emerald-400' :
																 change.type === 'drop' ? 'text-red-500 dark:text-red-400' :
																 'text-amber-600 dark:text-amber-400'}">
																{change.type.toUpperCase()}
															</span>
															<span class="font-mono text-slate-600 dark:text-slate-300">{change.columnName}</span>
															{#if change.type === 'rename' && change.newName}
																<Icon name="lucide:arrow-right" class="w-2.5 h-2.5 text-slate-400" />
																<span class="font-mono text-slate-600 dark:text-slate-300">{change.newName}</span>
															{/if}
															{#if (change.type === 'add' || change.type === 'modify') && change.newDef}
																<span class="text-slate-400">{change.newDef.type}</span>
																{#if !change.newDef.nullable}<span class="text-slate-400">NOT NULL</span>{/if}
															{/if}
														</div>
													{/each}
												</div>
											</div>
										{/if}

										<!-- Up SQL -->
										{#if detail.upStatements.length > 0}
											<div>
												<div class="flex items-center justify-between mb-1">
													<p class="text-3xs font-semibold text-slate-500 uppercase tracking-wide">Up SQL</p>
													<button
														type="button"
														class="text-3xs text-violet-500 hover:text-violet-700 flex items-center gap-1"
														onclick={() => exportVersion(detail.id, 'up')}
													>
														<Icon name="lucide:download" class="w-2.5 h-2.5" />
														Export
													</button>
												</div>
												<pre class="text-3xs font-mono bg-slate-50 dark:bg-slate-800/60 rounded p-2 overflow-x-auto text-slate-600 dark:text-slate-300 leading-relaxed">{detail.upStatements.join(';\n')}</pre>
											</div>
										{/if}

										<!-- Down SQL -->
										{#if detail.downStatements.length > 0}
											<div>
												<div class="flex items-center justify-between mb-1">
													<p class="text-3xs font-semibold text-slate-500 uppercase tracking-wide">Down SQL (rollback)</p>
													<button
														type="button"
														class="text-3xs text-violet-500 hover:text-violet-700 flex items-center gap-1"
														onclick={() => exportVersion(detail.id, 'down')}
													>
														<Icon name="lucide:download" class="w-2.5 h-2.5" />
														Export
													</button>
												</div>
												<pre class="text-3xs font-mono bg-red-50 dark:bg-red-900/10 rounded p-2 overflow-x-auto text-red-600 dark:text-red-400 leading-relaxed">{detail.downStatements.join(';\n')}</pre>
											</div>
										{/if}

										<!-- Action buttons -->
										<div class="flex items-center gap-2 pt-1">
											{#if !isRolledBack}
												<button
													type="button"
													class="flex items-center gap-1 px-2 py-1 rounded-md text-3xs font-medium bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
													onclick={() => openRollback(detail.id)}
												>
													<Icon name="lucide:rotate-ccw" class="w-3 h-3" />
													Rollback this version
												</button>
											{/if}
											<button
												type="button"
												class="flex items-center gap-1 px-2 py-1 rounded-md text-3xs font-medium bg-violet-50 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 hover:bg-violet-100 dark:hover:bg-violet-900/30 transition-colors"
												onclick={() => startCompare(detail.id)}
											>
												<Icon name="lucide:git-compare" class="w-3 h-3" />
												{compareSelectId && compareSelectId !== detail.id ? 'Compare with selected' : 'Compare…'}
											</button>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- Modals -->
<SchemaVersionDiffModal />
<SchemaRollbackModal onSuccess={onRollbackSuccess} />

<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		processManagerState,
		closeProcessManager,
		fetchProcesses,
		killProcess,
		toggleAutoRefresh
	} from '$frontend/stores/features/db-process-manager.svelte';
	import type { DBProcess, KillMode } from '$shared/types/process-manager';

	// ─── Kill confirmation dialog ──────────────────────────────────────────────
	let confirmKill = $state<{ process: DBProcess; mode: KillMode } | null>(null);

	async function handleKill(process: DBProcess, mode: KillMode) {
		confirmKill = null;
		await killProcess(process.id, mode);
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────
	function durationClass(sec: number): string {
		if (sec >= 30) return 'text-red-600 dark:text-red-400 font-semibold';
		if (sec >= 5) return 'text-amber-600 dark:text-amber-400 font-medium';
		return 'text-slate-500 dark:text-slate-400';
	}

	function durationBg(sec: number): string {
		if (sec >= 30) return 'bg-red-500';
		if (sec >= 5) return 'bg-amber-500';
		return 'bg-emerald-500';
	}

	function formatDuration(sec: number): string {
		if (sec < 60) return `${sec}s`;
		if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
		return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
	}

	function truncate(s: string | undefined, n = 80): string {
		if (!s) return '—';
		return s.length > n ? s.slice(0, n) + '…' : s;
	}

	// Engines that support kill-query (soft cancel) separately from kill-connection
	const supportsQueryCancel = $derived(
		['postgresql', 'mysql', 'mariadb'].includes(processManagerState.dbType)
	);

	// Whether this DB type supports Process Manager at all
	const isSupported = $derived(
		['mysql', 'mariadb', 'postgresql', 'mssql', 'mongodb', 'redis'].includes(
			processManagerState.dbType
		)
	);

	const fetchedAtLabel = $derived(() => {
		if (!processManagerState.fetchedAt) return '';
		return new Date(processManagerState.fetchedAt).toLocaleTimeString();
	});
</script>

{#if processManagerState.isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-[110] flex items-center justify-center md:p-4 bg-black/60 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Process Manager"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) closeProcessManager(); }}
		onkeydown={(e) => { if (e.key === 'Escape') closeProcessManager(); }}
		in:fade={{ duration: 200, easing: cubicOut }}
		out:fade={{ duration: 150, easing: cubicOut }}
	>
		<!-- Panel -->
		<div
			class="flex flex-col w-full max-w-[1000px] h-[80dvh] max-h-[700px] bg-slate-50 dark:bg-slate-950 border border-violet-500/20 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)] max-md:max-w-full max-md:h-dvh max-md:max-h-dvh max-md:rounded-none"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
			<!-- Header -->
			<header class="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 shrink-0">
				<div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
					<Icon name="lucide:activity" class="w-4 h-4 text-violet-600" />
				</div>
				<div class="flex-1 min-w-0">
					<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">Process Manager</h2>
					<p class="text-3xs text-slate-500 dark:text-slate-400">
						Monitor and manage active database sessions
						{#if processManagerState.fetchedAt}
							· Last updated {fetchedAtLabel()}
						{/if}
					</p>
				</div>

				<!-- Toolbar -->
				<div class="flex items-center gap-1.5 shrink-0">
					<!-- Auto-refresh toggle -->
					<button
						type="button"
						class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all
							{processManagerState.autoRefresh
								? 'bg-violet-600 border-violet-600 text-white'
								: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
						onclick={toggleAutoRefresh}
						title={processManagerState.autoRefresh ? 'Stop auto-refresh' : 'Auto-refresh every 5s'}
					>
						<Icon name="lucide:timer" class="w-3.5 h-3.5" />
						{processManagerState.autoRefresh ? 'Live' : 'Auto'}
					</button>

					<!-- Manual refresh -->
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40"
						onclick={fetchProcesses}
						disabled={processManagerState.isLoading}
						title="Refresh"
					>
						<Icon
							name="lucide:refresh-cw"
							class="w-3.5 h-3.5 {processManagerState.isLoading ? 'animate-spin' : ''}"
						/>
					</button>

					<!-- Close -->
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-violet-500/10 transition-all"
						onclick={closeProcessManager}
						aria-label="Close"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
			</header>

			<!-- Body -->
			<div class="flex-1 min-h-0 overflow-hidden flex flex-col">
				{#if !isSupported}
					<!-- Unsupported DB type -->
					<div class="flex flex-col items-center justify-center flex-1 gap-3 text-slate-400">
						<Icon name="lucide:ban" class="w-10 h-10 opacity-30" />
						<div class="text-center">
							<p class="text-sm font-medium text-slate-600 dark:text-slate-400">Not supported</p>
							<p class="text-xs text-slate-400 mt-1">Process Manager is not available for {processManagerState.dbType}.</p>
						</div>
					</div>
				{:else if processManagerState.isLoading && processManagerState.processes.length === 0}
					<!-- Initial loading -->
					<div class="flex items-center justify-center flex-1 gap-2 text-slate-400 text-sm">
						<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Loading processes…
					</div>
				{:else if processManagerState.processes.length === 0}
					<!-- No active processes -->
					<div class="flex flex-col items-center justify-center flex-1 gap-3 text-slate-400">
						<Icon name="lucide:circle-check" class="w-10 h-10 opacity-30" />
						<div class="text-center">
							<p class="text-sm font-medium text-slate-600 dark:text-slate-400">No active processes</p>
							<p class="text-xs text-slate-400 mt-1">The database is idle — no running queries.</p>
						</div>
					</div>
				{:else}
					<!-- Process Table -->
					<div class="flex-1 min-h-0 overflow-auto">
						<table class="min-w-full text-xs border-separate border-spacing-0">
							<!-- Sticky header with scroll-shadow via box-shadow -->
							<thead class="sticky top-0 z-10">
								<tr>
									<th class="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap shadow-[0_1px_0_0_theme(colors.slate.200)] dark:shadow-[0_1px_0_0_theme(colors.slate.700)]">
										ID
									</th>
									<th class="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
										User
									</th>
									<th class="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
										Database
									</th>
									<th class="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
										State
									</th>
									<th class="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
										Duration
									</th>
									{#if processManagerState.dbType === 'mssql'}
										<th class="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
											CPU / IO
										</th>
									{/if}
									<th class="px-3 py-2.5 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
										Query
									</th>
									<th class="w-28 px-3 py-2.5 text-right font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
										Actions
									</th>
								</tr>
							</thead>
							<tbody>
								{#each processManagerState.processes as proc (proc.id)}
									{@const isKilling = processManagerState.killingId === proc.id}
									{@const dur = proc.timeSeconds ?? 0}
									<tr class="group hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
										<!-- ID -->
										<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 font-mono text-slate-700 dark:text-slate-300 whitespace-nowrap">
											{proc.id}
										</td>

										<!-- User -->
										<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-slate-700 dark:text-slate-300 whitespace-nowrap">
											{proc.user ?? '—'}
											{#if proc.host}
												<span class="block text-3xs text-slate-400">{proc.host}</span>
											{/if}
										</td>

										<!-- Database -->
										<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-slate-600 dark:text-slate-400 whitespace-nowrap">
											{proc.database ?? '—'}
										</td>

										<!-- State -->
										<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 whitespace-nowrap">
											<span class="inline-flex items-center gap-1">
												<span class="w-1.5 h-1.5 rounded-full shrink-0
													{proc.state === 'active' || proc.state === 'executing'
														? 'bg-emerald-500'
														: proc.state === 'idle'
															? 'bg-slate-300 dark:bg-slate-600'
															: 'bg-amber-400'}"
												></span>
												<span class="text-slate-700 dark:text-slate-300">{proc.state ?? proc.command ?? '—'}</span>
											</span>
										</td>

										<!-- Duration with color + bar -->
										<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 whitespace-nowrap">
											<div class="flex flex-col gap-0.5">
												<span class={durationClass(dur)}>{formatDuration(dur)}</span>
												{#if dur > 0}
													<div class="w-16 h-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
														<div
															class="h-full rounded-full {durationBg(dur)} transition-all duration-500"
															style="width: {Math.min(100, (dur / 60) * 100)}%"
														></div>
													</div>
												{/if}
											</div>
										</td>

										<!-- CPU/IO (MSSQL only) -->
										{#if processManagerState.dbType === 'mssql'}
											<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 whitespace-nowrap text-slate-600 dark:text-slate-400">
												{#if proc.cpuMs !== undefined}
													<span class="block text-3xs">CPU {proc.cpuMs}ms</span>
												{/if}
												{#if proc.reads !== undefined}
													<span class="block text-3xs">R {proc.reads} / W {proc.writes ?? 0}</span>
												{/if}
											</td>
										{/if}

										<!-- Query text -->
										<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 max-w-xs">
											<span
												class="block font-mono text-slate-700 dark:text-slate-300 truncate"
												title={proc.query ?? ''}
											>
												{truncate(proc.query)}
											</span>
										</td>

										<!-- Actions -->
										<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 text-right whitespace-nowrap">
											{#if isKilling}
												<svg class="w-4 h-4 animate-spin text-red-400 ml-auto" fill="none" viewBox="0 0 24 24">
													<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
													<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
												</svg>
											{:else}
												<div class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
													{#if supportsQueryCancel}
														<button
															type="button"
															class="flex items-center gap-1 px-2 py-1 rounded-md text-3xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
															onclick={() => { confirmKill = { process: proc, mode: 'query' }; }}
															title="Cancel query (keep connection)"
														>
															<Icon name="lucide:ban" class="w-3 h-3" />
															Cancel
														</button>
													{/if}
													<button
														type="button"
														class="flex items-center gap-1 px-2 py-1 rounded-md text-3xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
														onclick={() => { confirmKill = { process: proc, mode: 'connection' }; }}
														title="Kill connection"
													>
														<Icon name="lucide:skull" class="w-3 h-3" />
														Kill
													</button>
												</div>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</div>

			<!-- Status bar -->
			<div class="flex items-center gap-3 px-4 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0 text-3xs text-slate-400">
				<span>
					{processManagerState.processes.length} process{processManagerState.processes.length !== 1 ? 'es' : ''} active
				</span>
				{#if processManagerState.autoRefresh}
					<span class="flex items-center gap-1 text-violet-500">
						<span class="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse"></span>
						Auto-refreshing every {processManagerState.refreshIntervalSec}s
					</span>
				{/if}
				{#if processManagerState.isLoading && processManagerState.processes.length > 0}
					<span class="flex items-center gap-1">
						<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Refreshing…
					</span>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Kill confirmation dialog -->
{#if confirmKill}
	<div
		class="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 backdrop-blur-sm"
		onclick={(e) => { if (e.target === e.currentTarget) confirmKill = null; }}
		onkeydown={(e) => { if (e.key === 'Escape') confirmKill = null; }}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		in:fade={{ duration: 150, easing: cubicOut }}
		out:fade={{ duration: 100, easing: cubicOut }}
	>
		<div
			class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-5 w-80 max-w-[90vw]"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			in:scale={{ duration: 200, easing: cubicOut, start: 0.95 }}
		>
			<div class="flex items-start gap-3 mb-4">
				<div class="w-9 h-9 rounded-lg bg-red-100 dark:bg-red-900/30 flex items-center justify-center shrink-0">
					<Icon name="lucide:triangle-alert" class="w-5 h-5 text-red-600 dark:text-red-400" />
				</div>
				<div>
					<h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
						{confirmKill.mode === 'query' ? 'Cancel Query' : 'Kill Connection'}?
					</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400 mt-1">
						{confirmKill.mode === 'query'
							? 'This will cancel the running query but keep the connection open.'
							: 'This will immediately terminate the connection and abort all running queries.'}
					</p>
					<p class="text-xs font-mono text-slate-600 dark:text-slate-300 mt-2 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
						PID / ID: {confirmKill.process.id}
						{#if confirmKill.process.user}· {confirmKill.process.user}{/if}
					</p>
				</div>
			</div>
			<div class="flex items-center gap-2 justify-end">
				<button
					type="button"
					class="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					onclick={() => { confirmKill = null; }}
				>
					Cancel
				</button>
				<button
					type="button"
					class="px-3 py-1.5 text-xs font-medium rounded-lg
						{confirmKill.mode === 'query'
							? 'bg-amber-500 hover:bg-amber-600 text-white'
							: 'bg-red-600 hover:bg-red-700 text-white'}
						transition-colors"
					onclick={() => confirmKill && handleKill(confirmKill.process, confirmKill.mode)}
				>
					{confirmKill.mode === 'query' ? 'Cancel Query' : 'Kill Connection'}
				</button>
			</div>
		</div>
	</div>
{/if}

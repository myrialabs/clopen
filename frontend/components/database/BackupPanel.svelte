<script lang="ts">
	import { fade, slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbBackupState,
		closeBackupPanel,
		loadBackupConfigs,
		createBackupConfig,
		updateBackupConfig,
		deleteBackupConfig,
		runBackupNow,
		toggleHistoryPanel,
		showNewConfigForm,
		showEditConfigForm,
		cancelForm
	} from '$frontend/stores/features/db-backup.svelte';
	import type { BackupConfig } from '$shared/types/db-export';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	// ─── Form state ──────────────────────────────────────────────────────────

	let form = $state<Partial<BackupConfig>>({
		provider: 'aws-s3',
		frequency: 'daily',
		hour: 2,
		bucket: '',
		prefix: 'clopen-backups/',
		retentionDays: 30,
		enabled: true,
		name: ''
	});

	let showDeleteConfirm = $state<string | null>(null);

	// Reset form when editing config changes
	$effect(() => {
		if (dbBackupState.editingConfig) {
			form = { ...dbBackupState.editingConfig };
		} else if (dbBackupState.showForm) {
			form = {
				provider: 'aws-s3',
				frequency: 'daily',
				hour: 2,
				bucket: '',
				prefix: 'clopen-backups/',
				retentionDays: 30,
				enabled: true,
				name: ''
			};
		}
	});

	$effect(() => {
		if (dbBackupState.isOpen && connectionId) {
			loadBackupConfigs(connectionId);
		}
	});

	async function handleSave() {
		if (!form.name || !form.bucket || !form.provider) return;
		if (dbBackupState.editingConfig) {
			await updateBackupConfig(dbBackupState.editingConfig.id, connectionId, form);
		} else {
			await createBackupConfig({
				connectionId,
				name: form.name!,
				enabled: form.enabled ?? true,
				provider: form.provider!,
				frequency: form.frequency ?? 'daily',
				hour: form.hour ?? 2,
				dayOfWeek: form.dayOfWeek,
				dayOfMonth: form.dayOfMonth,
				bucket: form.bucket!,
				prefix: form.prefix ?? 'clopen-backups/',
				awsRegion: form.awsRegion,
				awsAccessKeyId: form.awsAccessKeyId,
				awsSecretAccessKey: form.awsSecretAccessKey,
				gcsProjectId: form.gcsProjectId,
				gcsClientEmail: form.gcsClientEmail,
				gcsPrivateKey: form.gcsPrivateKey,
				retentionDays: form.retentionDays ?? 30
			});
		}
	}

	function formatDate(iso?: string): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleString();
	}

	function formatBytes(bytes?: number): string {
		if (!bytes) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function freqLabel(config: BackupConfig): string {
		switch (config.frequency) {
			case 'hourly': return 'Every hour';
			case 'daily': return `Daily at ${String(config.hour).padStart(2, '0')}:00 UTC`;
			case 'weekly': {
				const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
				return `Weekly ${days[config.dayOfWeek ?? 0]} at ${String(config.hour).padStart(2, '0')}:00 UTC`;
			}
			case 'monthly':
				return `Monthly on day ${config.dayOfMonth ?? 1} at ${String(config.hour).padStart(2, '0')}:00 UTC`;
			default: return config.frequency;
		}
	}
</script>

{#if dbBackupState.isOpen}
	<div
		class="fixed inset-0 z-[200] flex items-start justify-end p-4"
		in:fade={{ duration: 150 }}
		out:fade={{ duration: 100 }}
	>
		<!-- Backdrop -->
		<div
			class="absolute inset-0 bg-black/30 backdrop-blur-sm"
			onclick={closeBackupPanel}
			onkeydown={(e) => e.key === 'Escape' && closeBackupPanel()}
			role="button"
			tabindex="0"
			aria-label="Close"
		></div>

		<!-- Panel -->
		<div
			class="relative z-10 w-full max-w-md h-full max-h-[calc(100dvh-2rem)] flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden"
			in:slide={{ duration: 200, axis: 'x' }}
			out:slide={{ duration: 150, axis: 'x' }}
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
				<div class="flex items-center gap-2.5">
					<div class="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
						<Icon name="lucide:cloud-upload" class="w-4 h-4 text-blue-600" />
					</div>
					<h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Automated Backup</h2>
				</div>
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
					onclick={closeBackupPanel}
				>
					<Icon name="lucide:x" class="w-4 h-4" />
				</button>
			</div>

			<!-- Content -->
			<div class="flex-1 overflow-y-auto">
				{#if dbBackupState.showForm}
					<!-- Create / Edit form -->
					<div class="p-5 space-y-4" in:fade={{ duration: 150 }}>
						<h3 class="text-xs font-semibold text-slate-700 dark:text-slate-300">
							{dbBackupState.editingConfig ? 'Edit Backup Config' : 'New Backup Config'}
						</h3>

						<!-- Name -->
						<div>
							<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Name</label>
							<input
								type="text"
								bind:value={form.name}
								placeholder="e.g. Daily Production Backup"
								class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
							/>
						</div>

						<!-- Provider -->
						<div>
							<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Cloud Provider</label>
							<div class="grid grid-cols-2 gap-2">
								{#each [{ value: 'aws-s3', label: 'AWS S3', icon: 'lucide:cloud' }, { value: 'gcs', label: 'Google Cloud', icon: 'lucide:cloud' }] as p}
									<button
										type="button"
										class="flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-xs font-medium transition-all
											{form.provider === p.value
												? 'border-violet-500 bg-violet-50 dark:bg-violet-500/10 text-violet-700 dark:text-violet-300'
												: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300'}"
										onclick={() => (form.provider = p.value as 'aws-s3' | 'gcs')}
									>
										<Icon name={p.icon as any} class="w-3.5 h-3.5" />
										{p.label}
									</button>
								{/each}
							</div>
						</div>

						<!-- Frequency -->
						<div>
							<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Frequency</label>
							<select
								bind:value={form.frequency}
								class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
							>
								<option value="hourly">Hourly</option>
								<option value="daily">Daily</option>
								<option value="weekly">Weekly</option>
								<option value="monthly">Monthly</option>
							</select>
						</div>

						{#if form.frequency !== 'hourly'}
							<div class="grid grid-cols-2 gap-3">
								<div>
									<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Hour (UTC)</label>
									<select
										bind:value={form.hour}
										class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
									>
										{#each Array.from({ length: 24 }, (_, i) => i) as h}
											<option value={h}>{String(h).padStart(2, '0')}:00</option>
										{/each}
									</select>
								</div>
								{#if form.frequency === 'weekly'}
									<div>
										<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Day of week</label>
										<select
											bind:value={form.dayOfWeek}
											class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
										>
											{#each ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as d, i}
												<option value={i}>{d}</option>
											{/each}
										</select>
									</div>
								{:else if form.frequency === 'monthly'}
									<div>
										<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Day of month</label>
										<input
											type="number"
											min="1"
											max="28"
											bind:value={form.dayOfMonth}
											class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
										/>
									</div>
								{/if}
							</div>
						{/if}

						<!-- Bucket & Prefix -->
						<div class="grid grid-cols-2 gap-3">
							<div>
								<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Bucket</label>
								<input
									type="text"
									bind:value={form.bucket}
									placeholder="my-backup-bucket"
									class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
								/>
							</div>
							<div>
								<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Prefix</label>
								<input
									type="text"
									bind:value={form.prefix}
									placeholder="clopen-backups/"
									class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
								/>
							</div>
						</div>

						<!-- AWS credentials -->
						{#if form.provider === 'aws-s3'}
							<div class="space-y-3 pt-1">
								<p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">AWS Credentials</p>
								<div>
									<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Region</label>
									<input type="text" bind:value={form.awsRegion} placeholder="us-east-1" class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>
								<div>
									<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Access Key ID</label>
									<input type="text" bind:value={form.awsAccessKeyId} placeholder="AKIA…" class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>
								<div>
									<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Secret Access Key</label>
									<input type="password" bind:value={form.awsSecretAccessKey} placeholder={dbBackupState.editingConfig?.awsSecretAccessKey === '••••••••' ? 'Leave blank to keep existing' : ''} class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>
							</div>
						{:else}
							<div class="space-y-3 pt-1">
								<p class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">GCS Service Account</p>
								<div>
									<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Project ID</label>
									<input type="text" bind:value={form.gcsProjectId} placeholder="my-project-123" class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>
								<div>
									<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Client Email</label>
									<input type="email" bind:value={form.gcsClientEmail} placeholder="sa@project.iam.gserviceaccount.com" class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>
								<div>
									<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Private Key (PEM)</label>
									<textarea
										bind:value={form.gcsPrivateKey}
										rows="4"
										placeholder={dbBackupState.editingConfig?.gcsPrivateKey === '••••••••' ? 'Leave blank to keep existing' : '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
										class="w-full text-xs font-mono border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 resize-none"
									></textarea>
								</div>
							</div>
						{/if}

						<!-- Retention -->
						<div>
							<label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Retention (days)</label>
							<input
								type="number"
								min="1"
								max="365"
								bind:value={form.retentionDays}
								class="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
							/>
						</div>

						<!-- Enabled -->
						<label class="flex items-center gap-2.5 cursor-pointer">
							<input type="checkbox" bind:checked={form.enabled} class="rounded border-slate-300 dark:border-slate-600 text-violet-600 w-4 h-4" />
							<span class="text-xs text-slate-700 dark:text-slate-300">Enable scheduled backups</span>
						</label>
					</div>

					<!-- Form footer -->
					<div class="flex items-center justify-between px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0">
						<button type="button" class="px-3 py-2 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300" onclick={cancelForm}>Cancel</button>
						<button
							type="button"
							class="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-all disabled:opacity-60"
							onclick={handleSave}
							disabled={dbBackupState.isSaving || !form.name || !form.bucket}
						>
							{#if dbBackupState.isSaving}
								<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
								Saving…
							{:else}
								<Icon name="lucide:save" class="w-3.5 h-3.5" />
								{dbBackupState.editingConfig ? 'Update' : 'Create'}
							{/if}
						</button>
					</div>

				{:else}
					<!-- Config list -->
					<div class="p-4 space-y-3">
						{#if dbBackupState.isLoading}
							<div class="flex items-center justify-center py-8 text-slate-400 gap-2">
								<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
								<span class="text-sm">Loading…</span>
							</div>
						{:else if dbBackupState.configs.length === 0}
							<div class="flex flex-col items-center justify-center py-10 gap-3 text-center">
								<div class="w-12 h-12 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
									<Icon name="lucide:cloud-upload" class="w-6 h-6 text-slate-400" />
								</div>
								<div>
									<p class="text-sm font-medium text-slate-700 dark:text-slate-300">No backup configs yet</p>
									<p class="text-xs text-slate-400 dark:text-slate-500 mt-1">Schedule automatic database backups to AWS S3 or Google Cloud Storage</p>
								</div>
							</div>
						{:else}
							{#each dbBackupState.configs as config (config.id)}
								<div class="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
									<!-- Config header -->
									<div class="flex items-start gap-3 p-3">
										<!-- Status indicator -->
										<div class="mt-0.5">
											{#if config.enabled}
												<div class="w-2 h-2 rounded-full bg-emerald-500"></div>
											{:else}
												<div class="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-600"></div>
											{/if}
										</div>

										<div class="flex-1 min-w-0">
											<div class="flex items-center gap-2">
												<span class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{config.name}</span>
												<span class="text-3xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-medium">
													{config.provider === 'aws-s3' ? 'S3' : 'GCS'}
												</span>
											</div>
											<p class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{freqLabel(config)}</p>
											<!-- Last run status -->
											<div class="flex items-center gap-1.5 mt-1.5">
												{#if config.lastRunAt}
													{#if config.lastRunSuccess}
														<Icon name="lucide:circle-check" class="w-3 h-3 text-emerald-500 shrink-0" />
														<span class="text-3xs text-slate-400">Last run: {formatDate(config.lastRunAt)}</span>
													{:else}
														<Icon name="lucide:circle-x" class="w-3 h-3 text-red-500 shrink-0" />
														<span class="text-3xs text-red-500 truncate">{config.lastRunError ?? 'Failed'}</span>
													{/if}
												{:else}
													<span class="text-3xs text-slate-400">Never run</span>
												{/if}
											</div>
										</div>

										<!-- Actions -->
										<div class="flex items-center gap-1 shrink-0">
											<button
												type="button"
												class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-all disabled:opacity-50"
												onclick={() => runBackupNow(config.id, connectionId)}
												disabled={dbBackupState.isRunning}
												title="Run backup now"
											>
												<Icon name="lucide:play" class="w-3.5 h-3.5" />
											</button>
											<button
												type="button"
												class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-500/10 transition-all"
												onclick={() => showEditConfigForm(config)}
												title="Edit"
											>
												<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
											</button>
											<button
												type="button"
												class="flex items-center justify-center w-7 h-7 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-all"
												onclick={() => (showDeleteConfirm = config.id)}
												title="Delete"
											>
												<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
											</button>
										</div>
									</div>

									<!-- Delete confirm -->
									{#if showDeleteConfirm === config.id}
										<div class="px-3 pb-3 pt-0" in:slide={{ duration: 150 }}>
											<div class="flex items-center gap-2 p-2.5 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
												<p class="text-xs text-red-700 dark:text-red-400 flex-1">Delete this backup config?</p>
												<button type="button" class="text-xs text-red-600 font-medium hover:underline" onclick={() => deleteBackupConfig(config.id, connectionId).then(() => (showDeleteConfirm = null))}>Delete</button>
												<button type="button" class="text-xs text-slate-500 hover:underline ml-2" onclick={() => (showDeleteConfirm = null)}>Cancel</button>
											</div>
										</div>
									{/if}

									<!-- History toggle -->
									<div class="border-t border-slate-100 dark:border-slate-800">
										<button
											type="button"
											class="flex items-center gap-1.5 w-full px-3 py-2 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
											onclick={() => toggleHistoryPanel(config.id, connectionId)}
										>
											<Icon name="lucide:history" class="w-3 h-3" />
											Run history
											<Icon
												name={dbBackupState.expandedConfigId === config.id ? 'lucide:chevron-up' : 'lucide:chevron-down'}
												class="w-3 h-3 ml-auto"
											/>
										</button>

										{#if dbBackupState.expandedConfigId === config.id}
											<div class="border-t border-slate-100 dark:border-slate-800" in:slide={{ duration: 150 }}>
												{#if dbBackupState.isLoadingHistory}
													<div class="flex items-center gap-2 px-3 py-3 text-slate-400 text-xs">
														<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
														Loading…
													</div>
												{:else}
													{@const runs = dbBackupState.runHistory[config.id] ?? []}
													{#if !runs.length}
														<p class="px-3 py-3 text-xs text-slate-400 dark:text-slate-500">No runs yet</p>
													{:else}
														<div class="max-h-40 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
															{#each runs as run (run.id)}
																<div class="flex items-center gap-2 px-3 py-2">
																	{#if run.success}
																		<Icon name="lucide:circle-check" class="w-3 h-3 text-emerald-500 shrink-0" />
																	{:else}
																		<Icon name="lucide:circle-x" class="w-3 h-3 text-red-500 shrink-0" />
																	{/if}
																	<div class="flex-1 min-w-0">
																		<p class="text-xs text-slate-700 dark:text-slate-300">{formatDate(run.startedAt)}</p>
																		{#if run.success && run.fileSize}
																			<p class="text-3xs text-slate-400">{formatBytes(run.fileSize)}</p>
																		{:else if !run.success && run.error}
																			<p class="text-3xs text-red-500 truncate">{run.error}</p>
																		{/if}
																	</div>
																</div>
															{/each}
														</div>
													{/if}
												{/if}
											</div>
										{/if}
									</div>
								</div>
							{/each}
						{/if}
					</div>
				{/if}
			</div>

			<!-- Footer (list view only) -->
			{#if !dbBackupState.showForm}
				<div class="border-t border-slate-200 dark:border-slate-800 p-3 shrink-0">
					<button
						type="button"
						class="flex items-center gap-2 w-full py-2 px-3 rounded-lg text-xs font-medium bg-violet-500/10 text-violet-700 dark:text-violet-300 hover:bg-violet-500/20 transition-all border border-violet-500/20"
						onclick={showNewConfigForm}
					>
						<Icon name="lucide:plus" class="w-3.5 h-3.5" />
						New Backup Config
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

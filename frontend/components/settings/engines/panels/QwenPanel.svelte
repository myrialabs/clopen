<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { ENGINES } from '$shared/constants/engines';
	import type { QwenProviderPresetId } from '$shared/types/unified';
	import { qwenAccountsStore, type QwenAccountItem } from '$frontend/stores/features/qwen-accounts.svelte';
	import { qwenPresetsStore } from '$frontend/stores/features/qwen-presets.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import type { QwenStatus } from './panel-types';

	interface Props {
		status: QwenStatus | null;
		isLoading: boolean;
		onRefreshStatus: () => Promise<void> | void;
	}
	const { status, isLoading, onRefreshStatus }: Props = $props();

	const qwenStatus = $derived(status);
	const isLoadingQwenStatus = $derived(isLoading);
	const refreshQwenStatus = () => onRefreshStatus();
	const qwenEngine = ENGINES.find(e => e.type === 'qwen')!;
	const qwenAccounts = $derived(qwenAccountsStore.accounts);

	// Qwen add-account flow (paste API key, choose preset)
	type QwenAddStep = 'idle' | 'editing' | 'saving' | 'success' | 'error';
	let qwenAddStep = $state<QwenAddStep>('idle');
	let qwenAddName = $state('');
	let qwenAddApiKey = $state('');
	let qwenAddPreset = $state<QwenProviderPresetId>('dashscope-intl');
	let qwenAddError = $state('');

	// Qwen rename / delete
	let qwenRenamingId = $state<number | null>(null);
	let qwenRenameValue = $state('');
	let qwenRenameApiKey = $state('');
	let qwenRenamePreset = $state<QwenProviderPresetId>('dashscope-intl');
	let qwenDeleteDialogOpen = $state(false);
	let qwenDeleteTargetId = $state<number | null>(null);

	onMount(() => {
		qwenPresetsStore.fetch();
	});

	function startQwenAdd() {
		qwenAddStep = 'editing';
		qwenAddName = '';
		qwenAddApiKey = '';
		qwenAddPreset = qwenPresetsStore.defaultPreset;
		qwenAddError = '';
	}

	async function submitQwenAdd() {
		if (!qwenAddName.trim() || !qwenAddApiKey.trim()) return;
		qwenAddStep = 'saving';
		qwenAddError = '';
		try {
			await ws.http('engine:qwen-accounts-add', {
				name: qwenAddName.trim(),
				apiKey: qwenAddApiKey.trim(),
				preset: qwenAddPreset,
			});
			qwenAddStep = 'success';
			await qwenAccountsStore.refresh();
			await refreshQwenStatus();
			await modelStore.refreshModels('qwen');
		} catch (error: any) {
			qwenAddError = error?.message || 'Failed to add account';
			qwenAddStep = 'error';
		}
	}

	function cancelQwenAdd() {
		qwenAddStep = 'idle';
		qwenAddName = '';
		qwenAddApiKey = '';
		qwenAddPreset = qwenPresetsStore.defaultPreset;
		qwenAddError = '';
	}

	async function switchQwenAccount(id: number) {
		try {
			await ws.http('engine:qwen-accounts-switch', { id });
			await qwenAccountsStore.refresh();
			await refreshQwenStatus();
			await modelStore.refreshModels('qwen');
		} catch {
			// Ignore
		}
	}

	function confirmDeleteQwenAccount(id: number) {
		qwenDeleteTargetId = id;
		qwenDeleteDialogOpen = true;
	}

	async function deleteQwenAccount() {
		if (qwenDeleteTargetId === null) return;
		try {
			await ws.http('engine:qwen-accounts-delete', { id: qwenDeleteTargetId });
			await qwenAccountsStore.refresh();
			await refreshQwenStatus();
		} catch {
			// Ignore
		}
	}

	function startQwenRename(account: QwenAccountItem) {
		qwenRenamingId = account.id;
		qwenRenameValue = account.name;
		qwenRenameApiKey = '';
		qwenRenamePreset = account.preset;
	}

	async function submitQwenRename() {
		if (qwenRenamingId === null || !qwenRenameValue.trim()) return;
		const id = qwenRenamingId;
		try {
			await ws.http('engine:qwen-accounts-rename', { id, name: qwenRenameValue.trim() });
			// Update key/preset in one call — omit apiKey when blank to keep the stored one.
			const apiKey = qwenRenameApiKey.trim();
			await ws.http('engine:qwen-accounts-update', { id, preset: qwenRenamePreset, ...(apiKey ? { apiKey } : {}) });
			qwenRenamingId = null;
			qwenRenameValue = '';
			qwenRenameApiKey = '';
			await qwenAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	function cancelQwenRename() {
		qwenRenamingId = null;
		qwenRenameValue = '';
		qwenRenameApiKey = '';
	}
</script>

<!-- Qwen Code Card -->
<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<!-- Card Header -->
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div class="flex items-center gap-3">
			<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
				{@html isDarkMode() ? qwenEngine.icon.dark : qwenEngine.icon.light}
			</div>
			<div>
				<h3 class="font-semibold text-slate-900 dark:text-slate-100">{qwenEngine.name}</h3>
				<p class="text-xs text-slate-500 dark:text-slate-400">{qwenEngine.description}</p>
			</div>
		</div>
	</div>

	<!-- Card Body -->
	<div class="px-5 py-4">
		{#if isLoadingQwenStatus}
			<div class="flex items-center justify-center py-8">
				<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
			</div>
		{:else if qwenStatus}
			<div class="space-y-5">
				<!-- Providers Section -->
				<div class="space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Providers</h4>
						<span class="text-xs text-slate-500">1 provider</span>
					</div>

					<!-- Qwen provider (pre-seeded) -->
					<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
						<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
							<div class="flex items-center gap-2 min-w-0">
								<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">Qwen</span>
								<span class="text-2xs text-slate-400">qwen</span>
								<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
							</div>
						</div>

						<!-- Accounts list -->
						<div class="px-3.5 py-2.5 space-y-2">
							{#if qwenAccounts.length === 0}
								<p class="text-xs text-slate-500 italic">No accounts</p>
							{:else}
								{#each qwenAccounts as account (account.id)}
									{@const accountPreset = qwenPresetsStore.getPreset(account.preset)}
									<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
										<div class="flex items-center justify-between px-3.5 py-2.5">
											<div class="w-full flex items-center gap-2.5 min-w-0">
												<Icon name="lucide:key" class="w-4 h-4 shrink-0 text-slate-400" />
												<div class="flex flex-col min-w-0 gap-0.5">
													<div class="flex items-center gap-2 min-w-0">
														<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
														{#if account.isActive}
															<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
														{/if}
													</div>
													<div class="flex items-center gap-2 min-w-0 text-2xs text-slate-500 dark:text-slate-400">
														<span class="font-medium">{accountPreset?.name ?? account.preset}</span>
													</div>
												</div>
											</div>
											<div class="flex items-center gap-1">
												{#if !account.isActive}
													<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchQwenAccount(account.id)} title="Switch to this account">
														<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
													</button>
												{/if}
												<button type="button" class="flex p-1.5 rounded-md {qwenRenamingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => qwenRenamingId === account.id ? cancelQwenRename() : startQwenRename(account)} title="Edit account">
													<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
												</button>
												<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteQwenAccount(account.id)} title="Delete account">
													<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
												</button>
											</div>
										</div>
										{#if qwenRenamingId === account.id}
											<AccountEditForm onSave={submitQwenRename} onCancel={cancelQwenRename} saveDisabled={!qwenRenameValue.trim()}>
												<AccountField label="Account name" bind:value={qwenRenameValue} />
												<div class="space-y-1">
													<span class="block text-2xs font-medium text-slate-500 dark:text-slate-400">Provider preset</span>
													<select bind:value={qwenRenamePreset} class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500">
														{#each qwenPresetsStore.presets as preset (preset.id)}
															<option value={preset.id}>{preset.name}</option>
														{/each}
													</select>
												</div>
												<AccountField label="API key" secret hint="(leave blank to keep)" bind:value={qwenRenameApiKey} />
											</AccountEditForm>
										{/if}
									</div>
								{/each}
							{/if}

							<!-- Add Account Flow (paste API key) -->
							<div class="pt-1">
								{#if qwenAddStep === 'idle'}
									<button
										type="button"
										class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center"
										onclick={startQwenAdd}
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
										Add Account
									</button>
								{:else if qwenAddStep === 'editing'}
									<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
										<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
											<Icon name="lucide:key" class="w-3.5 h-3.5" />
											Add an OpenAI-compatible API key
										</div>

										<div class="text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
											<p>Add an OpenAI-compatible API key for your Qwen Code account.</p>
										</div>

										<div class="space-y-2">
											<input
												type="text"
												bind:value={qwenAddName}
												placeholder="Account name (e.g. Personal, Work)"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>
											<select
												bind:value={qwenAddPreset}
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											>
												{#each qwenPresetsStore.presets as preset (preset.id)}
													<option value={preset.id}>{preset.name}</option>
												{/each}
											</select>
											<input
												type="text"
												bind:value={qwenAddApiKey}
												placeholder="sk-…"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>
										</div>

										<div class="flex gap-2">
											<button
												type="button"
												class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
												onclick={submitQwenAdd}
												disabled={!qwenAddName.trim() || !qwenAddApiKey.trim()}
											>
												<Icon name="lucide:plus" class="w-4 h-4" />
												Save
											</button>
											<button
												type="button"
												class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
												onclick={cancelQwenAdd}
											>
												Cancel
											</button>
										</div>
									</div>
								{:else if qwenAddStep === 'saving'}
									<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
										<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
											<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
											<span>Saving API key...</span>
										</div>
									</div>
								{:else if qwenAddStep === 'success'}
									<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
										<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
										<span class="text-sm text-green-700 dark:text-green-300">Account added successfully!</span>
										<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={cancelQwenAdd}>Dismiss</button>
									</div>
								{:else if qwenAddStep === 'error'}
									<div class="space-y-3">
										<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
											<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
											<span class="text-sm text-red-700 dark:text-red-300">{qwenAddError}</span>
										</div>
										<button
											type="button"
											class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
											onclick={() => { qwenAddStep = 'editing'; }}
										>
											<Icon name="lucide:rotate-ccw" class="w-4 h-4" />
											Try Again
										</button>
									</div>
								{/if}
							</div>
						</div>
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>

<Dialog
	bind:isOpen={qwenDeleteDialogOpen}
	onClose={() => { qwenDeleteDialogOpen = false; qwenDeleteTargetId = null; }}
	type="error"
	title="Delete Qwen Code Account"
	message="Are you sure you want to delete this Qwen Code account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteQwenAccount}
/>

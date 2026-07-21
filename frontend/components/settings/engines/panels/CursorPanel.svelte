<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { ENGINES } from '$shared/constants/engines';
	import { cursorAccountsStore, type CursorAccountItem } from '$frontend/stores/features/cursor-accounts.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import type { CursorStatus } from './panel-types';

	interface Props {
		status: CursorStatus | null;
		isLoading: boolean;
		onRefreshStatus: () => Promise<void> | void;
	}
	const { status, isLoading, onRefreshStatus }: Props = $props();

	const cursorStatus = $derived(status);
	const isLoadingCursorStatus = $derived(isLoading);
	const refreshCursorStatus = () => onRefreshStatus();
	const cursorEngine = ENGINES.find(e => e.type === 'cursor')!;
	const cursorAccounts = $derived(cursorAccountsStore.accounts);

	// Cursor add-account flow (paste API key)
	type CursorAddStep = 'idle' | 'editing' | 'saving' | 'success' | 'error';
	let cursorAddStep = $state<CursorAddStep>('idle');
	let cursorAddName = $state('');
	let cursorAddKey = $state('');
	let cursorAddError = $state('');

	// Cursor rename / edit (name + optional new key)
	let cursorRenamingId = $state<number | null>(null);
	let cursorRenameValue = $state('');
	let cursorRenameKey = $state('');

	// Cursor delete confirmation
	let cursorDeleteDialogOpen = $state(false);
	let cursorDeleteTargetId = $state<number | null>(null);

	// Cursor restart/refresh
	let cursorRestarting = $state(false);

	function startCursorAdd() {
		cursorAddStep = 'editing';
		cursorAddName = '';
		cursorAddKey = '';
		cursorAddError = '';
	}

	async function submitCursorAdd() {
		if (!cursorAddName.trim() || !cursorAddKey.trim()) return;
		cursorAddStep = 'saving';
		cursorAddError = '';
		try {
			await ws.http('engine:cursor-accounts-add', {
				name: cursorAddName.trim(),
				apiKey: cursorAddKey.trim()
			});
			cursorAddStep = 'success';
			await cursorAccountsStore.refresh();
			await refreshCursorStatus();
			await modelStore.refreshModels('cursor');
		} catch (error: any) {
			cursorAddError = error?.message || 'Failed to add account';
			cursorAddStep = 'error';
		}
	}

	function cancelCursorAdd() {
		cursorAddStep = 'idle';
		cursorAddName = '';
		cursorAddKey = '';
		cursorAddError = '';
	}

	async function switchCursorAccount(id: number) {
		try {
			await ws.http('engine:cursor-accounts-switch', { id });
			await cursorAccountsStore.refresh();
			await refreshCursorStatus();
			await modelStore.refreshModels('cursor');
		} catch {
			// Ignore
		}
	}

	function confirmDeleteCursorAccount(id: number) {
		cursorDeleteTargetId = id;
		cursorDeleteDialogOpen = true;
	}

	async function deleteCursorAccount() {
		if (cursorDeleteTargetId === null) return;
		try {
			await ws.http('engine:cursor-accounts-delete', { id: cursorDeleteTargetId });
			await cursorAccountsStore.refresh();
			await refreshCursorStatus();
		} catch {
			// Ignore
		}
	}

	function startCursorRename(account: CursorAccountItem) {
		cursorRenamingId = account.id;
		cursorRenameValue = account.name;
		cursorRenameKey = '';
	}

	async function submitCursorRename() {
		if (cursorRenamingId === null || !cursorRenameValue.trim()) return;
		const id = cursorRenamingId;
		try {
			await ws.http('engine:cursor-accounts-rename', { id, name: cursorRenameValue.trim() });
			const apiKey = cursorRenameKey.trim();
			if (apiKey) await ws.http('engine:cursor-accounts-update-key', { id, apiKey });
			cursorRenamingId = null;
			cursorRenameValue = '';
			cursorRenameKey = '';
			await cursorAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	function cancelCursorRename() {
		cursorRenamingId = null;
		cursorRenameValue = '';
		cursorRenameKey = '';
	}

	async function handleCursorRestart() {
		cursorRestarting = true;
		try {
			await ws.http('engine:cursor-restart', {});
			await modelStore.refreshModels('cursor');
			await refreshCursorStatus();
			showSuccess('Server Restarted', 'Cursor engine restarted successfully. Models refreshed.');
		} catch {
			// Ignore — errors surface via existing notification flow when models load
		} finally {
			cursorRestarting = false;
		}
	}
</script>

<!-- Cursor Card -->
<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<!-- Card Header -->
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div class="flex items-center gap-3">
			<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
				{@html isDarkMode() ? cursorEngine.icon.dark : cursorEngine.icon.light}
			</div>
			<div>
				<h3 class="font-semibold text-slate-900 dark:text-slate-100">{cursorEngine.name}</h3>
				<p class="text-xs text-slate-500 dark:text-slate-400">{cursorEngine.description}</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			{#if cursorStatus?.activeAccount}
				<button
					type="button"
					class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
						text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50
						hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={handleCursorRestart}
					disabled={cursorRestarting}
				>
					<Icon name={cursorRestarting ? 'lucide:loader' : 'lucide:rotate-cw'} class="w-3.5 h-3.5 {cursorRestarting ? 'animate-spin' : ''}" />
					{cursorRestarting ? 'Restarting...' : 'Restart Server'}
				</button>
			{/if}
		</div>
	</div>

	<!-- Card Body -->
	<div class="px-5 py-4">
		{#if isLoadingCursorStatus}
			<div class="flex items-center justify-center py-8">
				<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
			</div>
		{:else if cursorStatus}
			<div class="space-y-5">
				<!-- Providers Section -->
				<div class="space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Providers</h4>
						<span class="text-xs text-slate-500">1 provider</span>
					</div>

					<!-- Cursor provider (pre-seeded) -->
					<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
						<!-- Provider header -->
						<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
							<div class="flex items-center gap-2 min-w-0">
								<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">Cursor</span>
								<span class="text-2xs text-slate-400">cursor</span>
								<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
							</div>
						</div>

						<!-- Accounts list -->
						<div class="px-3.5 py-2.5 space-y-2">
							{#if cursorAccounts.length === 0}
								<p class="text-xs text-slate-500 italic">No accounts</p>
							{:else}
								{#each cursorAccounts as account (account.id)}
									<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
										<div class="flex items-center justify-between px-3.5 py-2.5">
											<div class="w-full flex items-center gap-2.5 min-w-0">
												<Icon name="lucide:key" class="w-4 h-4 shrink-0 text-slate-400" />
												<div class="flex items-center gap-2 min-w-0">
													<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
													{#if account.isActive}
														<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
													{/if}
												</div>
											</div>
											<div class="flex items-center gap-1">
												{#if !account.isActive}
													<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchCursorAccount(account.id)} title="Switch to this account">
														<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
													</button>
												{/if}
												<button type="button" class="flex p-1.5 rounded-md {cursorRenamingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => cursorRenamingId === account.id ? cancelCursorRename() : startCursorRename(account)} title="Edit account">
													<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
												</button>
												<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteCursorAccount(account.id)} title="Delete account">
													<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
												</button>
											</div>
										</div>
										{#if cursorRenamingId === account.id}
											<AccountEditForm onSave={submitCursorRename} onCancel={cancelCursorRename} saveDisabled={!cursorRenameValue.trim()}>
												<AccountField label="Account name" bind:value={cursorRenameValue} />
												<AccountField label="API key" secret hint="(leave blank to keep)" bind:value={cursorRenameKey} />
											</AccountEditForm>
										{/if}
									</div>
								{/each}
							{/if}

							<!-- Add Account Flow (paste API key) -->
							<div class="pt-1">
								{#if cursorAddStep === 'idle'}
									<button
										type="button"
										class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center"
										onclick={startCursorAdd}
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
										Add Account
									</button>
								{:else if cursorAddStep === 'editing'}
									<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
										<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
											<Icon name="lucide:key" class="w-3.5 h-3.5" />
											Add a Cursor API key
										</div>

										<div class="text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
											<p>Create an API key from your Cursor dashboard:</p>
											<ol class="list-decimal list-inside space-y-0.5 pl-1">
												<li>Open <a href="https://cursor.com/dashboard/api" target="_blank" rel="noopener noreferrer" class="text-violet-600 dark:text-violet-400 hover:underline">cursor.com/dashboard/api</a></li>
												<li>Create a <span class="font-medium">user API key</span> (or a team service-account key)</li>
												<li>Copy the key and paste it below</li>
											</ol>
										</div>

										<div class="space-y-2">
											<input
												type="text"
												bind:value={cursorAddName}
												placeholder="Account name (e.g. Personal, Work)"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>
											<input
												type="text"
												bind:value={cursorAddKey}
												placeholder="API Key (crsr_)"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>
										</div>

										<div class="flex gap-2">
											<button
												type="button"
												class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
												onclick={submitCursorAdd}
												disabled={!cursorAddName.trim() || !cursorAddKey.trim()}
											>
												<Icon name="lucide:plus" class="w-4 h-4" />
												Save
											</button>
											<button
												type="button"
												class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
												onclick={cancelCursorAdd}
											>
												Cancel
											</button>
										</div>
									</div>
								{:else if cursorAddStep === 'saving'}
									<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
										<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
											<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
											<span>Validating key...</span>
										</div>
									</div>
								{:else if cursorAddStep === 'success'}
									<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
										<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
										<span class="text-sm text-green-700 dark:text-green-300">Account added successfully!</span>
										<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={cancelCursorAdd}>Dismiss</button>
									</div>
								{:else if cursorAddStep === 'error'}
									<div class="space-y-3">
										<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
											<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
											<span class="text-sm text-red-700 dark:text-red-300">{cursorAddError}</span>
										</div>
										<button
											type="button"
											class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
											onclick={() => { cursorAddStep = 'editing'; }}
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
	bind:isOpen={cursorDeleteDialogOpen}
	onClose={() => { cursorDeleteDialogOpen = false; cursorDeleteTargetId = null; }}
	type="error"
	title="Delete Account"
	message="Are you sure you want to delete this Cursor account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteCursorAccount}
/>

<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { ENGINES } from '$shared/constants/engines';
	import { copilotAccountsStore, type CopilotAccountItem } from '$frontend/stores/features/copilot-accounts.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import type { CopilotStatus } from './panel-types';

	interface Props {
		status: CopilotStatus | null;
		isLoading: boolean;
		onRefreshStatus: () => Promise<void> | void;
	}
	const { status, isLoading, onRefreshStatus }: Props = $props();

	const copilotStatus = $derived(status);
	const isLoadingCopilotStatus = $derived(isLoading);
	const refreshCopilotStatus = () => onRefreshStatus();
	const copilotEngine = ENGINES.find(e => e.type === 'copilot')!;
	const copilotAccounts = $derived(copilotAccountsStore.accounts);

	// Copilot add-account flow (paste-token)
	type CopilotAddStep = 'idle' | 'editing' | 'saving' | 'success' | 'error';
	let copilotAddStep = $state<CopilotAddStep>('idle');
	let copilotAddName = $state('');
	let copilotAddToken = $state('');
	let copilotAddError = $state('');

	// Copilot rename / edit (name + optional new token)
	let copilotRenamingId = $state<number | null>(null);
	let copilotRenameValue = $state('');
	let copilotRenameToken = $state('');

	// Copilot delete confirmation
	let copilotDeleteDialogOpen = $state(false);
	let copilotDeleteTargetId = $state<number | null>(null);

	// Copilot restart/refresh
	let copilotRestarting = $state(false);

	function startCopilotAdd() {
		copilotAddStep = 'editing';
		copilotAddName = '';
		copilotAddToken = '';
		copilotAddError = '';
	}

	async function submitCopilotAdd() {
		if (!copilotAddName.trim() || !copilotAddToken.trim()) return;
		copilotAddStep = 'saving';
		copilotAddError = '';
		try {
			await ws.http('engine:copilot-accounts-add', {
				name: copilotAddName.trim(),
				token: copilotAddToken.trim()
			});
			copilotAddStep = 'success';
			await copilotAccountsStore.refresh();
			await refreshCopilotStatus();
		} catch (error: any) {
			copilotAddError = error?.message || 'Failed to add account';
			copilotAddStep = 'error';
		}
	}

	function cancelCopilotAdd() {
		copilotAddStep = 'idle';
		copilotAddName = '';
		copilotAddToken = '';
		copilotAddError = '';
	}

	async function switchCopilotAccount(id: number) {
		try {
			await ws.http('engine:copilot-accounts-switch', { id });
			await copilotAccountsStore.refresh();
			await refreshCopilotStatus();
		} catch {
			// Ignore
		}
	}

	function confirmDeleteCopilotAccount(id: number) {
		copilotDeleteTargetId = id;
		copilotDeleteDialogOpen = true;
	}

	async function deleteCopilotAccount() {
		if (copilotDeleteTargetId === null) return;
		try {
			await ws.http('engine:copilot-accounts-delete', { id: copilotDeleteTargetId });
			await copilotAccountsStore.refresh();
			await refreshCopilotStatus();
		} catch {
			// Ignore
		}
	}

	function startCopilotRename(account: CopilotAccountItem) {
		copilotRenamingId = account.id;
		copilotRenameValue = account.name;
		copilotRenameToken = '';
	}

	async function submitCopilotRename() {
		if (copilotRenamingId === null || !copilotRenameValue.trim()) return;
		const id = copilotRenamingId;
		try {
			await ws.http('engine:copilot-accounts-rename', { id, name: copilotRenameValue.trim() });
			const token = copilotRenameToken.trim();
			if (token) await ws.http('engine:copilot-accounts-update-token', { id, token });
			copilotRenamingId = null;
			copilotRenameValue = '';
			copilotRenameToken = '';
			await copilotAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	function cancelCopilotRename() {
		copilotRenamingId = null;
		copilotRenameValue = '';
		copilotRenameToken = '';
	}

	async function handleCopilotRestart() {
		copilotRestarting = true;
		try {
			await ws.http('engine:copilot-restart', {});
			await modelStore.refreshModels('copilot');
			await refreshCopilotStatus();
			showSuccess('Server Restarted', 'Copilot server restarted successfully. Models refreshed.');
		} catch {
			// Ignore — errors surface via existing notification flow when models load
		} finally {
			copilotRestarting = false;
		}
	}
</script>

<!-- Copilot Card -->
<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<!-- Card Header -->
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div class="flex items-center gap-3">
			<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
				{@html isDarkMode() ? copilotEngine.icon.dark : copilotEngine.icon.light}
			</div>
			<div>
				<h3 class="font-semibold text-slate-900 dark:text-slate-100">{copilotEngine.name}</h3>
				<p class="text-xs text-slate-500 dark:text-slate-400">{copilotEngine.description}</p>
			</div>
		</div>
		<div class="flex items-center gap-2">
			{#if copilotStatus?.activeAccount}
				<button
					type="button"
					class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
						text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50
						hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
					onclick={handleCopilotRestart}
					disabled={copilotRestarting}
				>
					<Icon name={copilotRestarting ? 'lucide:loader' : 'lucide:rotate-cw'} class="w-3.5 h-3.5 {copilotRestarting ? 'animate-spin' : ''}" />
					{copilotRestarting ? 'Restarting...' : 'Restart Server'}
				</button>
			{/if}
		</div>
	</div>

	<!-- Card Body -->
	<div class="px-5 py-4">
		{#if isLoadingCopilotStatus}
			<div class="flex items-center justify-center py-8">
				<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
			</div>
		{:else if copilotStatus}
			<div class="space-y-5">
				<!-- Providers Section -->
				<div class="space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Providers</h4>
						<span class="text-xs text-slate-500">1 provider</span>
					</div>

					<!-- GitHub provider (pre-seeded) -->
					<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
						<!-- Provider header -->
						<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
							<div class="flex items-center gap-2 min-w-0">
								<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">GitHub</span>
								<span class="text-2xs text-slate-400">github</span>
								<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
							</div>
						</div>

						<!-- Accounts list -->
						<div class="px-3.5 py-2.5 space-y-2">
							{#if copilotAccounts.length === 0}
								<p class="text-xs text-slate-500 italic">No accounts</p>
							{:else}
								{#each copilotAccounts as account (account.id)}
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
													<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchCopilotAccount(account.id)} title="Switch to this account">
														<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
													</button>
												{/if}
												<button type="button" class="flex p-1.5 rounded-md {copilotRenamingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => copilotRenamingId === account.id ? cancelCopilotRename() : startCopilotRename(account)} title="Edit account">
													<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
												</button>
												<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteCopilotAccount(account.id)} title="Delete account">
													<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
												</button>
											</div>
										</div>
										{#if copilotRenamingId === account.id}
											<AccountEditForm onSave={submitCopilotRename} onCancel={cancelCopilotRename} saveDisabled={!copilotRenameValue.trim()}>
												<AccountField label="Account name" bind:value={copilotRenameValue} />
												<AccountField label="Token" secret hint="(leave blank to keep)" bind:value={copilotRenameToken} />
											</AccountEditForm>
										{/if}
									</div>
								{/each}
							{/if}

							<!-- Add Account Flow (paste-token) -->
							<div class="pt-1">
								{#if copilotAddStep === 'idle'}
									<button
										type="button"
										class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center"
										onclick={startCopilotAdd}
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
										Add Account
									</button>
								{:else if copilotAddStep === 'editing'}
									<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
										<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
											<Icon name="lucide:key" class="w-3.5 h-3.5" />
											Add a GitHub Personal Access Token
										</div>

										<div class="text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
											<p>Create a fine-grained PAT and grant it the <span class="font-semibold">Copilot Requests</span> permission:</p>
											<ol class="list-decimal list-inside space-y-0.5 pl-1">
												<li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer" class="text-violet-600 dark:text-violet-400 hover:underline">github.com/settings/personal-access-tokens/new</a></li>
												<li>Under <span class="font-medium">Permissions</span> → <span class="font-medium">Account permissions</span>, enable <span class="font-semibold">Copilot Requests</span></li>
												<li>Generate the token and paste it below</li>
											</ol>
										</div>

										<div class="space-y-2">
											<input
												type="text"
												bind:value={copilotAddName}
												placeholder="Account name (e.g. Personal, Work)"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>
											<input
												type="text"
												bind:value={copilotAddToken}
												placeholder="ghp_…  or  github_pat_…"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>
										</div>

										<div class="flex gap-2">
											<button
												type="button"
												class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
												onclick={submitCopilotAdd}
												disabled={!copilotAddName.trim() || !copilotAddToken.trim()}
											>
												<Icon name="lucide:plus" class="w-4 h-4" />
												Save
											</button>
											<button
												type="button"
												class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
												onclick={cancelCopilotAdd}
											>
												Cancel
											</button>
										</div>
									</div>
								{:else if copilotAddStep === 'saving'}
									<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
										<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
											<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
											<span>Saving token...</span>
										</div>
									</div>
								{:else if copilotAddStep === 'success'}
									<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
										<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
										<span class="text-sm text-green-700 dark:text-green-300">Account added successfully!</span>
										<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={cancelCopilotAdd}>Dismiss</button>
									</div>
								{:else if copilotAddStep === 'error'}
									<div class="space-y-3">
										<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
											<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
											<span class="text-sm text-red-700 dark:text-red-300">{copilotAddError}</span>
										</div>
										<button
											type="button"
											class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
											onclick={() => { copilotAddStep = 'editing'; }}
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
	bind:isOpen={copilotDeleteDialogOpen}
	onClose={() => { copilotDeleteDialogOpen = false; copilotDeleteTargetId = null; }}
	type="error"
	title="Delete Account"
	message="Are you sure you want to delete this Copilot account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteCopilotAccount}
/>

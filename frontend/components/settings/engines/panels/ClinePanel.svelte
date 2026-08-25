<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { ENGINES } from '$shared/constants/engines';
	import { clineAccountsStore, type ClineAccountItem } from '$frontend/stores/features/cline-accounts.svelte';
	import { clinePresetsStore } from '$frontend/stores/features/cline-presets.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import type { ClineStatus } from './panel-types';

	interface Props {
		status: ClineStatus | null;
		isLoading: boolean;
		onRefreshStatus: () => Promise<void> | void;
	}
	const { status, isLoading, onRefreshStatus }: Props = $props();

	const clineStatus = $derived(status);
	const isLoadingClineStatus = $derived(isLoading);
	const refreshClineStatus = () => onRefreshStatus();
	const clineEngine = ENGINES.find(e => e.type === 'cline')!;
	const clineAccounts = $derived(clineAccountsStore.accounts);
	const clinePresets = $derived(clinePresetsStore.presets);

	type ClineAddStep = 'idle' | 'choose' | 'picking-mode' | 'editing-api-key' | 'saving' | 'login' | 'success' | 'error';
	let clineAddStep = $state<ClineAddStep>('idle');
	let clineAddName = $state('');
	let clineAddProvider = $state('');
	let clineAddMode = $state<'api_key' | 'oauth' | null>(null);
	let clineAddError = $state('');
	/** Add-form field values, keyed by ClineCredentialField.key. */
	let clineAddValues = $state<Record<string, string>>({});
	/** null = adding a new account; set = re-authenticating that account in place. */
	let clineReauthAccountId = $state<number | null>(null);
	const clineSelectedPreset = $derived(clinePresets.find(p => p.id === clineAddProvider) ?? null);

	function clineFieldsFor(providerId: string) {
		return clinePresets.find(p => p.id === providerId)?.fields ?? [];
	}

	// OAuth login flow state
	let clineLoginId = $state<string | null>(null);
	let clineLoginMessages = $state<string[]>([]);
	let clineLoginUrl = $state<string | null>(null);
	let clineLoginPrompt = $state<{ message: string } | null>(null);
	let clineLoginPromptValue = $state('');

	// Inline edit-in-card state
	let clineEditingId = $state<number | null>(null);
	let clineEditName = $state('');
	let clineEditProvider = $state('');
	let clineEditAuthMethod = $state<'api_key' | 'oauth'>('api_key');
	let clineEditValues = $state<Record<string, string>>({});
	let clineDeleteDialogOpen = $state(false);
	let clineDeleteTargetId = $state<number | null>(null);

	const cleanups: Array<() => void> = [];

	onMount(() => {
		cleanups.push(
			ws.on('engine:cline-account-login-started', (data: { loginId: string }) => {
				clineLoginId = data.loginId;
			}),
			ws.on('engine:cline-account-login-event', (data: { loginId: string; kind: string; message?: string; url?: string }) => {
				if (data.kind === 'auth_url' && data.url) {
					clineLoginUrl = data.url;
					if (data.message) clineLoginMessages = [...clineLoginMessages, data.message];
				} else if (data.message) {
					clineLoginMessages = [...clineLoginMessages, data.message];
				}
			}),
			ws.on('engine:cline-account-login-prompt', (data: { loginId: string; message: string }) => {
				clineLoginPrompt = { message: data.message };
				clineLoginPromptValue = '';
			}),
			ws.on('engine:cline-account-login-complete', async (_data: { loginId: string; accountId: number }) => {
				clineAddStep = 'success';
				resetClineLoginState();
				await refreshClineStatus();
				await modelStore.refreshModels('cline');
			}),
			ws.on('engine:cline-account-login-error', (data: { loginId: string; message: string }) => {
				clineAddError = data.message;
				clineAddStep = 'error';
				resetClineLoginState();
			}),
		);

		clinePresetsStore.fetch();
	});

	onDestroy(() => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;
	});

	function resetClineLoginState() {
		clineLoginId = null;
		clineLoginMessages = [];
		clineLoginUrl = null;
		clineLoginPrompt = null;
		clineLoginPromptValue = '';
	}

	function startClineAdd() {
		clineAddStep = 'choose';
		clineAddName = '';
		clineAddError = '';
		clineAddMode = null;
		clineReauthAccountId = null;
		clineAddProvider = clinePresets[0]?.id ?? '';
		clineAddValues = {};
		resetClineLoginState();
	}

	/** Move from name+provider selection to the auth-mode choice (or straight to it, for single-mode providers). */
	function proceedClineChoose() {
		if (!clineAddName.trim() || !clineAddProvider) return;
		const modes = clineSelectedPreset?.authModes ?? [];
		if (modes.includes('api_key') && modes.includes('oauth')) {
			clineAddMode = null;
			clineAddStep = 'picking-mode';
		} else if (modes.includes('api_key')) {
			clineAddMode = 'api_key';
			clineAddStep = 'editing-api-key';
		} else if (modes.includes('oauth')) {
			clineAddMode = 'oauth';
			beginClineLogin();
		}
	}

	/** Move from the auth-mode choice to the matching next step. */
	function proceedClineMode() {
		if (!clineAddMode) return;
		if (clineAddMode === 'api_key') {
			clineAddStep = 'editing-api-key';
		} else {
			beginClineLogin();
		}
	}

	/** Save a new API-key account from the all-fields-at-once form. */
	async function submitClineAdd() {
		if (!clineAddValid) return;
		clineAddStep = 'saving';
		clineAddError = '';
		try {
			await ws.http('engine:cline-accounts-save', { name: clineAddName.trim(), provider: clineAddProvider, values: clineAddValues });
			clineAddStep = 'success';
			await refreshClineStatus();
			await modelStore.refreshModels('cline');
		} catch (error: any) {
			clineAddError = error?.message || 'Failed to add account';
			clineAddStep = 'error';
		}
	}

	const clineAddValid = $derived(
		!!clineAddName.trim() && !!clineAddProvider
			&& clineFieldsFor(clineAddProvider).every(f => f.optional || !!clineAddValues[f.key]?.trim())
	);

	function cancelClineAdd() {
		if (clineLoginId) ws.emit('engine:cline-account-login-cancel', { loginId: clineLoginId });
		clineAddStep = 'idle';
		clineAddError = '';
		clineReauthAccountId = null;
		resetClineLoginState();
	}

	/** Start the OAuth login for a new account. */
	function beginClineLogin() {
		if (!clineAddName.trim() || !clineAddProvider) return;
		clineAddStep = 'login';
		clineAddError = '';
		clineReauthAccountId = null;
		resetClineLoginState();
		ws.emit('engine:cline-account-login-start', { name: clineAddName.trim(), provider: clineAddProvider });
	}

	/** Re-authenticate an existing OAuth account in place. */
	function startClineReauth(account: ClineAccountItem) {
		clineReauthAccountId = account.id;
		clineAddStep = 'login';
		clineAddError = '';
		resetClineLoginState();
		ws.emit('engine:cline-account-login-start', {
			name: account.name,
			provider: account.provider,
			reauthAccountId: account.id,
		});
	}

	function submitClineLoginPrompt() {
		if (!clineLoginId || !clineLoginPrompt) return;
		ws.emit('engine:cline-account-login-submit', { loginId: clineLoginId, value: clineLoginPromptValue });
		clineLoginPrompt = null;
		clineLoginPromptValue = '';
	}

	async function switchClineAccount(id: number) {
		try {
			await ws.http('engine:cline-accounts-switch', { id });
			await clineAccountsStore.refresh();
			await refreshClineStatus();
			await modelStore.refreshModels('cline');
		} catch {
			// Ignore
		}
	}

	function confirmDeleteClineAccount(id: number) {
		clineDeleteTargetId = id;
		clineDeleteDialogOpen = true;
	}

	async function deleteClineAccount() {
		if (clineDeleteTargetId === null) return;
		try {
			await ws.http('engine:cline-accounts-delete', { id: clineDeleteTargetId });
			await clineAccountsStore.refresh();
			await refreshClineStatus();
			await modelStore.refreshModels('cline');
		} catch {
			// Ignore
		}
	}

	/** Open the inline edit form for an account (all fields shown, like OpenCode). */
	function startClineEdit(account: ClineAccountItem) {
		clineEditingId = account.id;
		clineEditName = account.name;
		clineEditProvider = account.provider;
		clineEditAuthMethod = account.authMethod;
		const values: Record<string, string> = {};
		for (const field of clineFieldsFor(account.provider)) {
			// Prefill non-secret config (base url, region); leave secrets blank so an
			// untouched save keeps the stored key.
			values[field.key] = field.secret ? '' : (account.fields[field.key] ?? '');
		}
		clineEditValues = values;
	}

	async function submitClineEdit() {
		if (clineEditingId === null || !clineEditName.trim()) return;
		try {
			if (clineEditAuthMethod === 'oauth') {
				// OAuth accounts have no editable key fields — only the name.
				await ws.http('engine:cline-accounts-rename', { id: clineEditingId, name: clineEditName.trim() });
			} else {
				await ws.http('engine:cline-accounts-save', {
					accountId: clineEditingId,
					name: clineEditName.trim(),
					provider: clineEditProvider,
					values: clineEditValues,
				});
			}
			clineEditingId = null;
			await clineAccountsStore.refresh();
			await refreshClineStatus();
			await modelStore.refreshModels('cline');
		} catch {
			// Ignore
		}
	}

	function cancelClineEdit() {
		clineEditingId = null;
	}
</script>

<!-- Cline Card -->
<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div class="flex items-center gap-3">
			<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
				{@html isDarkMode() ? clineEngine.icon.dark : clineEngine.icon.light}
			</div>
			<div>
				<h3 class="font-semibold text-slate-900 dark:text-slate-100">{clineEngine.name}</h3>
				<p class="text-xs text-slate-500 dark:text-slate-400">{clineEngine.description}</p>
			</div>
		</div>
	</div>

	<div class="px-5 py-4">
		{#if isLoadingClineStatus}
			<div class="flex items-center justify-center py-8">
				<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
			</div>
		{:else if clineStatus}
			<div class="space-y-3">
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Accounts</h4>
					<span class="text-xs text-slate-500">{clineAccounts.length} account{clineAccounts.length === 1 ? '' : 's'}</span>
				</div>

				<!-- Accounts list -->
				<div class="space-y-2">
					{#if clineAccounts.length === 0}
						<p class="text-xs text-slate-500 italic">No accounts yet — add one below.</p>
					{:else}
						{#each clineAccounts as account (account.id)}
							<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
								<div class="flex items-center justify-between px-3.5 py-2.5">
									<div class="w-full flex items-center gap-2.5 min-w-0">
										<Icon name={account.authMethod === 'oauth' ? 'lucide:user-round' : 'lucide:key'} class="w-4 h-4 shrink-0 text-slate-400" />
										<div class="flex flex-col min-w-0 gap-0.5">
											<div class="flex items-center gap-2 min-w-0">
												<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
												{#if account.isActive}
													<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
												{/if}
											</div>
											<div class="flex items-center gap-2 min-w-0 text-2xs text-slate-500 dark:text-slate-400">
												<span class="font-medium">{account.provider}</span>
												<span class="text-slate-400">·</span>
												<span>{account.authMethod === 'oauth' ? 'Sign-in' : 'API key'}</span>
											</div>
										</div>
									</div>
									<div class="flex items-center gap-1">
										{#if !account.isActive}
											<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchClineAccount(account.id)} title="Switch to this account">
												<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
											</button>
										{/if}
										<button type="button" class="flex p-1.5 rounded-md {clineEditingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => clineEditingId === account.id ? cancelClineEdit() : startClineEdit(account)} title="Edit account">
											<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
										</button>
										<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteClineAccount(account.id)} title="Delete account">
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									</div>
								</div>

								{#if clineEditingId === account.id}
									{#if clineReauthAccountId === account.id && clineAddStep !== 'idle'}
										<div class="px-3.5 pb-3 pt-2 border-t border-slate-200 dark:border-slate-700/50">
											{@render clineAddFlow()}
										</div>
									{:else}
									<AccountEditForm onSave={submitClineEdit} onCancel={cancelClineEdit} onReauth={account.authMethod === 'oauth' ? () => startClineReauth(account) : undefined} saveDisabled={!clineEditName.trim()}>
										<AccountField label="Account name" bind:value={clineEditName} />
										{#if account.authMethod === 'oauth'}
											<p class="text-2xs text-slate-500 dark:text-slate-400">Sign-in account — re-run the provider sign-in to refresh credentials.</p>
										{:else}
											{#each clineFieldsFor(account.provider) as field (field.key)}
												<AccountField label={field.label} secret={field.secret} hint={field.secret ? '(leave blank to keep)' : ''} placeholder={field.secret ? undefined : field.placeholder} bind:value={clineEditValues[field.key]} />
											{/each}
										{/if}
									</AccountEditForm>
									{/if}
								{/if}
							</div>
						{/each}
					{/if}
				</div>

				<!-- Add Account Flow -->
				<div class="pt-1">
					{#if clineAddStep === 'idle' || clineReauthAccountId !== null}
						<button type="button" class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center" onclick={startClineAdd}>
							<Icon name="lucide:plus" class="w-4 h-4" />
							Add Account
						</button>
					{:else}
						{@render clineAddFlow()}
					{/if}
				</div>

				{#snippet clineAddFlow()}
					{#if clineAddStep === 'choose'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
								Add a Cline provider account
							</div>
							<div class="space-y-2">
								<input type="text" bind:value={clineAddName} placeholder="Account name (e.g. Personal, Work)" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500" />
								<select bind:value={clineAddProvider} onchange={() => { clineAddValues = {}; }} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500">
									{#each clinePresets as preset (preset.id)}
										<option value={preset.id}>{preset.name}</option>
									{/each}
								</select>
							</div>
							<div class="flex gap-2">
								<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={proceedClineChoose} disabled={!clineAddName.trim() || !clineAddProvider}>
									<Icon name="lucide:arrow-right" class="w-4 h-4" />
									Next
								</button>
								<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelClineAdd}>Cancel</button>
							</div>
						</div>
					{:else if clineAddStep === 'picking-mode'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name="lucide:user-plus" class="w-3.5 h-3.5" />
								How do you want to connect {clineSelectedPreset?.name}?
							</div>
							<div class="space-y-2" role="radiogroup" aria-label="Authentication mode">
								<button type="button" role="radio" aria-checked={clineAddMode === 'api_key'} onclick={() => { clineAddMode = 'api_key'; }} class="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg border cursor-pointer transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 {clineAddMode === 'api_key' ? 'border-violet-400 ring-1 ring-violet-500/40 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:border-violet-400'}">
									<span class="relative flex items-center justify-center w-4 h-4 rounded-full border-2 transition-colors {clineAddMode === 'api_key' ? 'border-violet-500' : 'border-slate-300 dark:border-slate-500'}">
										<span class="w-2 h-2 rounded-full bg-violet-500 transition-transform {clineAddMode === 'api_key' ? 'scale-100' : 'scale-0'}"></span>
									</span>
									<Icon name="lucide:key" class="w-3.5 h-3.5" />
									<span>API key</span>
								</button>
								<button type="button" role="radio" aria-checked={clineAddMode === 'oauth'} onclick={() => { clineAddMode = 'oauth'; }} class="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg border cursor-pointer transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 {clineAddMode === 'oauth' ? 'border-violet-400 ring-1 ring-violet-500/40 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:border-violet-400'}">
									<span class="relative flex items-center justify-center w-4 h-4 rounded-full border-2 transition-colors {clineAddMode === 'oauth' ? 'border-violet-500' : 'border-slate-300 dark:border-slate-500'}">
										<span class="w-2 h-2 rounded-full bg-violet-500 transition-transform {clineAddMode === 'oauth' ? 'scale-100' : 'scale-0'}"></span>
									</span>
									<Icon name="lucide:log-in" class="w-3.5 h-3.5" />
									<span>{clineSelectedPreset?.oauthLabel ?? 'Sign in'}</span>
								</button>
							</div>
							<div class="flex gap-2">
								<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={proceedClineMode} disabled={!clineAddMode}>
									<Icon name="lucide:arrow-right" class="w-4 h-4" />
									Next
								</button>
								<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={() => { clineAddStep = 'choose'; }}>Back</button>
							</div>
						</div>
					{:else if clineAddStep === 'editing-api-key'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name="lucide:key" class="w-3.5 h-3.5" />
								Add your {clineSelectedPreset?.name} API key
							</div>
							<div class="space-y-2">
								{#each clineFieldsFor(clineAddProvider) as field (field.key)}
									<div class="space-y-1">
										<label class="text-2xs font-medium text-slate-500 dark:text-slate-400" for="cline-add-{field.key}">{field.label}{field.optional ? ' (optional)' : ''}</label>
										<input id="cline-add-{field.key}" type="text" bind:value={clineAddValues[field.key]} placeholder={field.placeholder ?? `Enter ${field.label}`} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500" />
									</div>
								{/each}
								{#if clineSelectedPreset?.apiKeyUrl}
									<a href={clineSelectedPreset.apiKeyUrl} target="_blank" rel="noopener noreferrer" class="text-2xs text-violet-600 dark:text-violet-400 hover:underline">Get an API key ↗</a>
								{/if}
							</div>
							<div class="flex gap-2">
								<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={submitClineAdd} disabled={!clineAddValid}>
									<Icon name="lucide:plus" class="w-4 h-4" />
									Add account
								</button>
								<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelClineAdd}>Cancel</button>
							</div>
						</div>
					{:else if clineAddStep === 'saving'}
						<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
								<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
								<span>Saving account…</span>
							</div>
						</div>
					{:else if clineAddStep === 'login'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name={clineReauthAccountId ? 'lucide:key-round' : 'lucide:log-in'} class="w-3.5 h-3.5" />
								{clineReauthAccountId ? 'Re-authenticating account' : 'Authenticating'}
							</div>
							{#if clineLoginUrl}
								<div class="space-y-1.5">
									<p class="text-xs text-slate-600 dark:text-slate-400">Open this URL to authorize, then return here:</p>
									<a href={clineLoginUrl} target="_blank" rel="noopener noreferrer" class="block text-xs text-violet-600 dark:text-violet-400 hover:underline break-all">{clineLoginUrl}</a>
								</div>
							{/if}
							{#each clineLoginMessages as msg}
								<p class="text-xs text-slate-500 dark:text-slate-400">{msg}</p>
							{/each}
							{#if clineLoginPrompt}
								<div class="space-y-2">
									<p class="text-xs font-medium text-slate-700 dark:text-slate-300">{clineLoginPrompt.message}</p>
									<input type="text" bind:value={clineLoginPromptValue} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>
								<div class="flex gap-2">
									<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors" onclick={submitClineLoginPrompt}>
										<Icon name="lucide:arrow-right" class="w-4 h-4" />
										Submit
									</button>
									<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelClineAdd}>
										Cancel
									</button>
								</div>
							{:else}
								<div class="flex items-center gap-2 text-sm text-slate-500">
									<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
									<span>Waiting for authentication…</span>
								</div>
								<button type="button" class="w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelClineAdd}>
									Cancel
								</button>
							{/if}
						</div>
					{:else if clineAddStep === 'success'}
						<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
							<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
							<span class="text-sm text-green-700 dark:text-green-300">Account added successfully!</span>
							<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={cancelClineAdd}>Dismiss</button>
						</div>
					{:else if clineAddStep === 'error'}
						<div class="space-y-3">
							<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
								<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
								<span class="text-sm text-red-700 dark:text-red-300">{clineAddError}</span>
							</div>
							<button type="button" class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onclick={startClineAdd}>
								<Icon name="lucide:rotate-ccw" class="w-4 h-4" />
								Try Again
							</button>
						</div>
					{/if}
				{/snippet}
			</div>
		{/if}
	</div>
</div>

<Dialog
	bind:isOpen={clineDeleteDialogOpen}
	onClose={() => { clineDeleteDialogOpen = false; clineDeleteTargetId = null; }}
	type="error"
	title="Delete Cline Account"
	message="Are you sure you want to delete this Cline account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteClineAccount}
/>

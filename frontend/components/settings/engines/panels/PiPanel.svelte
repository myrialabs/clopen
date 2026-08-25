<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { ENGINES } from '$shared/constants/engines';
	import { piAccountsStore, type PiAccountItem } from '$frontend/stores/features/pi-accounts.svelte';
	import { piPresetsStore } from '$frontend/stores/features/pi-presets.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import type { PiStatus } from './panel-types';

	interface Props {
		status: PiStatus | null;
		isLoading: boolean;
		onRefreshStatus: () => Promise<void> | void;
	}
	const { status, isLoading, onRefreshStatus }: Props = $props();

	const piStatus = $derived(status);
	const isLoadingPiStatus = $derived(isLoading);
	const refreshPiStatus = () => onRefreshStatus();
	const piEngine = ENGINES.find(e => e.type === 'pi')!;
	const piAccounts = $derived(piAccountsStore.accounts);
	const piPresets = $derived(piPresetsStore.presets);

	type PiAddStep = 'idle' | 'choose' | 'picking-mode' | 'editing-api-key' | 'saving' | 'login' | 'success' | 'error';
	let piAddStep = $state<PiAddStep>('idle');
	let piAddName = $state('');
	let piAddProvider = $state('');
	let piAddMode = $state<'api_key' | 'oauth' | null>(null);
	let piAddError = $state('');
	/** Add-form field values, keyed by PiCredentialField.key. */
	let piAddValues = $state<Record<string, string>>({});
	/** null = adding a new account; set = re-authenticating that account in place. */
	let piReauthAccountId = $state<number | null>(null);
	const piSelectedPreset = $derived(piPresets.find(p => p.id === piAddProvider) ?? null);

	function piFieldsFor(providerId: string) {
		return piPresets.find(p => p.id === providerId)?.fields ?? [];
	}

	// Interactive / OAuth login flow state
	let piLoginId = $state<string | null>(null);
	let piLoginMessages = $state<string[]>([]);
	let piLoginUrl = $state<string | null>(null);
	let piLoginDeviceCode = $state<{ userCode: string; verificationUri: string } | null>(null);
	let piLoginPrompt = $state<{ kind: string; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] } | null>(null);
	let piLoginPromptValue = $state('');

	// Inline edit-in-card state
	let piEditingId = $state<number | null>(null);
	let piEditName = $state('');
	let piEditProvider = $state('');
	let piEditAuthType = $state<'api_key' | 'oauth'>('api_key');
	let piEditValues = $state<Record<string, string>>({});
	let piDeleteDialogOpen = $state(false);
	let piDeleteTargetId = $state<number | null>(null);

	// Event listener cleanup functions
	const cleanups: Array<() => void> = [];

	onMount(() => {
		// Pi interactive/OAuth login event listeners
		cleanups.push(
			ws.on('engine:pi-account-login-started', (data: { loginId: string }) => {
				piLoginId = data.loginId;
			}),
			ws.on('engine:pi-account-login-event', (data: { loginId: string; kind: string; message?: string; url?: string; instructions?: string; userCode?: string; verificationUri?: string }) => {
				if (data.kind === 'auth_url' && data.url) {
					piLoginUrl = data.url;
					if (data.instructions) piLoginMessages = [...piLoginMessages, data.instructions];
				} else if (data.kind === 'device_code' && data.userCode && data.verificationUri) {
					piLoginDeviceCode = { userCode: data.userCode, verificationUri: data.verificationUri };
				} else if (data.message) {
					piLoginMessages = [...piLoginMessages, data.message];
				}
			}),
			ws.on('engine:pi-account-login-prompt', (data: { loginId: string; kind: string; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] }) => {
				piLoginPrompt = { kind: data.kind, message: data.message, placeholder: data.placeholder, options: data.options };
				piLoginPromptValue = data.options?.[0]?.id ?? '';
			}),
			ws.on('engine:pi-account-login-complete', async (_data: { loginId: string; accountId: number }) => {
				piAddStep = 'success';
				resetPiLoginState();
				await refreshPiStatus();
				await modelStore.refreshModels('pi');
			}),
			ws.on('engine:pi-account-login-error', (data: { loginId: string; message: string }) => {
				piAddError = data.message;
				piAddStep = 'error';
				resetPiLoginState();
			}),
		);

		piPresetsStore.fetch();
	});

	onDestroy(() => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;
	});

	function resetPiLoginState() {
		piLoginId = null;
		piLoginMessages = [];
		piLoginUrl = null;
		piLoginDeviceCode = null;
		piLoginPrompt = null;
		piLoginPromptValue = '';
	}

	function startPiAdd() {
		piAddStep = 'choose';
		piAddName = '';
		piAddError = '';
		piAddMode = null;
		piReauthAccountId = null;
		piAddProvider = piPresets[0]?.id ?? '';
		piAddValues = {};
		resetPiLoginState();
	}

	/** Move from name+provider selection to the auth-mode choice (or straight to it, for single-mode providers). */
	function proceedPiChoose() {
		if (!piAddName.trim() || !piAddProvider) return;
		const modes = piSelectedPreset?.authModes ?? [];
		if (modes.includes('api_key') && modes.includes('oauth')) {
			piAddMode = null;
			piAddStep = 'picking-mode';
		} else if (modes.includes('api_key')) {
			piAddMode = 'api_key';
			piAddStep = 'editing-api-key';
		} else if (modes.includes('oauth')) {
			piAddMode = 'oauth';
			beginPiLogin('oauth');
		}
	}

	/** Move from the auth-mode choice to the matching next step. */
	function proceedPiMode() {
		if (!piAddMode) return;
		if (piAddMode === 'api_key') {
			piAddStep = 'editing-api-key';
		} else {
			beginPiLogin('oauth');
		}
	}

	/** Save a new API-key account from the all-fields-at-once form. */
	async function submitPiAdd() {
		if (!piAddName.trim() || !piAddProvider) return;
		const fields = piFieldsFor(piAddProvider);
		for (const field of fields) {
			if (!piAddValues[field.key]?.trim()) return;
		}
		piAddStep = 'saving';
		piAddError = '';
		try {
			await ws.http('engine:pi-accounts-save', { name: piAddName.trim(), provider: piAddProvider, values: piAddValues });
			piAddStep = 'success';
			await refreshPiStatus();
			await modelStore.refreshModels('pi');
		} catch (error: any) {
			piAddError = error?.message || 'Failed to add account';
			piAddStep = 'error';
		}
	}

	const piAddValid = $derived(
		!!piAddName.trim() && !!piAddProvider && piFieldsFor(piAddProvider).every(f => !!piAddValues[f.key]?.trim())
	);

	function cancelPiAdd() {
		if (piLoginId) ws.emit('engine:pi-account-login-cancel', { loginId: piLoginId });
		piAddStep = 'idle';
		piAddError = '';
		piReauthAccountId = null;
		resetPiLoginState();
	}

	/**
	 * Start the interactive login for a new account. Both API-key and OAuth go
	 * through `login()` so the provider can prompt for whatever it needs
	 * (e.g. Cloudflare asks for an account ID + key, not just a key).
	 */
	function beginPiLogin(type: 'api_key' | 'oauth') {
		if (!piAddName.trim() || !piAddProvider) return;
		piAddStep = 'login';
		piAddError = '';
		piReauthAccountId = null;
		resetPiLoginState();
		ws.emit('engine:pi-account-login-start', { name: piAddName.trim(), provider: piAddProvider, type });
	}

	/** Re-authenticate an existing account in place (re-runs its provider's login). */
	function startPiReauth(account: PiAccountItem) {
		// Keep the account's edit form open so the login flow renders in place;
		// the edit form swaps to the auth flow while piReauthAccountId is set.
		piReauthAccountId = account.id;
		piAddStep = 'login';
		piAddError = '';
		resetPiLoginState();
		ws.emit('engine:pi-account-login-start', {
			name: account.name,
			provider: account.provider,
			type: account.authType,
			reauthAccountId: account.id,
		});
	}

	function submitPiLoginPrompt() {
		if (!piLoginId || !piLoginPrompt) return;
		ws.emit('engine:pi-account-login-submit', { loginId: piLoginId, value: piLoginPromptValue });
		piLoginPrompt = null;
		piLoginPromptValue = '';
	}

	async function switchPiAccount(id: number) {
		try {
			await ws.http('engine:pi-accounts-switch', { id });
			await piAccountsStore.refresh();
			await refreshPiStatus();
			await modelStore.refreshModels('pi');
		} catch {
			// Ignore
		}
	}

	function confirmDeletePiAccount(id: number) {
		piDeleteTargetId = id;
		piDeleteDialogOpen = true;
	}

	async function deletePiAccount() {
		if (piDeleteTargetId === null) return;
		try {
			await ws.http('engine:pi-accounts-delete', { id: piDeleteTargetId });
			await piAccountsStore.refresh();
			await refreshPiStatus();
			await modelStore.refreshModels('pi');
		} catch {
			// Ignore
		}
	}

	/** Open the inline edit form for an account (all fields shown, like OpenCode). */
	function startPiEdit(account: PiAccountItem) {
		piEditingId = account.id;
		piEditName = account.name;
		piEditProvider = account.provider;
		piEditAuthType = account.authType;
		const values: Record<string, string> = {};
		for (const field of piFieldsFor(account.provider)) {
			// Prefill non-secret config (account id, base url); leave secrets blank
			// so an untouched save keeps the stored key.
			values[field.key] = field.role === 'env' ? (account.env[field.key] ?? '') : '';
		}
		piEditValues = values;
	}

	async function submitPiEdit() {
		if (piEditingId === null || !piEditName.trim()) return;
		try {
			if (piEditAuthType === 'oauth') {
				// OAuth accounts have no editable key fields — only the name. (The
				// save endpoint would rebuild an api_key credential.)
				await ws.http('engine:pi-accounts-rename', { id: piEditingId, name: piEditName.trim() });
			} else {
				await ws.http('engine:pi-accounts-save', {
					accountId: piEditingId,
					name: piEditName.trim(),
					provider: piEditProvider,
					values: piEditValues,
				});
			}
			piEditingId = null;
			await piAccountsStore.refresh();
			await refreshPiStatus();
			await modelStore.refreshModels('pi');
		} catch {
			// Ignore
		}
	}

	function cancelPiEdit() {
		piEditingId = null;
	}
</script>

<!-- Pi Card -->
<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div class="flex items-center gap-3">
			<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
				{@html isDarkMode() ? piEngine.icon.dark : piEngine.icon.light}
			</div>
			<div>
				<h3 class="font-semibold text-slate-900 dark:text-slate-100">{piEngine.name}</h3>
				<p class="text-xs text-slate-500 dark:text-slate-400">{piEngine.description}</p>
			</div>
		</div>
	</div>

	<div class="px-5 py-4">
		{#if isLoadingPiStatus}
			<div class="flex items-center justify-center py-8">
				<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
			</div>
		{:else if piStatus}
			<div class="space-y-3">
				<div class="flex items-center justify-between">
					<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Accounts</h4>
					<span class="text-xs text-slate-500">{piAccounts.length} account{piAccounts.length === 1 ? '' : 's'}</span>
				</div>

				<!-- Accounts list -->
				<div class="space-y-2">
					{#if piAccounts.length === 0}
						<p class="text-xs text-slate-500 italic">No accounts yet — add one below.</p>
					{:else}
						{#each piAccounts as account (account.id)}
							<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
								<div class="flex items-center justify-between px-3.5 py-2.5">
									<div class="w-full flex items-center gap-2.5 min-w-0">
										<Icon name={account.authType === 'oauth' ? 'lucide:user-round' : 'lucide:key'} class="w-4 h-4 shrink-0 text-slate-400" />
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
												<span>{account.authType === 'oauth' ? 'Subscription' : 'API key'}</span>
											</div>
										</div>
									</div>
									<div class="flex items-center gap-1">
										{#if !account.isActive}
											<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchPiAccount(account.id)} title="Switch to this account">
												<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
											</button>
										{/if}
										<button type="button" class="flex p-1.5 rounded-md {piEditingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => piEditingId === account.id ? cancelPiEdit() : startPiEdit(account)} title="Edit account">
											<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
										</button>
										<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeletePiAccount(account.id)} title="Delete account">
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									</div>
								</div>

								{#if piEditingId === account.id}
									{#if piReauthAccountId === account.id && piAddStep !== 'idle'}
										<div class="px-3.5 pb-3 pt-2 border-t border-slate-200 dark:border-slate-700/50">
											{@render piAddFlow()}
										</div>
									{:else}
									<AccountEditForm onSave={submitPiEdit} onCancel={cancelPiEdit} onReauth={account.authType === 'oauth' ? () => startPiReauth(account) : undefined} saveDisabled={!piEditName.trim()}>
										<AccountField label="Account name" bind:value={piEditName} />
										{#if account.authType === 'oauth'}
											<p class="text-2xs text-slate-500 dark:text-slate-400">Subscription account — re-run the provider sign-in to refresh credentials.</p>
										{:else}
											{#each piFieldsFor(account.provider) as field (field.key)}
												<AccountField label={field.label} secret={field.secret} hint={field.secret ? '(leave blank to keep)' : ''} placeholder={field.secret ? undefined : field.placeholder} bind:value={piEditValues[field.key]} />
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
					{#if piAddStep === 'idle' || piReauthAccountId !== null}
						<button type="button" class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center" onclick={startPiAdd}>
							<Icon name="lucide:plus" class="w-4 h-4" />
							Add Account
						</button>
					{:else}
						{@render piAddFlow()}
					{/if}
				</div>

				{#snippet piAddFlow()}
					{#if piAddStep === 'choose'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
								Add a Pi provider account
							</div>
							<div class="space-y-2">
								<input type="text" bind:value={piAddName} placeholder="Account name (e.g. Personal, Work)" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500" />
								<select bind:value={piAddProvider} onchange={() => { piAddValues = {}; }} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500">
									{#each piPresets as preset (preset.id)}
										<option value={preset.id}>{preset.name}</option>
									{/each}
								</select>
							</div>
							<div class="flex gap-2">
								<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={proceedPiChoose} disabled={!piAddName.trim() || !piAddProvider}>
									<Icon name="lucide:arrow-right" class="w-4 h-4" />
									Next
								</button>
								<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelPiAdd}>Cancel</button>
							</div>
						</div>
					{:else if piAddStep === 'picking-mode'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name="lucide:user-plus" class="w-3.5 h-3.5" />
								How do you want to connect {piSelectedPreset?.name}?
							</div>
							<div class="space-y-2" role="radiogroup" aria-label="Authentication mode">
								<button type="button" role="radio" aria-checked={piAddMode === 'api_key'} onclick={() => { piAddMode = 'api_key'; }} class="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg border cursor-pointer transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 {piAddMode === 'api_key' ? 'border-violet-400 ring-1 ring-violet-500/40 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:border-violet-400'}">
									<span class="relative flex items-center justify-center w-4 h-4 rounded-full border-2 transition-colors {piAddMode === 'api_key' ? 'border-violet-500' : 'border-slate-300 dark:border-slate-500'}">
										<span class="w-2 h-2 rounded-full bg-violet-500 transition-transform {piAddMode === 'api_key' ? 'scale-100' : 'scale-0'}"></span>
									</span>
									<Icon name="lucide:key" class="w-3.5 h-3.5" />
									<span>API key</span>
								</button>
								<button type="button" role="radio" aria-checked={piAddMode === 'oauth'} onclick={() => { piAddMode = 'oauth'; }} class="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg border cursor-pointer transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 {piAddMode === 'oauth' ? 'border-violet-400 ring-1 ring-violet-500/40 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:border-violet-400'}">
									<span class="relative flex items-center justify-center w-4 h-4 rounded-full border-2 transition-colors {piAddMode === 'oauth' ? 'border-violet-500' : 'border-slate-300 dark:border-slate-500'}">
										<span class="w-2 h-2 rounded-full bg-violet-500 transition-transform {piAddMode === 'oauth' ? 'scale-100' : 'scale-0'}"></span>
									</span>
									<Icon name="lucide:log-in" class="w-3.5 h-3.5" />
									<span>{piSelectedPreset?.oauthLabel ?? 'Sign in'}</span>
								</button>
							</div>
							<div class="flex gap-2">
								<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={proceedPiMode} disabled={!piAddMode}>
									<Icon name="lucide:arrow-right" class="w-4 h-4" />
									Next
								</button>
								<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={() => { piAddStep = 'choose'; }}>Back</button>
							</div>
						</div>
					{:else if piAddStep === 'editing-api-key'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name="lucide:key" class="w-3.5 h-3.5" />
								Add your {piSelectedPreset?.name} API key
							</div>
							<div class="space-y-2">
								{#each piFieldsFor(piAddProvider) as field (field.key)}
									<div class="space-y-1">
										<label class="text-2xs font-medium text-slate-500 dark:text-slate-400" for="pi-add-{field.key}">{field.label}</label>
										<input id="pi-add-{field.key}" type="text" bind:value={piAddValues[field.key]} placeholder={field.placeholder ?? `Enter ${field.label}`} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500" />
									</div>
								{/each}
								{#if piSelectedPreset?.apiKeyUrl}
									<a href={piSelectedPreset.apiKeyUrl} target="_blank" rel="noopener noreferrer" class="text-2xs text-violet-600 dark:text-violet-400 hover:underline">Get an API key ↗</a>
								{/if}
							</div>
							<div class="flex gap-2">
								<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={submitPiAdd} disabled={!piAddValid}>
									<Icon name="lucide:plus" class="w-4 h-4" />
									Add account
								</button>
								<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelPiAdd}>Cancel</button>
							</div>
						</div>
					{:else if piAddStep === 'saving'}
						<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
								<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
								<span>Saving account…</span>
							</div>
						</div>
					{:else if piAddStep === 'login'}
						<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
							<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
								<Icon name={piReauthAccountId ? 'lucide:key-round' : 'lucide:log-in'} class="w-3.5 h-3.5" />
								{piReauthAccountId ? 'Re-authenticating account' : 'Authenticating'}
							</div>
							{#if piLoginUrl}
								<div class="space-y-1.5">
									<p class="text-xs text-slate-600 dark:text-slate-400">Open this URL to authorize, then return here:</p>
									<a href={piLoginUrl} target="_blank" rel="noopener noreferrer" class="block text-xs text-violet-600 dark:text-violet-400 hover:underline break-all">{piLoginUrl}</a>
								</div>
							{/if}
							{#if piLoginDeviceCode}
								<div class="space-y-1.5 text-xs text-slate-600 dark:text-slate-400">
									<p>Go to <a href={piLoginDeviceCode.verificationUri} target="_blank" rel="noopener noreferrer" class="text-violet-600 dark:text-violet-400 hover:underline">{piLoginDeviceCode.verificationUri}</a> and enter code:</p>
									<code class="inline-block px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 font-mono text-sm text-slate-900 dark:text-slate-100">{piLoginDeviceCode.userCode}</code>
								</div>
							{/if}
							{#each piLoginMessages as msg}
								<p class="text-xs text-slate-500 dark:text-slate-400">{msg}</p>
							{/each}
							{#if piLoginPrompt}
								<div class="space-y-2">
									<p class="text-xs font-medium text-slate-700 dark:text-slate-300">{piLoginPrompt.message}</p>
									{#if piLoginPrompt.kind === 'select' && piLoginPrompt.options}
										<select bind:value={piLoginPromptValue} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40">
											{#each piLoginPrompt.options as opt (opt.id)}
												<option value={opt.id}>{opt.label}</option>
											{/each}
										</select>
									{:else}
										<input type="text" bind:value={piLoginPromptValue} placeholder={piLoginPrompt.placeholder ?? ''} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
									{/if}
								</div>
								<div class="flex gap-2">
									<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors" onclick={submitPiLoginPrompt}>
										<Icon name="lucide:arrow-right" class="w-4 h-4" />
										Submit
									</button>
									<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelPiAdd}>
										Cancel
									</button>
								</div>
							{:else}
								<div class="flex items-center gap-2 text-sm text-slate-500">
									<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
									<span>Waiting for authentication…</span>
								</div>
								<button type="button" class="w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelPiAdd}>
									Cancel
								</button>
							{/if}
						</div>
					{:else if piAddStep === 'success'}
						<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
							<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
							<span class="text-sm text-green-700 dark:text-green-300">Account added successfully!</span>
							<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={cancelPiAdd}>Dismiss</button>
						</div>
					{:else if piAddStep === 'error'}
						<div class="space-y-3">
							<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
								<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
								<span class="text-sm text-red-700 dark:text-red-300">{piAddError}</span>
							</div>
							<button type="button" class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onclick={startPiAdd}>
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
	bind:isOpen={piDeleteDialogOpen}
	onClose={() => { piDeleteDialogOpen = false; piDeleteTargetId = null; }}
	type="error"
	title="Delete Pi Account"
	message="Are you sure you want to delete this Pi account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deletePiAccount}
/>

<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { debug } from '$shared/utils/logger';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import { opencodeProvidersStore, type OpenCodeProviderItem, type OpenCodeAccountItem, type ModelsDevProviderItem } from '$frontend/stores/features/opencode-providers.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { settings, togglePinnedModel } from '$frontend/stores/features/settings.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import type { OpenCodeStatus } from './panel-types';

	interface Props {
		status: OpenCodeStatus | null;
		isLoading: boolean;
	}
	const { status, isLoading }: Props = $props();

	const openCodeStatus = $derived(status);
	const isLoadingOpenCodeStatus = $derived(isLoading);
	const openCodeEngine = ENGINES.find(e => e.type === 'opencode')!;

	// OpenCode provider management
	const ocProviders = $derived(opencodeProvidersStore.providers);
	const ocCatalog = $derived(opencodeProvidersStore.catalog);

	// Add provider flow
	type OCAddStep = 'idle' | 'picking' | 'configuring' | 'custom' | 'saving' | 'success' | 'error';
	let ocAddStep = $state<OCAddStep>('idle');
	let ocAddError = $state('');
	let ocCatalogSearch = $state('');
	let ocSelectedCatalogProvider = $state<ModelsDevProviderItem | null>(null);
	let ocAddAccountName = $state('');
	let ocAddApiKey = $state('');
	let ocAddOptions = $state<Record<string, string>>({});
	let ocCatalogRefreshing = $state(false);

	// Model row: per-model context/output limits (null = fall back to defaults).
	type OcModelRow = { code: string; alias: string; hidden: boolean; context: number | null; output: number | null };

	// Custom provider form
	let ocCustomName = $state('');
	let ocCustomSlug = $state('');
	let ocCustomBaseUrl = $state('');
	let ocCustomApiKey = $state('');
	let ocCustomModelRows = $state<OcModelRow[]>([]);
	let ocCustomFetching = $state(false);
	let ocEditingProviderId = $state<number | null>(null);

	// Edit form (reuses custom provider form fields)
	let ocEditName = $state('');
	let ocEditSlug = $state('');
	let ocEditBaseUrl = $state('');
	let ocEditModelRows = $state<OcModelRow[]>([]);
	let ocEditFetching = $state(false);
	let ocDragIndex = $state<number | null>(null);

	// Derived: split providers
	const ocCatalogSlugs = $derived(new Set(ocCatalog.map(c => c.id)));
	const ocCatalogProviders = $derived(ocProviders.filter(p => ocCatalogSlugs.has(p.slug)));
	const ocCustomProviders = $derived(ocProviders.filter(p => p.apiUrl && !ocCatalogSlugs.has(p.slug)));

	// Provider account management
	let ocRenamingAccountId = $state<number | null>(null);
	let ocRenameValue = $state('');
	// Credential fields shown while editing an account, keyed by the provider's
	// env-var names (e.g. CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_KEY). All are
	// optional but must be filled together — blank across the board keeps the
	// stored secret. Custom providers fall back to a single 'API Key' field.
	let ocRenameEnvNames = $state<string[]>([]);
	let ocRenameEnvValues = $state<Record<string, string>>({});
	// Valid when the credential fields are either all blank or all filled.
	const ocRenameCredentialComplete = $derived.by(() => {
		const vals = ocRenameEnvNames.map(n => (ocRenameEnvValues[n] ?? '').trim());
		return vals.every(v => !v) || vals.every(v => v);
	});
	let ocAddingAccountForProvider = $state<number | null>(null);
	let ocNewAccountName = $state('');
	let ocNewAccountApiKey = $state('');
	let ocNewAccountOptions = $state<Record<string, string>>({});

	// Delete confirmation
	let ocDeleteDialogOpen = $state(false);
	let ocDeleteTargetType = $state<'provider' | 'account'>('provider');
	let ocDeleteTargetId = $state<number | null>(null);
	let ocDeleteTargetName = $state('');

	// Server restart
	let ocRestarting = $state(false);
	let ocRestartConfirmOpen = $state(false);
	let ocRestartActiveChats = $state(0);

	// Filtered catalog (exclude already-configured providers)
	const ocFilteredCatalog = $derived.by(() => {
		const configuredIds = new Set(ocProviders.map(p => p.slug));
		let filtered = ocCatalog.filter(c => !configuredIds.has(c.id));
		if (ocCatalogSearch.trim()) {
			const q = ocCatalogSearch.toLowerCase();
			filtered = filtered.filter(c =>
				c.name.toLowerCase().includes(q) ||
				c.id.toLowerCase().includes(q)
			);
		}
		return filtered;
	});

	// ── Row-based model helpers ──

	function modelRowsToOptions(rows: OcModelRow[]): string {
		const modelIds: string[] = [];
		const modelNames: Record<string, string> = {};
		const hiddenModels: string[] = [];
		const modelLimits: Record<string, { context: number; output: number }> = {};
		for (const row of rows) {
			const code = row.code.trim();
			if (!code) continue;
			modelIds.push(code);
			const alias = row.alias.trim();
			if (alias) modelNames[code] = alias;
			if (row.hidden) hiddenModels.push(code);
			// Store a per-model limit only when the user set at least one value.
			if (row.context || row.output) {
				modelLimits[code] = { context: row.context || 128000, output: row.output || 16384 };
			}
		}
		return JSON.stringify({
			models: modelIds,
			modelNames: Object.keys(modelNames).length > 0 ? modelNames : undefined,
			hiddenModels: hiddenModels.length > 0 ? hiddenModels : undefined,
			modelLimits: Object.keys(modelLimits).length > 0 ? modelLimits : undefined,
		});
	}

	// ── Custom Provider CRUD ──

	function startAddProvider() {
		ocAddStep = 'picking';
		ocAddError = '';
		ocCatalogSearch = '';
		ocSelectedCatalogProvider = null;
		ocAddAccountName = '';
		ocAddApiKey = '';
		ocAddOptions = {};
		ocCustomName = '';
		ocCustomSlug = '';
		ocCustomBaseUrl = '';
		ocCustomApiKey = '';
		ocCustomModelRows = [];
		ocCustomFetching = false;
	}

	function startCustomProvider() {
		ocAddStep = 'custom';
		ocAddError = '';
		ocCustomName = '';
		ocCustomSlug = '';
		ocCustomBaseUrl = '';
		ocCustomApiKey = '';
		ocCustomModelRows = [{ code: '', alias: '', hidden: false, context: null, output: null }];
		ocCustomFetching = false;
	}

	function autoGenerateSlug(name: string): string {
		return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
	}

	function addCustomModelRow() {
		ocCustomModelRows = [...ocCustomModelRows, { code: '', alias: '', hidden: false, context: null, output: null }];
	}

	function removeCustomModelRow(index: number) {
		ocCustomModelRows = ocCustomModelRows.filter((_, i) => i !== index);
	}

	async function fetchCustomModels() {
		if (!ocCustomBaseUrl.trim()) return;
		ocCustomFetching = true;
		ocAddError = '';
		try {
			const baseUrl = ocCustomBaseUrl.trim().replace(/\/+$/, '');
			const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = await res.json() as { data?: { id: string }[] };
			const ids = (body.data || []).map(m => m.id);
			if (ids.length === 0) throw new Error('No models returned');
			ocCustomModelRows = ids.map(id => ({ code: id, alias: '', hidden: false, context: null, output: null }));
		} catch (err: any) {
			ocAddError = `Failed to fetch models: ${err?.message || 'unknown error'}`;
		} finally {
			ocCustomFetching = false;
		}
	}

	function isCustomProviderValid(): boolean {
		return !!ocCustomName.trim() && !!ocCustomSlug.trim() && !!ocCustomBaseUrl.trim() && ocCustomModelRows.some(r => r.code.trim());
	}

	async function submitCustomProvider() {
		if (!isCustomProviderValid()) return;
		ocAddStep = 'saving';
		ocAddError = '';
		try {
			const options = modelRowsToOptions(ocCustomModelRows);
			await opencodeProvidersStore.addProvider({
				slug: ocCustomSlug.trim(),
				name: ocCustomName.trim(),
				npm: '@ai-sdk/openai-compatible',
				apiUrl: ocCustomBaseUrl.trim().replace(/\/+$/, ''),
				options,
				accountName: ocCustomApiKey.trim() ? `${ocCustomName.trim()} key` : `${ocCustomName.trim()} (no key)`,
				credential: ocCustomApiKey.trim() || '',
			});
			ocAddStep = 'success';
		} catch (error: any) {
			ocAddError = error?.message || 'Failed to add custom provider';
			ocAddStep = 'error';
		}
	}

	// ── Edit Custom Provider ──

	function startEditCustomProvider(provider: OpenCodeProviderItem) {
		ocEditingProviderId = provider.id;
		ocEditName = provider.name;
		ocEditSlug = provider.slug;
		ocEditBaseUrl = provider.apiUrl || '';
		const opts = JSON.parse(provider.options || '{}') as {
			models?: string[];
			modelNames?: Record<string, string>;
			hiddenModels?: string[];
			modelLimits?: Record<string, { context?: number; output?: number }>;
			contextLimit?: number;
			outputLimit?: number;
		};
		const hiddenSet = new Set(opts.hiddenModels || []);
		// Seed each row from its per-model limit, falling back to a legacy
		// provider-level limit (older data) so nothing is silently dropped.
		ocEditModelRows = (opts.models || []).map(id => ({
			code: id,
			alias: opts.modelNames?.[id] || '',
			hidden: hiddenSet.has(id),
			context: opts.modelLimits?.[id]?.context ?? opts.contextLimit ?? null,
			output: opts.modelLimits?.[id]?.output ?? opts.outputLimit ?? null,
		}));
		if (ocEditModelRows.length === 0 && provider.apiUrl) {
			fetchEditModels();
		}
	}

	function cancelEditCustomProvider() {
		ocEditingProviderId = null;
	}

	function addEditModelRow() {
		ocEditModelRows = [...ocEditModelRows, { code: '', alias: '', hidden: false, context: null, output: null }];
	}

	function removeEditModelRow(index: number) {
		ocEditModelRows = ocEditModelRows.filter((_, i) => i !== index);
	}

	async function fetchEditModels() {
		if (!ocEditingProviderId || !ocEditBaseUrl.trim()) return;
		ocEditFetching = true;
		try {
			const result = await ws.http('engine:opencode-provider-fetch-models', {
				id: ocEditingProviderId,
			}) as { models: { id: string; name?: string }[] };
			if (result.models.length === 0) throw new Error('No models returned');
			ocEditModelRows = result.models.map(m => ({ code: m.id, alias: '', hidden: false, context: null, output: null }));
		} catch {
			// silent — user can type manually
		} finally {
			ocEditFetching = false;
		}
	}

	async function submitEditCustomProvider() {
		if (!ocEditingProviderId || !ocEditName.trim() || !ocEditSlug.trim() || !ocEditBaseUrl.trim()) return;
		const options = modelRowsToOptions(ocEditModelRows);
		try {
			await opencodeProvidersStore.updateProvider(ocEditingProviderId, {
				slug: ocEditSlug.trim(),
				name: ocEditName.trim(),
				apiUrl: ocEditBaseUrl.trim().replace(/\/+$/, ''),
				options,
			});
			ocEditingProviderId = null;
		} catch (error: any) {
			debug.error('settings', 'Failed to update custom provider:', error);
		}
	}

	function selectCatalogProvider(provider: ModelsDevProviderItem) {
		ocSelectedCatalogProvider = provider;
		ocAddAccountName = '';
		ocAddApiKey = '';
		ocAddOptions = {};
		ocAddStep = 'configuring';
	}

	function isAddProviderValid(): boolean {
		if (!ocSelectedCatalogProvider || !ocAddAccountName.trim() || !ocAddApiKey.trim()) return false;
		// Check all additional env vars are filled
		for (const envVar of ocSelectedCatalogProvider.env.slice(1)) {
			if (!ocAddOptions[envVar]?.trim()) return false;
		}
		return true;
	}

	async function submitAddProvider() {
		if (!isAddProviderValid() || !ocSelectedCatalogProvider) return;

		ocAddStep = 'saving';
		ocAddError = '';
		try {
			const envNames = ocSelectedCatalogProvider.env;
			const credential = buildAccountCredential(envNames, ocAddApiKey.trim(), ocAddOptions);

			await opencodeProvidersStore.addProvider({
				slug: ocSelectedCatalogProvider.id,
				name: ocSelectedCatalogProvider.name,
				npm: ocSelectedCatalogProvider.npm,
				apiUrl: ocSelectedCatalogProvider.api || undefined,
				accountName: ocAddAccountName.trim(),
				credential,
			});
			ocAddStep = 'success';
		} catch (error: any) {
			ocAddError = error?.message || 'Failed to add provider';
			ocAddStep = 'error';
		}
	}

	// Build the credential string sent to the backend.
	// - Single-env providers store the raw secret (legacy compat).
	// - Multi-env providers store every secret as a JSON object so each
	//   account has its own complete credential bundle.
	function buildAccountCredential(envNames: string[], primary: string, extras: Record<string, string>): string {
		if (envNames.length <= 1) return primary;
		const bundle: Record<string, string> = { [envNames[0]]: primary };
		for (const envName of envNames.slice(1)) {
			const value = (extras[envName] ?? '').trim();
			if (value) bundle[envName] = value;
		}
		return JSON.stringify(bundle);
	}

	function cancelAddProvider() {
		ocAddStep = 'idle';
		ocSelectedCatalogProvider = null;
	}

	async function handleRefetchCatalog() {
		ocCatalogRefreshing = true;
		try {
			await opencodeProvidersStore.refetchCatalog();
		} finally {
			ocCatalogRefreshing = false;
		}
	}

	// Account CRUD within a provider
	function startAddAccount(providerDbId: number) {
		ocAddingAccountForProvider = providerDbId;
		ocNewAccountName = '';
		ocNewAccountApiKey = '';
		ocNewAccountOptions = {};
	}

	function getProviderEnvNames(slug: string): string[] {
		return ocCatalog.find(c => c.id === slug)?.env || [];
	}

	function isAddAccountValid(): boolean {
		if (ocAddingAccountForProvider === null) return false;
		if (!ocNewAccountName.trim() || !ocNewAccountApiKey.trim()) return false;
		const provider = ocProviders.find(p => p.id === ocAddingAccountForProvider);
		if (!provider) return false;
		for (const envName of getProviderEnvNames(provider.slug).slice(1)) {
			if (!ocNewAccountOptions[envName]?.trim()) return false;
		}
		return true;
	}

	async function submitAddAccount() {
		if (!isAddAccountValid() || ocAddingAccountForProvider === null) return;
		const provider = ocProviders.find(p => p.id === ocAddingAccountForProvider);
		if (!provider) return;
		const envNames = getProviderEnvNames(provider.slug);
		try {
			const credential = buildAccountCredential(envNames, ocNewAccountApiKey.trim(), ocNewAccountOptions);
			await opencodeProvidersStore.addAccount(ocAddingAccountForProvider, ocNewAccountName.trim(), credential);
			ocAddingAccountForProvider = null;
		} catch {
			// Ignore
		}
	}

	function cancelAddAccount() {
		ocAddingAccountForProvider = null;
		ocNewAccountOptions = {};
	}

	async function switchOCAccount(accountId: number) {
		await opencodeProvidersStore.switchAccount(accountId);
	}

	function startOCRename(account: OpenCodeAccountItem, provider: OpenCodeProviderItem) {
		ocRenamingAccountId = account.id;
		ocRenameValue = account.name;
		// Catalog providers expose their real env-var names; custom (api_url-only)
		// providers have none, so present a single generic API key field.
		const envNames = getProviderEnvNames(provider.slug);
		ocRenameEnvNames = envNames.length > 0 ? envNames : ['API Key'];
		ocRenameEnvValues = {};
	}

	async function submitOCRename() {
		if (ocRenamingAccountId === null || !ocRenameValue.trim() || !ocRenameCredentialComplete) return;
		const accountId = ocRenamingAccountId;
		await opencodeProvidersStore.renameAccount(accountId, ocRenameValue.trim());
		// Update credentials only when every field is filled; all-blank keeps the
		// stored secret. buildAccountCredential returns a raw string for a single
		// field (custom providers) or a JSON bundle for multi-secret providers.
		const values = ocRenameEnvNames.map(n => (ocRenameEnvValues[n] ?? '').trim());
		if (values.length > 0 && values.every(v => v)) {
			const primary = (ocRenameEnvValues[ocRenameEnvNames[0]] ?? '').trim();
			const credential = buildAccountCredential(ocRenameEnvNames, primary, ocRenameEnvValues);
			await opencodeProvidersStore.updateAccountCredential(accountId, credential);
		}
		ocRenamingAccountId = null;
		ocRenameValue = '';
		ocRenameEnvValues = {};
	}

	function cancelOCRename() {
		ocRenamingAccountId = null;
		ocRenameValue = '';
		ocRenameEnvValues = {};
	}

	function confirmDeleteOCProvider(provider: OpenCodeProviderItem) {
		ocDeleteTargetType = 'provider';
		ocDeleteTargetId = provider.id;
		ocDeleteTargetName = provider.name;
		ocDeleteDialogOpen = true;
	}

	function confirmDeleteOCAccount(accountId: number, accountName: string) {
		ocDeleteTargetType = 'account';
		ocDeleteTargetId = accountId;
		ocDeleteTargetName = accountName;
		ocDeleteDialogOpen = true;
	}

	async function executeOCDelete() {
		if (ocDeleteTargetId === null) return;
		if (ocDeleteTargetType === 'provider') {
			await opencodeProvidersStore.removeProvider(ocDeleteTargetId);
		} else {
			await opencodeProvidersStore.deleteAccount(ocDeleteTargetId);
		}
	}

	// Server restart
	async function handleRestartServer() {
		ocRestarting = true;
		try {
			const result = await opencodeProvidersStore.restartServer(false);
			if (result.needsConfirmation) {
				ocRestartActiveChats = result.activeChats || 0;
				ocRestartConfirmOpen = true;
				return;
			}
			if (result.success) {
				await modelStore.refreshModels('opencode');
				showSuccess('Server Restarted', 'OpenCode server restarted successfully. Models refreshed.');
			}
		} catch {
			// Ignore
		} finally {
			ocRestarting = false;
		}
	}

	async function forceRestartServer() {
		ocRestarting = true;
		ocRestartConfirmOpen = false;
		try {
			await opencodeProvidersStore.restartServer(true);
			await modelStore.refreshModels('opencode');
			showSuccess('Server Restarted', 'OpenCode server force-restarted. Models refreshed.');
		} catch {
			// Ignore
		} finally {
			ocRestarting = false;
		}
	}

	function openSystemToolsSection() {
		setActiveSection('system-tools');
	}
</script>

<!-- OpenCode Card -->
<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
	<!-- Card Header -->
	<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
		<div class="flex items-center gap-3">
			<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
				{@html isDarkMode() ? openCodeEngine.icon.dark : openCodeEngine.icon.light}
			</div>
			<div>
				<h3 class="font-semibold text-slate-900 dark:text-slate-100">{openCodeEngine.name}</h3>
				<p class="text-xs text-slate-500 dark:text-slate-400">{openCodeEngine.description}</p>
			</div>
		</div>
		{#if openCodeStatus?.installed}
			<button
				type="button"
				class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
					text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50
					hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={handleRestartServer}
				disabled={ocRestarting}
			>
				<Icon name={ocRestarting ? 'lucide:loader' : 'lucide:rotate-cw'} class="w-3.5 h-3.5 {ocRestarting ? 'animate-spin' : ''}" />
				{ocRestarting ? 'Restarting...' : 'Restart Server'}
			</button>
		{/if}
	</div>

	<!-- Card Body -->
	<div class="px-5 py-4">
		{#if isLoadingOpenCodeStatus}
			<div class="flex items-center justify-center py-8">
				<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
			</div>
		{:else if openCodeStatus && !openCodeStatus.installed}
			<!-- Redirect to System Tools -->
			<div class="flex items-start gap-3 p-4 rounded-lg bg-violet-50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800/50">
				<Icon name="lucide:hammer" class="w-5 h-5 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
				<div class="flex-1 space-y-2">
					<div>
						<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">OpenCode is not installed</p>
						<p class="text-xs text-slate-600 dark:text-slate-400">Install it from the System Tools section. You can return here once it's installed to configure providers.</p>
					</div>
					<button
						type="button"
						class="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors"
						onclick={openSystemToolsSection}
					>
						<Icon name="lucide:arrow-right" class="w-3.5 h-3.5" />
						Open System Tools
					</button>
				</div>
			</div>
		{:else if openCodeStatus}
			<!-- Installed View -->
			<div class="space-y-5">
				<!-- Configured Providers -->
				<div class="space-y-3">
					<div class="flex items-center justify-between">
						<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Providers</h4>
						<span class="text-xs text-slate-500">{ocProviders.length + 1} provider{ocProviders.length !== 0 ? 's' : ''}</span>
					</div>

					<!-- Built-in Opencode Free provider (always shown, not configurable) -->
					<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
						<div class="flex items-center justify-between px-3.5 py-2.5">
							<div class="flex items-center gap-2 min-w-0">
								<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">Opencode</span>
								<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">Free</span>
								<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
							</div>
						</div>
					</div>

					<!-- Catalog Providers (no api_url) -->
					{#if ocCatalogProviders.length > 0}
						<div class="flex items-center gap-2 mt-4 mb-2">
							<h5 class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Catalog</h5>
							<div class="flex-1 h-px bg-slate-200 dark:bg-slate-700/50"></div>
						</div>
						{#each ocCatalogProviders as provider (provider.id)}
							<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
								<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
									<div class="flex items-center gap-2 min-w-0">
										<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{provider.name}</span>
										<span class="text-2xs text-slate-400">{provider.slug}</span>
										{#if !provider.isEnabled}
											<span class="px-1.5 py-0.5 text-3xs rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">Disabled</span>
										{/if}
									</div>
									<div class="flex items-center gap-1">
										<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteOCProvider(provider)} title="Remove provider">
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									</div>
								</div>
								<div class="px-3.5 py-2.5 space-y-2">
									{#if provider.accounts.length === 0}
										<p class="text-xs text-slate-500 italic">No accounts</p>
									{:else}
										{#each provider.accounts as account (account.id)}
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
															<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchOCAccount(account.id)} title="Switch to this account"><Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" /></button>
														{/if}
														<button type="button" class="flex p-1.5 rounded-md {ocRenamingAccountId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => ocRenamingAccountId === account.id ? cancelOCRename() : startOCRename(account, provider)} title="Edit account"><Icon name="lucide:pencil" class="w-3.5 h-3.5" /></button>
														<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteOCAccount(account.id, account.name)} title="Delete account"><Icon name="lucide:trash-2" class="w-3.5 h-3.5" /></button>
													</div>
												</div>
												{#if ocRenamingAccountId === account.id}
													<AccountEditForm onSave={submitOCRename} onCancel={cancelOCRename} saveDisabled={!ocRenameValue.trim() || !ocRenameCredentialComplete}>
														<AccountField label="Account name" bind:value={ocRenameValue} />
														{#each ocRenameEnvNames as envName (envName)}
															<AccountField label={envName} secret={/key|token|secret/i.test(envName)} hint="(leave blank to keep)" bind:value={ocRenameEnvValues[envName]} />
														{/each}
													</AccountEditForm>
												{/if}
											</div>
										{/each}
									{/if}
									{#if ocAddingAccountForProvider === provider.id}
										{@const envNames = getProviderEnvNames(provider.slug)}
										{@const primaryEnv = envNames[0] || 'API Key'}
										<div class="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-700/50">
											<input type="text" bind:value={ocNewAccountName} placeholder="Account name (e.g. Personal, Work)" class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
											<input type="text" bind:value={ocNewAccountApiKey} placeholder={`Enter ${primaryEnv}`} class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
											{#each envNames.slice(1) as envVar (envVar)}
												<input type="text" value={ocNewAccountOptions[envVar] || ''} oninput={(e) => { ocNewAccountOptions = { ...ocNewAccountOptions, [envVar]: (e.target as HTMLInputElement).value }; }} placeholder={`Enter ${envVar}`} class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
											{/each}
											<div class="flex gap-2">
												<button type="button" class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50" onclick={submitAddAccount} disabled={!isAddAccountValid()}><Icon name="lucide:plus" class="w-3 h-3" />Add</button>
												<button type="button" class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelAddAccount}>Cancel</button>
											</div>
										</div>
									{:else}
										<button type="button" class="flex items-center gap-1.5 text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 transition-colors mt-1" onclick={() => startAddAccount(provider.id)}>
											<Icon name="lucide:plus" class="w-3 h-3" />Add account
										</button>
									{/if}
								</div>
							</div>
						{/each}
					{/if}

					<!-- Custom Providers (with api_url) -->
					{#if ocCustomProviders.length > 0}
						<div class="flex items-center gap-2 mt-4 mb-2">
							<h5 class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Custom</h5>
							<div class="flex-1 h-px bg-slate-200 dark:bg-slate-700/50"></div>
						</div>
						{#each ocCustomProviders as provider (provider.id)}
							<!-- Custom Provider card -->
								<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
									<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
										<div class="flex items-center gap-2 min-w-0">
											<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{provider.name}</span>
											<span class="inline-flex items-center px-1.5 py-0.5 rounded text-3xs font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">Custom</span>
											<span class="text-2xs text-slate-400">{provider.slug}</span>
											{#if !provider.isEnabled}
												<span class="px-1.5 py-0.5 text-3xs rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">Disabled</span>
											{/if}
										</div>
										<div class="flex items-center gap-1">
											<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" onclick={() => startEditCustomProvider(provider)} title="Edit provider">
												<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
											</button>
											<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteOCProvider(provider)} title="Remove provider">
												<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
											</button>
										</div>
									</div>
									<div class="px-3.5 py-2.5 space-y-2">
										{#if provider.accounts.length === 0}
											<p class="text-xs text-slate-500 italic">No accounts</p>
										{:else}
											{#each provider.accounts as account (account.id)}
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
																<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchOCAccount(account.id)} title="Switch to this account"><Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" /></button>
															{/if}
															<button type="button" class="flex p-1.5 rounded-md {ocRenamingAccountId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => ocRenamingAccountId === account.id ? cancelOCRename() : startOCRename(account, provider)} title="Edit account"><Icon name="lucide:pencil" class="w-3.5 h-3.5" /></button>
															<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteOCAccount(account.id, account.name)} title="Delete account"><Icon name="lucide:trash-2" class="w-3.5 h-3.5" /></button>
														</div>
													</div>
													{#if ocRenamingAccountId === account.id}
														<AccountEditForm onSave={submitOCRename} onCancel={cancelOCRename} saveDisabled={!ocRenameValue.trim() || !ocRenameCredentialComplete}>
															<AccountField label="Account name" bind:value={ocRenameValue} />
															{#each ocRenameEnvNames as envName (envName)}
																<AccountField label={envName} secret={/key|token|secret/i.test(envName)} hint="(leave blank to keep)" bind:value={ocRenameEnvValues[envName]} />
															{/each}
														</AccountEditForm>
													{/if}
												</div>
											{/each}
										{/if}
										{#if ocAddingAccountForProvider === provider.id}
											{@const envNames = getProviderEnvNames(provider.slug)}
											{@const primaryEnv = envNames[0] || 'API Key'}
											<div class="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-700/50">
												<input type="text" bind:value={ocNewAccountName} placeholder="Account name (e.g. Personal, Work)" class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
												<input type="text" bind:value={ocNewAccountApiKey} placeholder={`Enter ${primaryEnv}`} class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
												{#each envNames.slice(1) as envVar (envVar)}
													<input type="text" value={ocNewAccountOptions[envVar] || ''} oninput={(e) => { ocNewAccountOptions = { ...ocNewAccountOptions, [envVar]: (e.target as HTMLInputElement).value }; }} placeholder={`Enter ${envVar}`} class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
												{/each}
												<div class="flex gap-2">
													<button type="button" class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50" onclick={submitAddAccount} disabled={!isAddAccountValid()}><Icon name="lucide:plus" class="w-3 h-3" />Add</button>
													<button type="button" class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelAddAccount}>Cancel</button>
												</div>
											</div>
										{:else}
											<button type="button" class="flex items-center gap-1.5 text-xs text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 transition-colors mt-1" onclick={() => startAddAccount(provider.id)}>
												<Icon name="lucide:plus" class="w-3 h-3" />Add account
											</button>
										{/if}
									</div>
								</div>
							{/each}
						{/if}

					<!-- Add Provider Flow -->
					<div class="mt-3">
						{#if ocAddStep === 'idle'}
							<button
								type="button"
								class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center"
								onclick={startAddProvider}
							>
								<Icon name="lucide:plus" class="w-4 h-4" />
								Add Provider
							</button>
						{:else if ocAddStep === 'picking'}
							<!-- Provider Picker -->
							<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
										<Icon name="lucide:search" class="w-3.5 h-3.5" />
										Select a provider
									</div>
									<button
										type="button"
										class="flex items-center gap-1 text-2xs font-medium px-2 py-1 rounded-md border border-violet-300 dark:border-violet-700/60 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors disabled:opacity-50"
										onclick={handleRefetchCatalog}
										disabled={ocCatalogRefreshing}
									>
										<Icon name={ocCatalogRefreshing ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3 h-3 {ocCatalogRefreshing ? 'animate-spin' : ''}" />
										{ocCatalogRefreshing ? 'Fetching...' : 'Re-fetch catalog'}
									</button>
								</div>

								<input
									type="text"
									bind:value={ocCatalogSearch}
									placeholder="Search providers..."
									class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
								/>

								<div class="max-h-48 overflow-y-auto space-y-1">
									{#if ocFilteredCatalog.length === 0}
										<p class="text-xs text-slate-500 text-center py-2">{ocCatalogSearch ? 'No matching providers' : 'No providers available'}</p>
									{:else}
										{#each ocFilteredCatalog as cp (cp.id)}
											<button
												type="button"
												class="flex items-center justify-between w-full px-3 py-2 text-left rounded-lg hover:bg-violet-100/50 dark:hover:bg-violet-900/20 transition-colors"
												onclick={() => selectCatalogProvider(cp)}
											>
												<div>
													<span class="text-sm font-medium text-slate-900 dark:text-slate-100">{cp.name}</span>
													<span class="text-2xs text-slate-400 ml-2">{cp.id}</span>
												</div>
												<Icon name="lucide:chevron-right" class="w-3.5 h-3.5 text-slate-400" />
											</button>
										{/each}
									{/if}
								</div>

								<div class="relative my-2">
									<div class="absolute inset-0 flex items-center">
										<div class="w-full border-t border-slate-200 dark:border-slate-700"></div>
									</div>
									<div class="relative flex justify-center">
										<span class="px-2 text-2xs text-slate-400 bg-violet-50/50 dark:bg-violet-900/10">or</span>
									</div>
								</div>
								<button type="button" class="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors" onclick={startCustomProvider}>
									<Icon name="lucide:wand" class="w-3.5 h-3.5" />
									Custom Provider
								</button>
								<button type="button" class="w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelAddProvider}>Cancel</button>
							</div>
						{:else if ocAddStep === 'configuring' && ocSelectedCatalogProvider}
							<!-- Configure Provider + First Account -->
							<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
								<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
									<Icon name="lucide:settings" class="w-3.5 h-3.5" />
									Configure {ocSelectedCatalogProvider.name}
								</div>

																	<!-- Account name -->
								<div>
									<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Account name</label>
									<input type="text" bind:value={ocAddAccountName} placeholder="e.g. Personal, Work" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>

								<!-- API Key with env var label -->
								<div>
									<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
										{ocSelectedCatalogProvider.env.length > 0 ? ocSelectedCatalogProvider.env[0] : 'API Key'}
									</label>
									<input type="text" bind:value={ocAddApiKey} placeholder={`Enter ${ocSelectedCatalogProvider.env.length > 0 ? ocSelectedCatalogProvider.env[0] : 'API Key'}`} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
								</div>

								<!-- Additional env vars (if provider has more than 1) -->
								{#each ocSelectedCatalogProvider.env.slice(1) as envVar (envVar)}
									<div>
										<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">{envVar}</label>
										<input
											type="text"
											value={ocAddOptions[envVar] || ''}
											oninput={(e) => { ocAddOptions = { ...ocAddOptions, [envVar]: (e.target as HTMLInputElement).value }; }}
											placeholder={`Enter ${envVar}`}
											class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
										/>
									</div>
								{/each}

								<div class="flex gap-2">
									<button
										type="button"
										class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
										onclick={submitAddProvider}
										disabled={!isAddProviderValid()}
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
										Add Provider
									</button>
									<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={() => { ocAddStep = 'picking'; }}>Back</button>
								</div>
							</div>
						{:else if ocAddStep === 'custom'}
							<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
								<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
									<Icon name="lucide:wand" class="w-3.5 h-3.5" />
									Custom Provider
								</div>
								<p class="text-2xs text-slate-500 dark:text-slate-400">Add any OpenAI-compatible API endpoint as a provider.</p>

								<div>
									<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Name</label>
									<input
										type="text"
										bind:value={ocCustomName}
										oninput={() => { ocCustomSlug = autoGenerateSlug(ocCustomName); }}
										placeholder="e.g. Ollama (local), 9router"
										class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
									/>
								</div>

								<div>
									<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Provider ID (slug)</label>
									<input
										type="text"
										bind:value={ocCustomSlug}
										placeholder="e.g. ollama, 9router"
										class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
									/>
								</div>

								<div>
									<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Base URL</label>
									<input
										type="text"
										bind:value={ocCustomBaseUrl}
										placeholder="e.g. http://localhost:11434/v1 (Ollama) · http://localhost:20128/v1 (9router)"
										class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
									/>
								</div>

								<div>
									<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">API Key <span class="text-slate-400 font-normal">(optional)</span></label>
									<input
										type="text"
										bind:value={ocCustomApiKey}
										placeholder="Leave blank for Ollama; sk-… for 9router"
										class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
									/>
								</div>


								<div>
									<div class="flex items-center justify-between mb-1">
										<label class="block text-xs font-medium text-slate-700 dark:text-slate-300">Model IDs</label>
										<div class="flex items-center gap-2">
											<button type="button" class="flex items-center gap-1 text-2xs font-medium px-2 py-1 rounded-md border border-violet-300 dark:border-violet-700/60 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors disabled:opacity-50" onclick={fetchCustomModels} disabled={ocCustomFetching || !ocCustomBaseUrl.trim()}>
												<Icon name={ocCustomFetching ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3 h-3 {ocCustomFetching ? 'animate-spin' : ''}" />
												{ocCustomFetching ? 'Fetching...' : 'Fetch from /v1/models'}
											</button>
											<button type="button" class="flex items-center gap-1 text-3xs text-violet-600 hover:text-violet-700 transition-colors" onclick={addCustomModelRow}>
												<Icon name="lucide:plus" class="w-3 h-3" />Add row
											</button>
										</div>
									</div>
										<div class="space-y-1.5 max-h-48 overflow-y-auto p-0.5">
											{#each ocCustomModelRows as row, i (i)}
												<div
													draggable="true"
													class="flex items-center gap-2 {row.hidden ? 'opacity-40' : ''} {ocDragIndex === i ? 'opacity-50' : ''} {ocDragIndex !== null && ocDragIndex !== i ? 'hover:cursor-grab' : ''}"
													ondragstart={(e) => { ocDragIndex = i; e.dataTransfer!.effectAllowed = 'move'; }}
													ondragover={(e) => e.preventDefault()}
													ondrop={(e) => { e.preventDefault(); if (ocDragIndex !== null && ocDragIndex !== i) { const a = [...ocCustomModelRows]; const [m] = a.splice(ocDragIndex, 1); a.splice(i, 0, m); ocCustomModelRows = a; } ocDragIndex = null; }}
													ondragend={() => { ocDragIndex = null; }}
												>
													<Icon name="lucide:grip-vertical" class="w-3.5 h-3.5 text-slate-400 cursor-grab active:cursor-grabbing shrink-0" />
													<input
														type="text"
														bind:value={row.code}
														placeholder="model-id"
														class="flex-[3] px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
													/>
													<input
														type="text"
														bind:value={row.alias}
														placeholder="Alias"
														class="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
													/>
														<input type="number" bind:value={row.context} placeholder="ctx" title="Context limit" class="w-20 px-1.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 shrink-0" />
														<input type="number" bind:value={row.output} placeholder="out" title="Output limit" class="w-20 px-1.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 shrink-0" />
													<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors shrink-0" onclick={() => { row.hidden = !row.hidden; }} title={row.hidden ? 'Show' : 'Hide'}>
														<Icon name={row.hidden ? 'lucide:eye-off' : 'lucide:eye'} class="w-3.5 h-3.5" />
													</button>
													<button type="button" class="flex p-1 rounded-md {settings.pinnedModels?.includes(row.code) ? 'text-amber-500 hover:text-amber-600' : 'text-slate-400 hover:text-amber-600'} hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors shrink-0" onclick={() => togglePinnedModel(row.code)} title={settings.pinnedModels?.includes(row.code) ? 'Unpin' : 'Pin'}>
														<Icon name={settings.pinnedModels?.includes(row.code) ? 'lucide:pin-off' : 'lucide:pin'} class="w-3.5 h-3.5" />
													</button>
													<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0" onclick={() => removeCustomModelRow(i)}>
														<Icon name="lucide:x" class="w-3.5 h-3.5" />
													</button>
												</div>
											{/each}
										{#if ocCustomModelRows.length === 0}
											<p class="text-xs text-slate-400 italic text-center py-2">No models. Click <strong>Add row</strong> or <strong>Fetch</strong>.</p>
										{/if}
									</div>
								</div>

								{#if ocAddError}
									<div class="flex items-center gap-2 p-2 rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
										<Icon name="lucide:circle-alert" class="w-4 h-4 shrink-0 text-red-600 dark:text-red-400" />
										<span class="text-xs text-red-700 dark:text-red-300">{ocAddError}</span>
									</div>
								{/if}

								<div class="flex gap-2">
									<button
										type="button"
										class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
										onclick={submitCustomProvider}
										disabled={!isCustomProviderValid()}
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
										Add Provider
									</button>
									<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={() => { ocAddStep = 'picking'; }}>Back</button>
								</div>
							</div>
						{:else if ocAddStep === 'saving'}
							<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
								<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
									<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
									<span>Adding provider...</span>
								</div>
							</div>
						{:else if ocAddStep === 'success'}
							<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
								<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
								<span class="text-sm text-green-700 dark:text-green-300">Provider added! Restart the server to apply.</span>
								<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={() => { ocAddStep = 'idle'; }}>Dismiss</button>
							</div>
						{:else if ocAddStep === 'error'}
							<div class="space-y-2">
								<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
									<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
									<span class="text-sm text-red-700 dark:text-red-300">{ocAddError}</span>
								</div>
								<button type="button" class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onclick={() => { ocAddStep = 'configuring'; }}>
									<Icon name="lucide:rotate-ccw" class="w-4 h-4" />Try Again
								</button>
							</div>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>

<!-- Edit Provider modal (shared by catalog + custom providers) -->
<Dialog isOpen={ocEditingProviderId !== null} onClose={cancelEditCustomProvider} title="Edit Provider">
	<div class="space-y-3">
		<div class="flex items-center gap-2 text-sm font-semibold text-violet-600 dark:text-violet-400">
			<Icon name="lucide:pencil" class="w-4 h-4" />
			Edit Provider — {ocEditName}
		</div>

		<div>
			<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Name</label>
			<input type="text" bind:value={ocEditName} placeholder="Provider name" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
		</div>
		<div>
			<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Provider ID (slug)</label>
			<input type="text" bind:value={ocEditSlug} placeholder="e.g. ollama, 9router" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
			<p class="text-3xs text-slate-400 mt-1">Changing the slug rewrites this provider's identity — restart the server afterwards.</p>
		</div>
		<div>
			<label class="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Base URL</label>
			<input type="text" bind:value={ocEditBaseUrl} placeholder="http://localhost:11434/v1 (Ollama) · http://localhost:20128/v1 (9router)" class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
		</div>

		<div>
			<div class="flex items-center justify-between mb-1">
				<label class="block text-xs font-medium text-slate-700 dark:text-slate-300">Model IDs</label>
				<div class="flex items-center gap-2">
					<button type="button" class="flex items-center gap-1 text-2xs font-medium px-2 py-1 rounded-md border border-violet-300 dark:border-violet-700/60 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors disabled:opacity-50" onclick={fetchEditModels} disabled={ocEditFetching || !ocEditBaseUrl.trim()}>
						<Icon name={ocEditFetching ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3 h-3 {ocEditFetching ? 'animate-spin' : ''}" />
						{ocEditFetching ? 'Fetching...' : 'Fetch from /v1/models'}
					</button>
					<button type="button" class="flex items-center gap-1 text-3xs text-violet-600 hover:text-violet-700 transition-colors" onclick={addEditModelRow}>
						<Icon name="lucide:plus" class="w-3 h-3" />Add row
					</button>
				</div>
			</div>
			<div class="space-y-1.5 max-h-48 overflow-y-auto p-0.5">
				{#each ocEditModelRows as row, i (i)}
					<div
						draggable="true"
						class="flex items-center gap-2 {row.hidden ? 'opacity-40' : ''} {ocDragIndex === i ? 'opacity-50' : ''} {ocDragIndex !== null && ocDragIndex !== i ? 'hover:cursor-grab' : ''}"
						ondragstart={(e) => { ocDragIndex = i; e.dataTransfer!.effectAllowed = 'move'; }}
						ondragover={(e) => e.preventDefault()}
						ondrop={(e) => { e.preventDefault(); if (ocDragIndex !== null && ocDragIndex !== i) { const a = [...ocEditModelRows]; const [m] = a.splice(ocDragIndex, 1); a.splice(i, 0, m); ocEditModelRows = a; } ocDragIndex = null; }}
						ondragend={() => { ocDragIndex = null; }}
					>
						<Icon name="lucide:grip-vertical" class="w-3.5 h-3.5 text-slate-400 cursor-grab active:cursor-grabbing shrink-0" />
						<input type="text" bind:value={row.code} placeholder="model-id" class="flex-[3] px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
						<input type="text" bind:value={row.alias} placeholder="Alias" class="flex-1 px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
						<input type="number" bind:value={row.context} placeholder="ctx" title="Context limit" class="w-20 px-1.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 shrink-0" />
						<input type="number" bind:value={row.output} placeholder="out" title="Output limit" class="w-20 px-1.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 shrink-0" />
						<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors shrink-0" onclick={() => { row.hidden = !row.hidden; }} title={row.hidden ? 'Show' : 'Hide'}>
							<Icon name={row.hidden ? 'lucide:eye-off' : 'lucide:eye'} class="w-3.5 h-3.5" />
						</button>
						<button type="button" class="flex p-1 rounded-md {settings.pinnedModels?.includes(row.code) ? 'text-amber-500 hover:text-amber-600' : 'text-slate-400 hover:text-amber-600'} hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors shrink-0" onclick={() => togglePinnedModel(row.code)} title={settings.pinnedModels?.includes(row.code) ? 'Unpin' : 'Pin'}>
							<Icon name={settings.pinnedModels?.includes(row.code) ? 'lucide:pin-off' : 'lucide:pin'} class="w-3.5 h-3.5" />
						</button>
						<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0" onclick={() => removeEditModelRow(i)}>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/each}
				{#if ocEditModelRows.length === 0}
					<p class="text-xs text-slate-400 italic text-center py-2">No models. Click <strong>Add row</strong> or <strong>Fetch</strong>.</p>
				{/if}
			</div>
		</div>

		<div class="flex gap-2 pt-1">
			<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50" onclick={submitEditCustomProvider}>
				<Icon name="lucide:check" class="w-4 h-4" />
				Save Changes
			</button>
			<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelEditCustomProvider}>Cancel</button>
		</div>
	</div>
</Dialog>

<Dialog
	bind:isOpen={ocDeleteDialogOpen}
	onClose={() => { ocDeleteDialogOpen = false; ocDeleteTargetId = null; }}
	type="error"
	title="Delete {ocDeleteTargetType === 'provider' ? 'Provider' : 'Account'}"
	message="Are you sure you want to delete {ocDeleteTargetType === 'provider' ? 'provider' : 'account'} &quot;{ocDeleteTargetName}&quot;?{ocDeleteTargetType === 'provider' ? ' All accounts for this provider will also be removed.' : ''} This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={executeOCDelete}
/>

<Dialog
	bind:isOpen={ocRestartConfirmOpen}
	onClose={() => { ocRestartConfirmOpen = false; }}
	type="warning"
	title="Active Chats Detected"
	message="There {ocRestartActiveChats === 1 ? 'is' : 'are'} {ocRestartActiveChats} active chat{ocRestartActiveChats !== 1 ? 's' : ''} using the OpenCode engine. Restarting the server will force-stop all of them. Continue?"
	confirmText="Force Restart"
	cancelText="Cancel"
	onConfirm={forceRestartServer}
/>

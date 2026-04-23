<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { themeStore, toggleDarkMode, isDarkMode, initializeTheme } from '$frontend/stores/ui/theme.svelte';
	import { settings, updateSettings, applyFontSize } from '$frontend/stores/features/settings.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import { claudeAccountsStore, type ClaudeAccountItem } from '$frontend/stores/features/claude-accounts.svelte';
	import { opencodeProvidersStore, type ModelsDevProviderItem } from '$frontend/stores/features/opencode-providers.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import SystemToolsSettings from '$frontend/components/settings/system-tools/SystemToolsSettings.svelte';
	import ws from '$frontend/utils/ws';
	import type { AuthMode } from '$shared/types/stores/settings';
	import type { IconName } from '$shared/types/ui/icons';

	// Ensure theme is initialized (normally done in WorkspaceLayout which hasn't mounted yet)
	onMount(() => {
		initializeTheme();
	});

	// ─── Wizard state ───
	type WizardStep = 'auth-mode' | 'admin-account' | 'system-tools' | 'engines' | 'preferences';
	const ALL_STEPS: WizardStep[] = ['auth-mode', 'admin-account', 'system-tools', 'engines', 'preferences'];

	let currentStep = $state<WizardStep>('auth-mode');
	let completedSteps = $state<Set<WizardStep>>(new Set());
	let selectedAuthMode = $state<AuthMode>('none');

	// Whether this is a returning existing user (data exists, just re-onboarding)
	let isExistingUser = $state(false);
	let existingUserName = $state('');
	let initializedFromUser = $state(false);

	// Restore existing data once on load (not reactively on every adminName change)
	$effect(() => {
		if (authStore.currentUser && !initializedFromUser) {
			initializedFromUser = true;
			isExistingUser = true;
			existingUserName = authStore.currentUser.name;
			adminName = authStore.currentUser.name;
		}
	});

	// Sync auth mode from server only for existing users (re-onboarding);
	// on fresh setup, keep the default 'none' so "No Login" is pre-selected.
	$effect(() => {
		if (isExistingUser && authStore.authMode) {
			selectedAuthMode = authStore.authMode;
		}
	});

	function getVisibleSteps(): WizardStep[] {
		if (selectedAuthMode === 'none') {
			return ALL_STEPS.filter(s => s !== 'admin-account');
		}
		return [...ALL_STEPS];
	}

	const visibleSteps = $derived(getVisibleSteps());

	function goToNextStep() {
		completedSteps.add(currentStep);
		completedSteps = new Set(completedSteps);

		const visible = getVisibleSteps();
		const idx = visible.indexOf(currentStep);
		if (idx < visible.length - 1) {
			currentStep = visible[idx + 1];
		}
	}

	function goToPrevStep() {
		const visible = getVisibleSteps();
		const idx = visible.indexOf(currentStep);
		if (idx > 0) {
			const destIdx = idx - 1;
			// Clear destination and all forward steps from completed
			for (let i = destIdx; i < visible.length; i++) {
				completedSteps.delete(visible[i]);
			}
			completedSteps = new Set(completedSteps);
			currentStep = visible[destIdx];
		}
	}

	async function finishWizard() {
		if (openCodeStatus?.installed) {
			try {
				await opencodeProvidersStore.restartServer(true);
			} catch {
				// Ignore — best effort restart
			}
		}
		authStore.completeSetup();
	}

	// ─── Step Labels ───
	const stepLabels: Record<WizardStep, { label: string; icon: IconName }> = {
		'auth-mode': { label: 'Login', icon: 'lucide:shield' },
		'admin-account': { label: 'Account', icon: 'lucide:user-plus' },
		'system-tools': { label: 'System Tools', icon: 'lucide:hammer' },
		'engines': { label: 'Engines', icon: 'lucide:plug' },
		'preferences': { label: 'Preferences', icon: 'lucide:palette' }
	};

	// ─── Step 1: Auth Mode ───
	let authModeLoading = $state(false);
	let authModeError = $state('');

	async function confirmAuthMode() {
		authModeError = '';
		authModeLoading = true;

		try {
			if (!isExistingUser) {
				// Fresh setup — existing behavior
				if (selectedAuthMode === 'none') {
					await authStore.setupNoAuth();
					completedSteps.add('auth-mode');
					completedSteps.add('admin-account');
					completedSteps = new Set(completedSteps);
					currentStep = 'system-tools';
				} else {
					goToNextStep();
				}
			} else {
				// Returning user (wizard shown again after refresh) — apply selected mode
				const previousMode = authStore.authMode;
				if (selectedAuthMode === 'none' && previousMode !== 'none') {
					// with-auth → no-auth: update mode, skip admin-account
					await authStore.switchToNoAuth();
					completedSteps.add('auth-mode');
					completedSteps.add('admin-account');
					completedSteps = new Set(completedSteps);
					currentStep = 'system-tools';
				} else if (selectedAuthMode === 'required' && previousMode !== 'required') {
					// no-auth → with-auth: update mode, regenerate PAT, go to admin-account
					await authStore.switchToWithAuth();
					goToNextStep();
				} else if (selectedAuthMode === 'none') {
					// Same mode (none) — skip admin-account, go to system-tools
					completedSteps.add('auth-mode');
					completedSteps.add('admin-account');
					completedSteps = new Set(completedSteps);
					currentStep = 'system-tools';
				} else {
					// Same mode (required) — advance to admin-account
					goToNextStep();
				}
			}
		} catch (err) {
			authModeError = err instanceof Error ? err.message : 'Setup failed';
		} finally {
			authModeLoading = false;
		}
	}

	// ─── Step 2: Admin Account ───
	let adminName = $state('');
	let adminError = $state('');
	let adminLoading = $state(false);
	let showPAT = $state(false);
	let patCopied = $state(false);

	async function handleCreateAdmin() {
		// If name is empty, skip this step (can be configured later in Settings)
		if (!adminName.trim()) {
			goToNextStep();
			return;
		}
		adminError = '';
		adminLoading = true;
		try {
			if (isExistingUser) {
				// Existing user — update name if changed
				if (adminName.trim() !== existingUserName) {
					await authStore.updateName(adminName.trim());
				}
				// If a PAT was just generated (e.g. switched from no-auth to with-auth), show it
				if (authStore.personalAccessToken) {
					showPAT = true;
				} else {
					goToNextStep();
				}
			} else {
				await authStore.setup(adminName.trim());
				showPAT = true;
			}
		} catch (err) {
			adminError = err instanceof Error ? err.message : 'Setup failed';
		} finally {
			adminLoading = false;
		}
	}

	async function copyPAT() {
		if (authStore.personalAccessToken) {
			await navigator.clipboard.writeText(authStore.personalAccessToken);
			patCopied = true;
			setTimeout(() => { patCopied = false; }, 2000);
		}
	}

	function handleAdminKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !showPAT) {
			handleCreateAdmin();
		}
	}

	// ─── Step 3: AI Engines ───
	interface EngineStatus {
		installed: boolean;
		version: string | null;
		backendOS: 'windows' | 'macos' | 'linux';
		activeAccount?: { id: number; name: string } | null;
		accountsCount?: number;
	}

	let claudeStatus = $state<EngineStatus | null>(null);
	let openCodeStatus = $state<EngineStatus | null>(null);
	let isLoadingClaude = $state(false);
	let isLoadingOpenCode = $state(false);
	const claudeAccounts = $derived(claudeAccountsStore.accounts);

	const claudeEngine = ENGINES.find(e => e.type === 'claude-code')!;
	const openCodeEngine = ENGINES.find(e => e.type === 'opencode')!;

	// Claude Code account setup flow
	type ClaudeSetupStep = 'idle' | 'loading-url' | 'waiting-code' | 'submitting' | 'success' | 'error';
	let claudeSetupStep = $state<ClaudeSetupStep>('idle');
	let claudeSetupId = $state<string | null>(null);
	let claudeAuthUrl = $state<string | null>(null);
	let claudeAuthCode = $state('');
	let claudeAccountName = $state('');
	let claudeSetupError = $state('');
	let claudeUrlCopied = $state(false);

	// Event listener cleanup
	const wsCleanups: Array<() => void> = [];

	onMount(() => {
		wsCleanups.push(
			ws.on('engine:claude-account-setup-url', (data: { setupId: string; authUrl: string }) => {
				claudeSetupId = data.setupId;
				claudeAuthUrl = data.authUrl;
				claudeSetupStep = 'waiting-code';
			}),
			ws.on('engine:claude-account-setup-complete', async () => {
				claudeSetupStep = 'success';
				await claudeAccountsStore.refresh();
			}),
			ws.on('engine:claude-account-setup-error', (data: { setupId: string; message: string }) => {
				claudeSetupError = data.message;
				claudeSetupStep = 'error';
			})
		);
	});

	onDestroy(() => {
		for (const cleanup of wsCleanups) cleanup();
		wsCleanups.length = 0;
		if (claudeSetupId && claudeSetupStep !== 'idle' && claudeSetupStep !== 'success' && claudeSetupStep !== 'error') {
			ws.emit('engine:claude-account-setup-cancel', { setupId: claudeSetupId });
		}
	});

	function startClaudeSetup() {
		claudeSetupStep = 'loading-url';
		claudeSetupError = '';
		claudeAuthCode = '';
		claudeAccountName = '';
		ws.emit('engine:claude-account-setup-start', {});
	}

	function submitClaudeAuth() {
		if (!claudeSetupId || !claudeAuthCode.trim() || !claudeAccountName.trim()) return;
		claudeSetupStep = 'submitting';
		claudeSetupError = '';
		ws.emit('engine:claude-account-setup-submit', {
			setupId: claudeSetupId,
			code: claudeAuthCode.trim(),
			name: claudeAccountName.trim()
		});
	}

	function cancelClaudeSetup() {
		if (claudeSetupId) {
			ws.emit('engine:claude-account-setup-cancel', { setupId: claudeSetupId });
		}
		resetClaudeSetup();
	}

	function resetClaudeSetup() {
		claudeSetupStep = 'idle';
		claudeSetupId = null;
		claudeAuthUrl = null;
		claudeAuthCode = '';
		claudeAccountName = '';
		claudeSetupError = '';
	}

	// Claude Code account management (switch, rename, delete)
	let claudeRenamingId = $state<number | null>(null);
	let claudeRenameValue = $state('');

	async function switchClaudeAccount(id: number) {
		try {
			await ws.http('engine:claude-accounts-switch', { id });
			await claudeAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	function startClaudeRename(account: ClaudeAccountItem) {
		claudeRenamingId = account.id;
		claudeRenameValue = account.name;
	}

	async function submitClaudeRename() {
		if (claudeRenamingId === null || !claudeRenameValue.trim()) return;
		try {
			await ws.http('engine:claude-accounts-rename', { id: claudeRenamingId, name: claudeRenameValue.trim() });
			claudeRenamingId = null;
			claudeRenameValue = '';
			await claudeAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	function cancelClaudeRename() {
		claudeRenamingId = null;
		claudeRenameValue = '';
	}

	async function deleteClaudeAccount(id: number) {
		try {
			await ws.http('engine:claude-accounts-delete', { id });
			await claudeAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	async function copyClaudeAuthUrl() {
		if (!claudeAuthUrl) return;
		await navigator.clipboard.writeText(claudeAuthUrl);
		claudeUrlCopied = true;
		setTimeout(() => { claudeUrlCopied = false; }, 2000);
	}

	// OpenCode provider management (wizard)
	const ocProviders = $derived(opencodeProvidersStore.providers);
	const ocCatalog = $derived(opencodeProvidersStore.catalog);

	type OCAddStep = 'idle' | 'picking' | 'configuring' | 'saving' | 'success' | 'error';
	let ocAddStep = $state<OCAddStep>('idle');
	let ocAddError = $state('');
	let ocCatalogSearch = $state('');
	let ocSelectedCatalogProvider = $state<ModelsDevProviderItem | null>(null);
	let ocAddAccountName = $state('');
	let ocAddApiKey = $state('');
	let ocAddOptions = $state<Record<string, string>>({});
	let ocCatalogRefreshing = $state(false);

	// Account management within providers
	let ocAddingAccountForProvider = $state<number | null>(null);
	let ocNewAccountName = $state('');
	let ocNewAccountApiKey = $state('');

	function getProviderEnvLabel(slug: string): string {
		const catalogEntry = ocCatalog.find(c => c.id === slug);
		return catalogEntry?.env?.[0] || 'API Key';
	}

	function startAddAccount(providerDbId: number) {
		ocAddingAccountForProvider = providerDbId;
		ocNewAccountName = '';
		ocNewAccountApiKey = '';
	}

	async function submitAddAccount() {
		if (ocAddingAccountForProvider === null || !ocNewAccountName.trim() || !ocNewAccountApiKey.trim()) return;
		try {
			await opencodeProvidersStore.addAccount(ocAddingAccountForProvider, ocNewAccountName.trim(), ocNewAccountApiKey.trim());
			ocAddingAccountForProvider = null;
		} catch {
			// Ignore
		}
	}

	function cancelAddAccount() {
		ocAddingAccountForProvider = null;
	}

	async function switchOCAccount(accountId: number) {
		await opencodeProvidersStore.switchAccount(accountId);
	}

	// OpenCode rename/delete
	let ocRenamingAccountId = $state<number | null>(null);
	let ocRenameValue = $state('');

	function startOCRename(accountId: number, currentName: string) {
		ocRenamingAccountId = accountId;
		ocRenameValue = currentName;
	}

	async function submitOCRename() {
		if (ocRenamingAccountId === null || !ocRenameValue.trim()) return;
		await opencodeProvidersStore.renameAccount(ocRenamingAccountId, ocRenameValue.trim());
		ocRenamingAccountId = null;
		ocRenameValue = '';
	}

	function cancelOCRename() {
		ocRenamingAccountId = null;
		ocRenameValue = '';
	}

	async function deleteOCAccount(accountId: number) {
		await opencodeProvidersStore.deleteAccount(accountId);
	}

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

	function startAddProvider() {
		ocAddStep = 'picking';
		ocAddError = '';
		ocCatalogSearch = '';
		ocSelectedCatalogProvider = null;
		ocAddAccountName = '';
		ocAddApiKey = '';
		ocAddOptions = {};
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
			const options: Record<string, string> = {};
			for (const [key, value] of Object.entries(ocAddOptions)) {
				if (value.trim()) options[key] = value.trim();
			}

			await opencodeProvidersStore.addProvider({
				slug: ocSelectedCatalogProvider.id,
				name: ocSelectedCatalogProvider.name,
				npm: ocSelectedCatalogProvider.npm,
				apiUrl: ocSelectedCatalogProvider.api || undefined,
				options: Object.keys(options).length > 0 ? JSON.stringify(options) : undefined,
				accountName: ocAddAccountName.trim(),
				credential: ocAddApiKey.trim(),
			});
			ocAddStep = 'success';
		} catch (error: any) {
			ocAddError = error?.message || 'Failed to add provider';
			ocAddStep = 'error';
		}
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

	async function checkEngines() {
		checkClaudeEngine();
		checkOpenCodeEngine();
	}

	async function checkClaudeEngine() {
		isLoadingClaude = true;
		try {
			const claude = await ws.http('engine:claude-status', {}).catch(() => null);
			claudeStatus = claude;
			if (claude) {
				if (claude.installed) {
					await claudeAccountsStore.refresh();
				}
			}
		} catch {
			// Ignore
		}
		isLoadingClaude = false;
	}

	async function checkOpenCodeEngine() {
		isLoadingOpenCode = true;
		try {
			const opencode = await ws.http('engine:opencode-status', {}).catch(() => null);
			openCodeStatus = opencode;
			if (opencode) {
				if (opencode.installed) {
					await opencodeProvidersStore.fetchProviders();
					await opencodeProvidersStore.fetchCatalog();
				}
			}
		} catch {
			// Ignore
		}
		isLoadingOpenCode = false;
	}

	// Load engines when reaching that step
	$effect(() => {
		if (currentStep === 'engines' && !claudeStatus && !isLoadingClaude) {
			checkClaudeEngine();
		}
	});

	$effect(() => {
		if (currentStep === 'engines' && !openCodeStatus && !isLoadingOpenCode) {
			checkOpenCodeEngine();
		}
	});

	// ─── Step 4: Preferences ───
	const FONT_SIZE_MIN = 8;
	const FONT_SIZE_MAX = 24;

	function handleFontSizeChange(e: Event) {
		const value = Number((e.target as HTMLInputElement).value);
		applyFontSize(value);
		updateSettings({ fontSize: value });
	}

	function fontSizePercent() {
		return ((settings.fontSize - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN)) * 100;
	}
</script>

<div class="fixed inset-0 z-9999 bg-white dark:bg-slate-950 overflow-y-auto">
	<div class="min-h-full grid place-items-center px-4 py-8">
	<div class="flex flex-col items-center gap-6 text-center max-w-xl w-full">
		<!-- Logo -->
		<div>
			<img src="/favicon.svg" alt="Clopen" class="w-14 h-14 rounded-2xl shadow-xl" />
		</div>

		<div class="space-y-1">
			<h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Welcome to Clopen</h1>
			<p class="text-sm text-slate-500 dark:text-slate-400">Let's set things up in a few quick steps.<br>All of these can be changed later in Settings.</p>
		</div>

		<!-- Stepper -->
		<div class="flex items-center w-full max-w-sm">
			{#each visibleSteps as step, i (step)}
				{@const isActive = step === currentStep}
				{@const currentIdx = visibleSteps.indexOf(currentStep)}
				{@const isPast = i < currentIdx}
				{@const isCompleted = completedSteps.has(step) && isPast}
				{@const info = stepLabels[step]}

				{#if i > 0}
					<div class="flex-1 h-0.5 mx-1 rounded-full {i <= currentIdx ? 'bg-violet-400 dark:bg-violet-500' : 'bg-slate-200 dark:bg-slate-700'}"></div>
				{/if}

				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 rounded-full transition-colors shrink-0
						{isActive
							? 'bg-violet-600 text-white shadow-sm shadow-violet-500/30'
							: isCompleted
								? 'bg-violet-600 text-white'
								: 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500'}"
					disabled={!isPast}
					onclick={() => { if (isPast) currentStep = step; }}
					title={info.label}
				>
					{#if isCompleted}
						<Icon name="lucide:check" class="w-4 h-4" />
					{:else}
						<span class="text-xs font-bold">{i + 1}</span>
					{/if}
				</button>
			{/each}
		</div>

		<!-- Step Content -->
		<div class="w-full">
			<!-- ════════ Step 1: Auth Mode ════════ -->
			{#if currentStep === 'auth-mode'}
				<div class="space-y-4">
					<div class="text-center">
						<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">Authentication Mode</h2>
						<p class="text-sm text-slate-500 dark:text-slate-400">
							Choose how users access Clopen.
						</p>
					</div>

					<div class="grid gap-3">
						<!-- No Login -->
						<button
							type="button"
							class="w-full text-left p-4 rounded-xl border-2 transition-all
								{selectedAuthMode === 'none'
									? 'border-violet-500 bg-violet-50/50 dark:bg-violet-900/10'
									: 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}"
							onclick={() => { selectedAuthMode = 'none'; }}
						>
							<div class="flex items-start gap-3">
								<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0
									{selectedAuthMode === 'none'
										? 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'
										: 'bg-slate-100 dark:bg-slate-800 text-slate-400'}">
									<Icon name="lucide:lock-open" class="w-5 h-5" />
								</div>
								<div class="flex-1 min-w-0">
									<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">No Login</div>
									<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
										No authentication required. Anyone with access to this URL can use Clopen. Ideal for personal or local use.
									</div>
								</div>
								{#if selectedAuthMode === 'none'}
									<Icon name="lucide:circle-check" class="w-5 h-5 shrink-0 text-violet-500 ml-auto mt-0.5" />
								{/if}
							</div>
						</button>

						<!-- With Login -->
						<button
							type="button"
							class="w-full text-left p-4 rounded-xl border-2 transition-all
								{selectedAuthMode === 'required'
									? 'border-violet-500 bg-violet-50/50 dark:bg-violet-900/10'
									: 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}"
							onclick={() => { selectedAuthMode = 'required'; }}
						>
							<div class="flex items-start gap-3">
								<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0
									{selectedAuthMode === 'required'
										? 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'
										: 'bg-slate-100 dark:bg-slate-800 text-slate-400'}">
									<Icon name="lucide:lock" class="w-5 h-5" />
								</div>
								<div class="flex-1 min-w-0">
									<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">With Login</div>
									<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
										Authenticate with a Personal Access Token. Supports multiple users and invite links.
									</div>
								</div>
								{#if selectedAuthMode === 'required'}
									<Icon name="lucide:circle-check" class="w-5 h-5 shrink-0 text-violet-500 ml-auto mt-0.5" />
								{/if}
							</div>
						</button>
					</div>

					{#if authModeError}
						<p class="text-sm text-red-500">{authModeError}</p>
					{/if}

					<button
						onclick={confirmAuthMode}
						disabled={authModeLoading}
						class="w-full py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{#if authModeLoading}
							<span class="inline-flex items-center gap-2">
								<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
								Setting up...
							</span>
						{:else}
							Continue
						{/if}
					</button>
				</div>

			<!-- ════════ Step 2: Admin Account ════════ -->
			{:else if currentStep === 'admin-account'}
				<div class="space-y-4">
					{#if !showPAT}
						<div class="text-center">
							<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">
								{isExistingUser ? 'Admin Account' : 'Create Admin Account'}
							</h2>
							<p class="text-sm text-slate-500 dark:text-slate-400">
								{isExistingUser
									? 'Review or update your admin display name.'
									: 'Set a display name for the admin account.'}
							</p>
						</div>

						<div class="text-left">
							<label for="admin-name" class="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
								Display Name
							</label>
							<input
								id="admin-name"
								type="text"
								bind:value={adminName}
								onkeydown={handleAdminKeydown}
								placeholder="Enter your name"
								disabled={adminLoading}
								class="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
							/>
						</div>

						{#if adminError}
							<p class="text-sm text-red-500">{adminError}</p>
						{/if}

						<div class="flex gap-2">
							<button
								onclick={goToPrevStep}
								class="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
							>
								Back
							</button>
							<button
								onclick={handleCreateAdmin}
								disabled={adminLoading}
								class="flex-1 py-2 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{#if adminLoading}
									Saving...
								{:else}
									Continue
								{/if}
							</button>
						</div>
					{:else}
						<!-- PAT Display -->
						<div class="text-left">
							<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">Save Your Token</h2>
						</div>

						<div class="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-left">
							<p class="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">
								Your Personal Access Token
							</p>
							<p class="text-xs text-amber-700 dark:text-amber-300 mb-3">
								Save this token — you'll need it to log in on other devices. It won't be shown again.
							</p>
							<div class="flex items-center gap-2">
								<code class="flex-1 px-3 py-2 rounded bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 text-xs font-mono text-slate-900 dark:text-slate-100 select-all break-all">
									{authStore.personalAccessToken}
								</code>
								<button
									onclick={copyPAT}
									class="shrink-0 px-3 py-2 rounded bg-amber-100 dark:bg-amber-900 hover:bg-amber-200 dark:hover:bg-amber-800 text-amber-800 dark:text-amber-200 text-xs font-medium transition-colors"
								>
									{patCopied ? 'Copied!' : 'Copy'}
								</button>
							</div>
							<p class="text-xs text-amber-600 dark:text-amber-400 mt-3">
								Lost your token? You can reset it anytime by running <code class="font-mono bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 rounded">clopen reset-pat</code> in your terminal.
							</p>
						</div>

						<button
							onclick={goToNextStep}
							class="w-full py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
						>
							Continue
						</button>
					{/if}
				</div>

			<!-- ════════ Step 3: System Tools ════════ -->
			{:else if currentStep === 'system-tools'}
				<div class="space-y-4">
					<div class="text-center">
						<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">System Tools</h2>
						<p class="text-sm text-slate-500 dark:text-slate-400">
							Install binaries clopen depends on, directly on the server.
						</p>
					</div>

					<div class="text-left">
						<SystemToolsSettings showHeader={false} />
					</div>

					<div class="flex gap-2">
						<button
							onclick={goToPrevStep}
							class="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
						>
							Back
						</button>
						<button
							onclick={goToNextStep}
							class="flex-1 py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
						>
							Continue
						</button>
					</div>
				</div>

			<!-- ════════ Step 4: AI Engines ════════ -->
			{:else if currentStep === 'engines'}
				<div class="space-y-4">
					<div class="text-center">
						<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">Engines</h2>
						<p class="text-sm text-slate-500 dark:text-slate-400">
							Check your AI engine installations.
						</p>
					</div>

						<!-- Claude Code -->
						<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
							<div class="flex items-center gap-2.5 mb-2">
								<div class="flex items-center justify-center [&>svg]:w-5 [&>svg]:h-5">
									{@html isDarkMode() ? claudeEngine.icon.dark : claudeEngine.icon.light}
								</div>
								<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">{claudeEngine.name}</span>
							</div>
							<p class="text-xs text-slate-500 dark:text-slate-400">{claudeEngine.description}</p>

							{#if isLoadingClaude}
								<div class="flex items-center justify-center py-6">
									<Icon name="lucide:loader" class="w-5 h-5 animate-spin text-slate-400" />
								</div>
							{:else if claudeStatus?.installed}
								<!-- Account Management -->
								<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50 space-y-2.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">Accounts</span>
										<span class="text-2xs text-slate-400">{claudeAccounts.length} account{claudeAccounts.length !== 1 ? 's' : ''}</span>
									</div>

									{#if claudeAccounts.length > 0}
										<div class="space-y-1.5">
											{#each claudeAccounts as account (account.id)}
												<div class="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/50 {account.isActive ? 'ring-1 ring-violet-500/30' : ''}">
													<div class="w-full flex items-center gap-2 min-w-0">
														<Icon name="lucide:user" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
														{#if claudeRenamingId === account.id}
															<div class="w-full flex items-center gap-2">
																<input
																	type="text"
																	bind:value={claudeRenameValue}
																	class="w-full px-2 py-0.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
																/>
																<div class="flex items-center gap-0.5">
																	<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors" onclick={submitClaudeRename} aria-label="Save">
																		<Icon name="lucide:check" class="w-3 h-3" />
																	</button>
																	<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={cancelClaudeRename} aria-label="Cancel">
																		<Icon name="lucide:x" class="w-3 h-3" />
																	</button>
																</div>
															</div>
														{:else}
															<span class="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
															{#if account.isActive}
																<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
															{/if}
														{/if}
													</div>
													{#if claudeRenamingId !== account.id}
														<div class="flex items-center gap-0.5">
															{#if !account.isActive}
																<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchClaudeAccount(account.id)} title="Switch to this account">
																	<Icon name="lucide:arrow-right-left" class="w-3 h-3" />
																</button>
															{/if}
															<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" onclick={() => startClaudeRename(account)} title="Rename">
																<Icon name="lucide:pencil" class="w-3 h-3" />
															</button>
															<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => deleteClaudeAccount(account.id)} title="Delete">
																<Icon name="lucide:trash-2" class="w-3 h-3" />
															</button>
														</div>
													{/if}
												</div>
											{/each}
										</div>
									{:else}
										<p class="text-xs text-slate-400 italic">No accounts configured</p>
									{/if}

									<!-- Add Account Flow -->
									{#if claudeSetupStep === 'idle'}
										<button
											type="button"
											class="flex items-center gap-1.5 justify-center w-full px-3 py-2 text-xs font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
											onclick={startClaudeSetup}
										>
											<Icon name="lucide:plus" class="w-3.5 h-3.5" />
											Add Account
										</button>
									{:else if claudeSetupStep === 'loading-url'}
										<div class="flex items-center justify-center gap-2 py-3 text-xs text-slate-500">
											<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
											Starting authentication...
										</div>
									{:else if claudeSetupStep === 'waiting-code'}
										<div class="space-y-2.5 p-3 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<p class="text-xs text-slate-600 dark:text-slate-400">
												Open the URL below, sign in, then paste the code back here.
											</p>
											<div class="bg-white dark:bg-slate-800 rounded-lg px-2.5 py-1.5 text-2xs font-mono text-slate-700 dark:text-slate-300 break-all border border-slate-200 dark:border-slate-700">
												{claudeAuthUrl}
											</div>
											<div class="flex gap-1.5">
												<button
													type="button"
													class="flex items-center gap-1 px-2.5 py-1.5 text-2xs font-medium rounded-md transition-colors
														{claudeUrlCopied
														? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
														: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'}"
													onclick={copyClaudeAuthUrl}
												>
													<Icon name={claudeUrlCopied ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3" />
													{claudeUrlCopied ? 'Copied' : 'Copy URL'}
												</button>
												<a
													href={claudeAuthUrl}
													target="_blank"
													rel="noopener noreferrer"
													class="flex items-center gap-1 px-2.5 py-1.5 text-2xs font-medium rounded-md bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/40 transition-colors"
												>
													<Icon name="lucide:external-link" class="w-3 h-3" />
													Open in Browser
												</a>
											</div>

											<div class="space-y-1.5">
												<input
													type="text"
													bind:value={claudeAuthCode}
													placeholder="Paste authentication code"
													class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
												/>
												<input
													type="text"
													bind:value={claudeAccountName}
													placeholder="Account name (e.g. Personal, Work)"
													class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
												/>
											</div>

											<div class="flex gap-1.5">
												<button
													type="button"
													class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
													onclick={submitClaudeAuth}
													disabled={!claudeAuthCode.trim() || !claudeAccountName.trim()}
												>
													<Icon name="lucide:send" class="w-3.5 h-3.5" />
													Submit
												</button>
												<button
													type="button"
													class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
													onclick={cancelClaudeSetup}
												>
													Cancel
												</button>
											</div>
										</div>
									{:else if claudeSetupStep === 'submitting'}
										<div class="flex items-center justify-center gap-2 py-3 text-xs text-slate-500">
											<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
											Verifying...
										</div>
									{:else if claudeSetupStep === 'success'}
										<div class="flex items-center gap-2 p-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
											<Icon name="lucide:circle-check" class="w-4 h-4 text-green-600 dark:text-green-400" />
											<span class="text-xs text-green-700 dark:text-green-300">Account added!</span>
											<button type="button" class="ml-auto text-2xs text-green-600 dark:text-green-400 hover:underline" onclick={resetClaudeSetup}>Dismiss</button>
										</div>
									{:else if claudeSetupStep === 'error'}
										<div class="space-y-2">
											<div class="flex items-center gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
												<Icon name="lucide:circle-alert" class="w-4 h-4 shrink-0 text-red-600 dark:text-red-400" />
												<span class="text-xs text-red-700 dark:text-red-300">{claudeSetupError}</span>
											</div>
											<button type="button" class="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onclick={resetClaudeSetup}>
												<Icon name="lucide:rotate-ccw" class="w-3.5 h-3.5" />
												Try Again
											</button>
										</div>
									{/if}
								</div>
							{:else if claudeStatus}
								<!-- Redirect to System Tools -->
								<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50">
									<div class="flex items-start gap-2.5 p-3 rounded-lg bg-violet-50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800/50">
										<Icon name="lucide:hammer" class="w-4 h-4 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
										<div class="flex-1 space-y-2">
											<div>
												<p class="text-xs font-semibold text-slate-900 dark:text-slate-100">Claude Code is not installed</p>
												<p class="text-2xs text-slate-600 dark:text-slate-400">Install it from the System Tools step. You can return here once it's installed to connect accounts.</p>
											</div>
											<button
												type="button"
												class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-2xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors"
												onclick={goToPrevStep}
											>
												<Icon name="lucide:arrow-left" class="w-3 h-3" />
												Go to System Tools
											</button>
										</div>
									</div>
								</div>
							{/if}
						</div>

						<!-- OpenCode -->
						<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
							<div class="flex items-center gap-2.5 mb-2">
								<div class="flex items-center justify-center [&>svg]:w-5 [&>svg]:h-5">
									{@html isDarkMode() ? openCodeEngine.icon.dark : openCodeEngine.icon.light}
								</div>
								<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">{openCodeEngine.name}</span>
							</div>
							<p class="text-xs text-slate-500 dark:text-slate-400">{openCodeEngine.description}</p>

							{#if isLoadingOpenCode}
								<div class="flex items-center justify-center py-6">
									<Icon name="lucide:loader" class="w-5 h-5 animate-spin text-slate-400" />
								</div>
							{:else if openCodeStatus && !openCodeStatus.installed}
								<!-- Redirect to System Tools -->
								<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50">
									<div class="flex items-start gap-2.5 p-3 rounded-lg bg-violet-50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800/50">
										<Icon name="lucide:hammer" class="w-4 h-4 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
										<div class="flex-1 space-y-2">
											<div>
												<p class="text-xs font-semibold text-slate-900 dark:text-slate-100">OpenCode is not installed</p>
												<p class="text-2xs text-slate-600 dark:text-slate-400">Install it from the System Tools step. You can return here once it's installed to configure providers.</p>
											</div>
											<button
												type="button"
												class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-2xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors"
												onclick={goToPrevStep}
											>
												<Icon name="lucide:arrow-left" class="w-3 h-3" />
												Go to System Tools
											</button>
										</div>
									</div>
								</div>
							{:else if openCodeStatus?.installed}
								<!-- Provider Management -->
								<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50 space-y-2.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">Providers</span>
										<span class="text-2xs text-slate-400">{ocProviders.length + 1} provider{ocProviders.length !== 0 ? 's' : ''}</span>
									</div>

									<!-- Built-in Opencode Free provider -->
									<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
										<div class="flex items-center justify-between px-3 py-2">
											<div class="flex items-center gap-2 min-w-0">
												<span class="text-xs font-semibold text-slate-900 dark:text-slate-100">Opencode</span>
												<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs font-semibold bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">Free</span>
												<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
											</div>
										</div>
									</div>

									{#each ocProviders as provider (provider.id)}
										<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
											<!-- Provider header -->
											<div class="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700/50">
												<div class="flex items-center gap-2 min-w-0">
													<span class="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{provider.name}</span>
													<span class="text-2xs text-slate-400 font-mono">{provider.slug}</span>
													{#if !provider.isEnabled}
														<span class="px-1.5 py-0.5 text-3xs rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">Disabled</span>
													{/if}
												</div>
											</div>

											<!-- Accounts list -->
											<div class="px-3 py-2 space-y-2">
												{#if provider.accounts.length === 0}
													<p class="text-xs text-slate-500 italic">No accounts</p>
												{:else}
													{#each provider.accounts as account (account.id)}
														<div class="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
															<div class="w-full flex items-center gap-2 min-w-0">
																<Icon name="lucide:key" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
																{#if ocRenamingAccountId === account.id}
																	<div class="w-full flex items-center gap-2">
																		<input
																			type="text"
																			bind:value={ocRenameValue}
																			class="w-full px-2 py-0.5 text-xs rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
																		/>
																		<div class="flex items-center gap-0.5">
																			<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors" onclick={submitOCRename} aria-label="Save">
																				<Icon name="lucide:check" class="w-3 h-3" />
																			</button>
																			<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={cancelOCRename} aria-label="Cancel">
																				<Icon name="lucide:x" class="w-3 h-3" />
																			</button>
																		</div>
																	</div>
																{:else}
																	<span class="text-xs font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
																	{#if account.isActive}
																		<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
																	{/if}
																{/if}
															</div>
															{#if ocRenamingAccountId !== account.id}
																<div class="flex items-center gap-0.5">
																	{#if !account.isActive}
																		<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchOCAccount(account.id)} title="Switch to this account">
																			<Icon name="lucide:arrow-right-left" class="w-3 h-3" />
																		</button>
																	{/if}
																	<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors" onclick={() => startOCRename(account.id, account.name)} title="Rename">
																		<Icon name="lucide:pencil" class="w-3 h-3" />
																	</button>
																	<button type="button" class="flex p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => deleteOCAccount(account.id)} title="Delete">
																		<Icon name="lucide:trash-2" class="w-3 h-3" />
																	</button>
																</div>
															{/if}
														</div>
													{/each}
												{/if}

												<!-- Add account inline -->
												{#if ocAddingAccountForProvider === provider.id}
													<div class="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-700/50">
														<input type="text" bind:value={ocNewAccountName} placeholder="Account name (e.g. Personal, Work)" class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
														<input type="text" bind:value={ocNewAccountApiKey} placeholder={getProviderEnvLabel(provider.slug)} class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 font-mono" />
														<div class="flex gap-1.5">
															<button type="button" class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50" onclick={submitAddAccount} disabled={!ocNewAccountName.trim() || !ocNewAccountApiKey.trim()}>
																<Icon name="lucide:plus" class="w-3 h-3" />Add
															</button>
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

									<!-- Add Provider Flow -->
									{#if ocAddStep === 'idle'}
										<button
											type="button"
											class="flex items-center gap-1.5 justify-center w-full px-3 py-2 text-xs font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
											onclick={startAddProvider}
										>
											<Icon name="lucide:plus" class="w-3.5 h-3.5" />
											Add Provider
										</button>
									{:else if ocAddStep === 'picking'}
										<div class="space-y-2.5 p-3 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center justify-between">
												<div class="flex items-center gap-1.5 text-2xs font-medium text-violet-600 dark:text-violet-400">
													<Icon name="lucide:search" class="w-3 h-3" />
													Select a provider
												</div>
												<button
													type="button"
													class="flex items-center gap-1 text-3xs text-slate-500 hover:text-violet-600 transition-colors disabled:opacity-50"
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
												class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
											/>

											<div class="max-h-36 overflow-y-auto space-y-1">
												{#if ocFilteredCatalog.length === 0}
													<p class="text-2xs text-slate-500 text-center py-2">{ocCatalogSearch ? 'No matching providers' : 'No providers available'}</p>
												{:else}
													{#each ocFilteredCatalog as cp (cp.id)}
														<button
															type="button"
															class="flex items-center justify-between w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-violet-100/50 dark:hover:bg-violet-900/20 transition-colors"
															onclick={() => selectCatalogProvider(cp)}
														>
															<div>
																<span class="text-xs font-medium text-slate-900 dark:text-slate-100">{cp.name}</span>
																<span class="text-2xs text-slate-400 font-mono ml-1.5">{cp.id}</span>
															</div>
															<Icon name="lucide:chevron-right" class="w-3 h-3 text-slate-400" />
														</button>
													{/each}
												{/if}
											</div>

											<button type="button" class="w-full px-2.5 py-1.5 text-2xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelAddProvider}>Cancel</button>
										</div>
									{:else if ocAddStep === 'configuring' && ocSelectedCatalogProvider}
										<div class="space-y-2.5 p-3 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center gap-1.5 text-2xs font-medium text-violet-600 dark:text-violet-400">
												<Icon name="lucide:settings" class="w-3 h-3" />
												Configure {ocSelectedCatalogProvider.name}
											</div>

											<div>
												<label class="block text-2xs font-medium text-slate-700 dark:text-slate-300 mb-1">Account name</label>
												<input type="text" bind:value={ocAddAccountName} placeholder="e.g. Personal, Work" class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
											</div>

											<div>
												<label class="block text-2xs font-medium text-slate-700 dark:text-slate-300 mb-1">
													{ocSelectedCatalogProvider.env.length > 0 ? ocSelectedCatalogProvider.env[0] : 'API Key'}
												</label>
												<input type="text" bind:value={ocAddApiKey} placeholder={`Enter ${ocSelectedCatalogProvider.env.length > 0 ? ocSelectedCatalogProvider.env[0] : 'API Key'}`} class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40" />
											</div>

											{#each ocSelectedCatalogProvider.env.slice(1) as envVar (envVar)}
												<div>
													<label class="block text-2xs font-medium text-slate-700 dark:text-slate-300 mb-1">{envVar}</label>
													<input
														type="text"
														value={ocAddOptions[envVar] || ''}
														oninput={(e) => { ocAddOptions = { ...ocAddOptions, [envVar]: (e.target as HTMLInputElement).value }; }}
														placeholder={`Enter ${envVar}`}
														class="w-full px-2.5 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40"
													/>
												</div>
											{/each}

											<div class="flex gap-1.5">
												<button
													type="button"
													class="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
													onclick={submitAddProvider}
													disabled={!isAddProviderValid()}
												>
													<Icon name="lucide:plus" class="w-3.5 h-3.5" />
													Add Provider
												</button>
												<button type="button" class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={() => { ocAddStep = 'picking'; }}>Back</button>
											</div>
										</div>
									{:else if ocAddStep === 'saving'}
										<div class="flex items-center justify-center gap-2 py-3 text-xs text-slate-500">
											<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
											Adding provider...
										</div>
									{:else if ocAddStep === 'success'}
										<div class="flex items-center gap-2 p-2.5 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
											<Icon name="lucide:circle-check" class="w-4 h-4 text-green-600 dark:text-green-400" />
											<span class="text-xs text-green-700 dark:text-green-300">Provider added!</span>
											<button type="button" class="ml-auto text-2xs text-green-600 dark:text-green-400 hover:underline" onclick={() => { ocAddStep = 'idle'; }}>Dismiss</button>
										</div>
									{:else if ocAddStep === 'error'}
										<div class="space-y-2">
											<div class="flex items-center gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
												<Icon name="lucide:circle-alert" class="w-4 h-4 shrink-0 text-red-600 dark:text-red-400" />
												<span class="text-xs text-red-700 dark:text-red-300">{ocAddError}</span>
											</div>
											<button type="button" class="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onclick={() => { ocAddStep = 'configuring'; }}>
												<Icon name="lucide:rotate-ccw" class="w-3.5 h-3.5" />
												Try Again
											</button>
										</div>
									{/if}
								</div>
							{/if}
						</div>

						<!-- Recheck button -->
						<button
							type="button"
							onclick={checkEngines}
							disabled={isLoadingClaude || isLoadingOpenCode}
							class="flex items-center justify-center gap-2 w-full py-2 px-4 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
							Recheck Installation
						</button>

					<div class="flex gap-2">
						<button
							onclick={goToPrevStep}
							class="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
						>
							Back
						</button>
						<button
							onclick={goToNextStep}
							class="flex-1 py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
						>
							Continue
						</button>
					</div>
				</div>

			<!-- ════════ Step 5: Preferences ════════ -->
			{:else if currentStep === 'preferences'}
				<div class="space-y-4">
					<div class="text-center">
						<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">Preferences</h2>
						<p class="text-sm text-slate-500 dark:text-slate-400">
							Customize your experience.
						</p>
					</div>

					<!-- Theme -->
					<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
									<Icon name={themeStore.isDark ? 'lucide:moon' : 'lucide:sun'} class="w-4.5 h-4.5" />
								</div>
								<div>
									<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Dark Mode</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">
										Currently: <span class="font-medium">{themeStore.isDark ? 'Dark' : 'Light'}</span>
									</div>
								</div>
							</div>
							<label class="relative inline-block w-12 h-6.5 shrink-0">
								<input
									type="checkbox"
									checked={themeStore.isDark}
									onchange={toggleDarkMode}
									class="opacity-0 w-0 h-0"
								/>
								<span
									class="absolute cursor-pointer inset-0 bg-slate-600/40 rounded-3xl transition-all duration-200
									before:absolute before:content-[''] before:h-5 before:w-5 before:left-0.75 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
									{themeStore.isDark
										? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-5.5'
										: ''}"
								></span>
							</label>
						</div>
					</div>

					<!-- Sound Notifications -->
					<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-3">
								<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
									<Icon name="lucide:volume-2" class="w-4.5 h-4.5" />
								</div>
								<div>
									<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Sound Notifications</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">Play sound when response completes</div>
								</div>
							</div>
							<label class="relative inline-block w-12 h-6.5 shrink-0">
								<input
									type="checkbox"
									checked={settings.soundNotifications}
									onchange={() => updateSettings({ soundNotifications: !settings.soundNotifications })}
									class="opacity-0 w-0 h-0"
								/>
								<span
									class="absolute cursor-pointer inset-0 bg-slate-600/40 rounded-3xl transition-all duration-200
									before:absolute before:content-[''] before:h-5 before:w-5 before:left-0.75 before:bottom-0.75 before:bg-white before:rounded-full before:transition-all before:duration-200
									{settings.soundNotifications
										? 'bg-gradient-to-br from-violet-600 to-purple-600 before:translate-x-5.5'
										: ''}"
								></span>
							</label>
						</div>
					</div>

					<!-- Font Size -->
					<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
						<div class="flex items-center gap-3 mb-3">
							<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
								<Icon name="lucide:type" class="w-4.5 h-4.5" />
							</div>
							<div class="flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Font Size</div>
								<div class="text-xs text-slate-500 dark:text-slate-400">Adjust the base font size</div>
							</div>
							<div class="text-sm font-semibold text-violet-600 dark:text-violet-400">
								{settings.fontSize}px
							</div>
						</div>
						<div class="flex items-center gap-2.5 px-0.5">
							<span class="text-xs text-slate-500 shrink-0">A</span>
							<div class="relative flex-1 h-1.5">
								<div class="absolute inset-0 bg-slate-300 dark:bg-slate-700 rounded-full"></div>
								<div
									class="absolute inset-y-0 left-0 bg-gradient-to-r from-violet-500 to-purple-500 rounded-full"
									style="width: {fontSizePercent()}%"
								></div>
								<input
									type="range"
									min={FONT_SIZE_MIN}
									max={FONT_SIZE_MAX}
									step="1"
									value={settings.fontSize}
									oninput={handleFontSizeChange}
									class="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
								/>
								<div
									class="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-violet-500 rounded-full shadow-sm pointer-events-none"
									style="left: calc({fontSizePercent()}% - {fontSizePercent() / 100 * 16}px)"
								></div>
							</div>
							<span class="text-base text-slate-500 shrink-0">A</span>
						</div>
					</div>

					<!-- Message Layout -->
					<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
						<div class="flex items-center gap-3 mb-3">
							<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
								<Icon name="lucide:layout-list" class="w-4.5 h-4.5" />
							</div>
							<div>
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Message Layout</div>
								<div class="text-xs text-slate-500 dark:text-slate-400">Choose how AI chat messages are displayed</div>
							</div>
						</div>
						<div class="grid grid-cols-2 gap-2">
							<button
								type="button"
								onclick={() => updateSettings({ chatAppearance: 'classic' })}
								aria-pressed={settings.chatAppearance === 'classic'}
								class="flex flex-col gap-1.5 p-2.5 rounded-lg border-2 transition-all text-left {settings.chatAppearance === 'classic'
									? 'border-violet-500 bg-violet-500/5'
									: 'border-slate-200 dark:border-slate-700 hover:border-violet-500/40'}"
							>
								<div class="flex flex-col gap-0.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 overflow-hidden h-10">
									<div class="border border-slate-200 dark:border-slate-700 rounded mx-1 mt-1 overflow-hidden">
										<div class="flex items-center gap-1 px-1 py-0.5 bg-slate-100 dark:bg-slate-800">
											<div class="w-3 h-0.5 rounded-full bg-slate-300 dark:bg-slate-600"></div>
											<div class="flex-1"></div>
											<div class="w-2 h-0.5 rounded-full bg-slate-300 dark:bg-slate-600"></div>
										</div>
										<div class="px-1 py-0.5">
											<div class="w-full h-0.5 rounded-full bg-slate-200 dark:bg-slate-700"></div>
										</div>
									</div>
									<div class="border border-slate-200 dark:border-slate-700 rounded mx-1 overflow-hidden">
										<div class="flex items-center gap-1 px-1 py-0.5 bg-slate-100 dark:bg-slate-800">
											<div class="w-2 h-0.5 rounded-full bg-slate-300 dark:bg-slate-600"></div>
											<div class="flex-1"></div>
											<div class="w-2 h-0.5 rounded-full bg-slate-300 dark:bg-slate-600"></div>
										</div>
										<div class="px-1 py-0.5">
											<div class="w-3/4 h-0.5 rounded-full bg-slate-200 dark:bg-slate-700"></div>
										</div>
									</div>
								</div>
								<div class="flex items-center justify-between">
									<span class="text-xs font-semibold text-slate-900 dark:text-slate-100">Classic</span>
									{#if settings.chatAppearance === 'classic'}
										<Icon name="lucide:circle-check" class="w-3.5 h-3.5 text-violet-500" />
									{/if}
								</div>
								<span class="text-2xs text-slate-500 dark:text-slate-400">Cards with headers and content sections</span>
							</button>
							<button
								type="button"
								onclick={() => updateSettings({ chatAppearance: 'compact' })}
								aria-pressed={settings.chatAppearance === 'compact'}
								class="flex flex-col gap-1.5 p-2.5 rounded-lg border-2 transition-all text-left {settings.chatAppearance === 'compact'
									? 'border-violet-500 bg-violet-500/5'
									: 'border-slate-200 dark:border-slate-700 hover:border-violet-500/40'}"
							>
								<div class="flex flex-col gap-1 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-1.5 h-10 overflow-hidden">
									<div class="w-3/4 h-0.5 rounded-full bg-slate-200 dark:bg-slate-700"></div>
									<div class="w-full h-0.5 rounded-full bg-slate-200 dark:bg-slate-700"></div>
									<div class="w-2/3 h-0.5 rounded-full bg-slate-200 dark:bg-slate-700"></div>
									<div class="w-full h-0.5 rounded-full bg-slate-200 dark:bg-slate-700"></div>
								</div>
								<div class="flex items-center justify-between">
									<span class="text-xs font-semibold text-slate-900 dark:text-slate-100">Compact</span>
									{#if settings.chatAppearance === 'compact'}
										<Icon name="lucide:circle-check" class="w-3.5 h-3.5 text-violet-500" />
									{/if}
								</div>
								<span class="text-2xs text-slate-500 dark:text-slate-400">Dense lines, no borders or cards</span>
							</button>
						</div>
					</div>

					<div class="flex gap-2">
						<button
							onclick={goToPrevStep}
							class="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
						>
							Back
						</button>
						<button
							onclick={finishWizard}
							class="flex-1 py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors"
						>
							Finish Setup
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
	</div>
</div>

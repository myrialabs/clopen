<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { themeStore, toggleDarkMode, isDarkMode, initializeTheme } from '$frontend/stores/ui/theme.svelte';
	import { settings, updateSettings, applyFontSize } from '$frontend/stores/features/settings.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import { claudeAccountsStore, type ClaudeAccountItem } from '$frontend/stores/features/claude-accounts.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import type { AuthMode } from '$shared/types/stores/settings';
	import type { IconName } from '$shared/types/ui/icons';

	// Ensure theme is initialized (normally done in WorkspaceLayout which hasn't mounted yet)
	onMount(() => {
		initializeTheme();
	});

	// ─── Wizard state ───
	type WizardStep = 'auth-mode' | 'admin-account' | 'engines' | 'preferences';
	const ALL_STEPS: WizardStep[] = ['auth-mode', 'admin-account', 'engines', 'preferences'];

	let currentStep = $state<WizardStep>('auth-mode');
	let completedSteps = $state<Set<WizardStep>>(new Set());
	let selectedAuthMode = $state<AuthMode>('required');

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

	// Sync auth mode from server (reactive)
	$effect(() => {
		if (authStore.authMode) {
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

	function finishWizard() {
		authStore.completeSetup();
	}

	// ─── Step Labels ───
	const stepLabels: Record<WizardStep, { label: string; icon: IconName }> = {
		'auth-mode': { label: 'Login', icon: 'lucide:shield' },
		'admin-account': { label: 'Account', icon: 'lucide:user-plus' },
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
					currentStep = 'engines';
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
					currentStep = 'engines';
				} else if (selectedAuthMode === 'required' && previousMode !== 'required') {
					// no-auth → with-auth: update mode, regenerate PAT, go to admin-account
					await authStore.switchToWithAuth();
					goToNextStep();
				} else if (selectedAuthMode === 'none') {
					// Same mode (none) — skip admin-account, go to engines
					completedSteps.add('auth-mode');
					completedSteps.add('admin-account');
					completedSteps = new Set(completedSteps);
					currentStep = 'engines';
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
	let isLoadingEngines = $state(false);
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

	async function copyClaudeAuthUrl() {
		if (!claudeAuthUrl) return;
		await navigator.clipboard.writeText(claudeAuthUrl);
		claudeUrlCopied = true;
		setTimeout(() => { claudeUrlCopied = false; }, 2000);
	}

	// Install guide state
	type ClaudeInstallTab = 'unix' | 'powershell';
	type OpenCodeInstallTab = 'unix' | 'bun';
	let activeClaudeInstallTab = $state<ClaudeInstallTab>('unix');
	let activeOpenCodeInstallTab = $state<OpenCodeInstallTab>('unix');
	let claudeCommandCopied = $state(false);
	let openCodeCommandCopied = $state(false);

	const claudeInstallCommands: Record<ClaudeInstallTab, { label: string; command: string }> = {
		unix: { label: 'macOS / Linux / WSL', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
		powershell: { label: 'Windows PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' },
	};

	const openCodeInstallCommands: Record<OpenCodeInstallTab, { label: string; command: string }> = {
		unix: { label: 'macOS / Linux / WSL', command: 'curl -fsSL https://opencode.ai/install | bash' },
		bun: { label: 'Bun', command: 'bun add -g opencode-ai' },
	};

	async function copyClaudeCommand() {
		await navigator.clipboard.writeText(claudeInstallCommands[activeClaudeInstallTab].command);
		claudeCommandCopied = true;
		setTimeout(() => { claudeCommandCopied = false; }, 2000);
	}

	async function copyOpenCodeCommand() {
		await navigator.clipboard.writeText(openCodeInstallCommands[activeOpenCodeInstallTab].command);
		openCodeCommandCopied = true;
		setTimeout(() => { openCodeCommandCopied = false; }, 2000);
	}

	async function checkEngines() {
		isLoadingEngines = true;
		try {
			const [claude, opencode] = await Promise.all([
				ws.http('engine:claude-status', {}).catch(() => null),
				ws.http('engine:opencode-status', {}).catch(() => null)
			]);
			claudeStatus = claude;
			openCodeStatus = opencode;

			if (claude) {
				activeClaudeInstallTab = claude.backendOS === 'windows' ? 'powershell' : 'unix';
				if (claude.installed) {
					await claudeAccountsStore.refresh();
				}
			}
			if (opencode) {
				activeOpenCodeInstallTab = opencode.backendOS === 'windows' ? 'bun' : 'unix';
			}
		} catch {
			// Ignore
		}
		isLoadingEngines = false;
	}

	// Load engines when reaching that step
	$effect(() => {
		if (currentStep === 'engines' && !claudeStatus && !isLoadingEngines) {
			checkEngines();
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
	<div class="flex flex-col items-center gap-6 text-center max-w-lg w-full">
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

			<!-- ════════ Step 3: AI Engines ════════ -->
			{:else if currentStep === 'engines'}
				<div class="space-y-4">
					<div class="text-center">
						<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">Engines</h2>
						<p class="text-sm text-slate-500 dark:text-slate-400">
							Check your AI engine installations.
						</p>
					</div>

					{#if isLoadingEngines}
						<div class="flex items-center justify-center py-8">
							<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
						</div>
					{:else}
						<!-- Claude Code -->
						<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
							<div class="flex items-center justify-between mb-2">
								<div class="flex items-center gap-2.5">
									<div class="flex items-center justify-center [&>svg]:w-5 [&>svg]:h-5">
										{@html isDarkMode() ? claudeEngine.icon.dark : claudeEngine.icon.light}
									</div>
									<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">{claudeEngine.name}</span>
								</div>
								{#if claudeStatus?.installed}
									<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
										<span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
										{claudeStatus.version || 'Installed'}
									</span>
								{:else}
									<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
										<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
										Not Installed
									</span>
								{/if}
							</div>
							<p class="text-xs text-slate-500 dark:text-slate-400">{claudeEngine.description}</p>

							{#if claudeStatus?.installed}
								<!-- Account Management -->
								<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50 space-y-2.5">
									<div class="flex items-center justify-between">
										<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">Accounts</span>
										<span class="text-2xs text-slate-400">{claudeAccounts.length} account{claudeAccounts.length !== 1 ? 's' : ''}</span>
									</div>

									{#if claudeAccounts.length > 0}
										<div class="space-y-1.5">
											{#each claudeAccounts as account (account.id)}
												<div class="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/50 {account.isActive ? 'ring-1 ring-violet-500/30' : ''}">
													<Icon name="lucide:user" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
													<span class="text-xs font-medium text-slate-900 dark:text-slate-100 truncate flex-1">{account.name}</span>
													{#if account.isActive}
														<span class="inline-flex items-center px-1.5 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
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
													Open
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
								<!-- Install Guide -->
								<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50 space-y-3">
									<p class="text-xs text-slate-600 dark:text-slate-300">Install using one of the methods below:</p>

									<div class="flex flex-wrap gap-1.5">
										{#each Object.entries(claudeInstallCommands) as [key, { label }]}
											<button
												type="button"
												class="px-2.5 py-1 rounded-lg text-2xs font-medium transition-colors
													{activeClaudeInstallTab === key
													? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
													: 'bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
												onclick={() => (activeClaudeInstallTab = key as ClaudeInstallTab)}
											>
												{label}
											</button>
										{/each}
									</div>

									<div class="relative group">
										<pre class="bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto">{claudeInstallCommands[activeClaudeInstallTab].command}</pre>
										<button
											type="button"
											class="flex absolute top-1.5 right-1.5 p-1 rounded-md transition-colors {claudeCommandCopied ? 'bg-violet-600/80 text-white' : 'bg-slate-300/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-slate-400/80 dark:hover:bg-slate-600'}"
											onclick={copyClaudeCommand}
											aria-label="Copy command"
										>
											<Icon name={claudeCommandCopied ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3" />
										</button>
									</div>

									{#if claudeStatus.backendOS === 'windows'}
										<div class="flex gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-700/50">
											<Icon name="lucide:info" class="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
											<div class="text-2xs text-amber-800 dark:text-amber-300 space-y-0.5">
												<p class="font-medium">Git Bash is required</p>
												<p class="text-amber-700 dark:text-amber-400">
													Claude Code requires Git Bash on Windows.
												</p>
											</div>
										</div>
									{/if}

									<div class="flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400">
										<Icon name="lucide:book-open" class="w-3 h-3 shrink-0" />
										<a
											href="https://code.claude.com/docs/en/quickstart"
											target="_blank"
											rel="noopener noreferrer"
											class="font-medium text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 underline underline-offset-2"
										>
											Official documentation
										</a>
									</div>
								</div>
							{/if}
						</div>

						<!-- OpenCode -->
						<div class="text-left p-4 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50">
							<div class="flex items-center justify-between mb-2">
								<div class="flex items-center gap-2.5">
									<div class="flex items-center justify-center [&>svg]:w-5 [&>svg]:h-5">
										{@html isDarkMode() ? openCodeEngine.icon.dark : openCodeEngine.icon.light}
									</div>
									<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">{openCodeEngine.name}</span>
								</div>
								{#if openCodeStatus?.installed}
									<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
										<span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
										{openCodeStatus.version || 'Installed'}
									</span>
								{:else}
									<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
										<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
										Not Installed
									</span>
								{/if}
							</div>
							<p class="text-xs text-slate-500 dark:text-slate-400">{openCodeEngine.description}</p>

							{#if openCodeStatus && !openCodeStatus.installed}
								<!-- Install Guide -->
								<div class="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700/50 space-y-3">
									<p class="text-xs text-slate-600 dark:text-slate-300">Install using one of the methods below:</p>

									<div class="flex flex-wrap gap-1.5">
										{#each Object.entries(openCodeInstallCommands) as [key, { label }]}
											<button
												type="button"
												class="px-2.5 py-1 rounded-lg text-2xs font-medium transition-colors
													{activeOpenCodeInstallTab === key
													? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
													: 'bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
												onclick={() => (activeOpenCodeInstallTab = key as OpenCodeInstallTab)}
											>
												{label}
											</button>
										{/each}
									</div>

									<div class="relative group">
										<pre class="bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-2 text-xs font-mono overflow-x-auto">{openCodeInstallCommands[activeOpenCodeInstallTab].command}</pre>
										<button
											type="button"
											class="flex absolute top-1.5 right-1.5 p-1 rounded-md transition-colors {openCodeCommandCopied ? 'bg-violet-600/80 text-white' : 'bg-slate-300/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-slate-400/80 dark:hover:bg-slate-600'}"
											onclick={copyOpenCodeCommand}
											aria-label="Copy command"
										>
											<Icon name={openCodeCommandCopied ? 'lucide:check' : 'lucide:copy'} class="w-3 h-3" />
										</button>
									</div>

									<div class="flex items-center gap-1.5 text-2xs text-slate-500 dark:text-slate-400">
										<Icon name="lucide:book-open" class="w-3 h-3 shrink-0" />
										<a
											href="https://opencode.ai/docs"
											target="_blank"
											rel="noopener noreferrer"
											class="font-medium text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 underline underline-offset-2"
										>
											Official documentation
										</a>
									</div>
								</div>
							{/if}
						</div>

						<!-- Recheck button -->
						<button
							type="button"
							onclick={checkEngines}
							class="flex items-center justify-center gap-2 w-full py-2 px-4 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
						>
							<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
							Recheck Installation
						</button>
					{/if}

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

			<!-- ════════ Step 4: Preferences ════════ -->
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

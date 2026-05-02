<script lang="ts">
	import { onMount } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { themeStore, toggleDarkMode, initializeTheme } from '$frontend/stores/ui/theme.svelte';
	import { settings, updateSettings, applyFontSize } from '$frontend/stores/features/settings.svelte';
	import { opencodeProvidersStore } from '$frontend/stores/features/opencode-providers.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import SystemToolsSettings from '$frontend/components/settings/system-tools/SystemToolsSettings.svelte';
	import AIEnginesSettings from '$frontend/components/settings/engines/AIEnginesSettings.svelte';
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
		try {
			const status = await ws.http('engine:opencode-status', {}).catch(() => null);
			if (status?.installed) {
				await opencodeProvidersStore.restartServer(true);
			}
		} catch {
			// Ignore — best effort restart
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
				<div class="space-y-4 text-left">
					<div class="text-center">
						<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">Engines</h2>
						<p class="text-sm text-slate-500 dark:text-slate-400">
							Connect accounts and configure providers for your AI engines.
						</p>
					</div>

					<AIEnginesSettings showHeader={false} compact />

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

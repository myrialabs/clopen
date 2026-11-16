<script lang="ts">
	/**
	 * The setup wizard (version 2, v0.5) — three short steps.
	 *
	 * Every install goes through it once — fresh installs to set up, and v0.4
	 * installs to meet Clopen the assistant. For an existing install each step
	 * starts from what is already set, so going through it changes nothing the
	 * owner does not change.
	 *
	 *   1. Access       just this computer, or other devices too (+ the sign-in
	 *                   key, shown once, when one was just created)
	 *   2. AI           free OpenCode, installed on its own — or an API key, or
	 *                   another agent: Install → Sign in → Ready, in place
	 *   3. Preferences  ask before acting, start with the computer, dark mode
	 *
	 * No first task and no profession picker: the chat itself is where the owner
	 * says what they want, and its placeholder shows the range.
	 */
	import { onMount } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { initializeTheme, themeStore, toggleDarkMode } from '$frontend/stores/ui/theme.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import AIEnginesSettings from '$frontend/components/settings/engines/AIEnginesSettings.svelte';
	import ws from '$frontend/utils/ws';
	import type { AuthMode } from '$shared/types/stores/settings';
	import type { IconName } from '$shared/types/ui/icons';

	onMount(() => {
		// Normally done in WorkspaceLayout, which has not mounted yet.
		initializeTheme();
	});

	// ─── Wizard state ───
	type WizardStep = 'access' | 'ai' | 'prefs';
	const STEPS: WizardStep[] = ['access', 'ai', 'prefs'];
	const STEP_LABEL: Record<WizardStep, { label: string; icon: IconName }> = {
		access: { label: 'Access', icon: 'lucide:shield' },
		ai: { label: 'AI', icon: 'lucide:sparkles' },
		prefs: { label: 'Preferences', icon: 'lucide:sliders-horizontal' }
	};

	let currentStep = $state<WizardStep>('access');
	const currentIndex = $derived(STEPS.indexOf(currentStep));
	let selectedAuthMode = $state<AuthMode>('none');

	// An owner already exists: an upgraded install going through the new wizard.
	let isExistingUser = $state(false);

	$effect(() => {
		if (authStore.currentUser && !isExistingUser) isExistingUser = true;
	});

	// Existing installs start from their current sign-in mode; a fresh one from "just this computer".
	$effect(() => {
		if (isExistingUser && authStore.authMode) selectedAuthMode = authStore.authMode;
	});

	function next() {
		if (currentIndex < STEPS.length - 1) currentStep = STEPS[currentIndex + 1];
	}

	function back() {
		if (currentIndex > 0) currentStep = STEPS[currentIndex - 1];
	}

	// ─── Step 1: Access ───
	let accessLoading = $state(false);
	let accessError = $state('');
	/** A sign-in key was just created: show it once before moving on. */
	let showKey = $state(false);
	let keyCopied = $state(false);
	let keyCopyFailed = $state(false);
	let keySaved = $state(false);

	async function confirmAccess() {
		accessError = '';
		accessLoading = true;
		try {
			let keyCreated = false;
			if (!isExistingUser) {
				if (selectedAuthMode === 'none') await authStore.setupNoAuth();
				else {
					await authStore.setup();
					keyCreated = true;
				}
			} else {
				const previousMode = authStore.authMode;
				if (selectedAuthMode === 'none' && previousMode !== 'none') await authStore.switchToNoAuth();
				else if (selectedAuthMode === 'required' && previousMode !== 'required') {
					await authStore.switchToWithAuth();
					keyCreated = true;
				}
			}
			if (keyCreated && authStore.personalAccessToken) showKey = true;
			else next();
		} catch (err) {
			accessError = err instanceof Error ? err.message : 'Setup failed';
		} finally {
			accessLoading = false;
		}
	}

	async function copyKey() {
		const token = authStore.personalAccessToken;
		if (!token) return;
		keyCopyFailed = false;
		try {
			await navigator.clipboard.writeText(token);
			keyCopied = true;
			setTimeout(() => (keyCopied = false), 2000);
		} catch {
			// Clipboard access is blocked on plain-HTTP origins; the key stays selectable.
			keyCopyFailed = true;
		}
	}

	// ─── Step 3: Preferences ───
	let askFirst = $state(false);
	let autostart = $state<{ supported: boolean; enabled: boolean; reason?: string } | null>(null);
	let wantAutostart = $state(false);
	let finishLoading = $state(false);
	let finishError = $state('');

	async function loadPrefs() {
		try {
			const settings = await ws.http('assistant:settings-get', {});
			askFirst = settings.autonomy === 'ask';
		} catch {
			// Defaults stand.
		}
		try {
			const status = await ws.http('assistant:autostart-status', {});
			autostart = status;
			wantAutostart = status.enabled;
		} catch {
			autostart = { supported: false, enabled: false };
		}
	}

	$effect(() => {
		if (currentStep === 'prefs' && autostart === null) void loadPrefs();
	});

	async function finish() {
		finishError = '';
		finishLoading = true;
		try {
			await ws.http('assistant:settings-save', { autonomy: askFirst ? 'ask' : 'autonomous' });
			if (autostart?.supported && wantAutostart !== autostart.enabled) {
				autostart = await ws.http('assistant:autostart-set', { enabled: wantAutostart });
			}
			// Only leaves the wizard once the server confirms setup is recorded;
			// otherwise the next refresh would land right back here.
			await authStore.completeSetup();
		} catch (err) {
			finishError = err instanceof Error ? err.message : 'Setup could not be saved';
		} finally {
			finishLoading = false;
		}
	}

	const primaryButton =
		'w-full py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
	const backButton =
		'px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors';
	const footer = 'flex gap-2 sticky bottom-0 z-10 pt-3 pb-3 bg-white dark:bg-slate-950 border-t border-slate-200/70 dark:border-slate-800/70';
	function choiceCard(selected: boolean): string {
		return `w-full text-left p-4 rounded-xl border-2 transition-all ${selected ? 'border-violet-500 bg-violet-50/50 dark:bg-violet-900/10' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`;
	}
</script>

{#snippet toggle(checked: boolean, onchange: () => void, label: string)}
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		aria-label={label}
		class="relative w-10 h-6 shrink-0 rounded-full border-none cursor-pointer transition-colors {checked ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
		onclick={onchange}
	>
		<span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform {checked ? 'translate-x-4' : ''}"></span>
	</button>
{/snippet}

<div class="fixed inset-0 z-9999 bg-white dark:bg-slate-950 overflow-y-auto">
	<div class="min-h-full grid place-items-center px-4 py-8">
	<div class="flex flex-col items-center gap-6 text-center max-w-xl w-full">
		<img src="/favicon.svg" alt="Clopen" class="w-14 h-14 rounded-2xl shadow-xl" />

		<div class="space-y-1">
			<h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">{isExistingUser ? 'Meet the new Clopen' : 'Welcome to Clopen'}</h1>
			<p class="text-sm text-slate-500 dark:text-slate-400">
				{isExistingUser ? 'Your projects and chats are all still here.' : 'Three quick steps.'}
			</p>
		</div>

		<!-- Stepper -->
		<div class="w-full max-w-xs space-y-2">
			<div class="flex items-center w-full">
				{#each STEPS as step, i (step)}
					{@const isPast = i < currentIndex}
					{#if i > 0}
						<div class="flex-1 h-0.5 mx-1 rounded-full {i <= currentIndex ? 'bg-violet-400 dark:bg-violet-500' : 'bg-slate-200 dark:bg-slate-700'}"></div>
					{/if}
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 rounded-full transition-colors shrink-0
							{step === currentStep || isPast ? 'bg-violet-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500'}"
						disabled={!isPast}
						onclick={() => { if (isPast) currentStep = step; }}
						title={STEP_LABEL[step].label}
					>
						{#if isPast}<Icon name="lucide:check" class="w-4 h-4" />{:else}<span class="text-xs font-bold">{i + 1}</span>{/if}
					</button>
				{/each}
			</div>
			<p class="text-xs text-slate-400 dark:text-slate-500">Step {currentIndex + 1} of {STEPS.length} · {STEP_LABEL[currentStep].label}</p>
		</div>

		<div class="w-full">
			<!-- ════════ 1. Access ════════ -->
			{#if currentStep === 'access' && !showKey}
				<div class="space-y-4">
					<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Where will you use Clopen?</h2>
					<div class="grid gap-3">
						<button type="button" class={choiceCard(selectedAuthMode === 'none')} onclick={() => (selectedAuthMode = 'none')}>
							<div class="flex items-start gap-3">
								<Icon name="lucide:laptop" class="w-5 h-5 mt-0.5 shrink-0 {selectedAuthMode === 'none' ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400'}" />
								<div class="flex-1 min-w-0">
									<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Just this computer</div>
									<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Opens right away. Nothing to sign in to.</div>
								</div>
								{#if selectedAuthMode === 'none'}<Icon name="lucide:circle-check" class="w-5 h-5 shrink-0 text-violet-500" />{/if}
							</div>
						</button>
						<button type="button" class={choiceCard(selectedAuthMode === 'required')} onclick={() => (selectedAuthMode = 'required')}>
							<div class="flex items-start gap-3">
								<Icon name="lucide:smartphone" class="w-5 h-5 mt-0.5 shrink-0 {selectedAuthMode === 'required' ? 'text-violet-600 dark:text-violet-400' : 'text-slate-400'}" />
								<div class="flex-1 min-w-0">
									<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">My other devices too</div>
									<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Use it from your phone. Protected by a sign-in key.</div>
								</div>
								{#if selectedAuthMode === 'required'}<Icon name="lucide:circle-check" class="w-5 h-5 shrink-0 text-violet-500" />{/if}
							</div>
						</button>
					</div>
					{#if accessError}<p class="text-sm text-red-500">{accessError}</p>{/if}
					<button onclick={confirmAccess} disabled={accessLoading} class={primaryButton}>
						{#if accessLoading}<span class="inline-flex items-center gap-2"><Icon name="lucide:loader" class="w-4 h-4 animate-spin" />Setting up…</span>{:else}Continue{/if}
					</button>
				</div>

			{:else if currentStep === 'access'}
				<!-- The sign-in key, once -->
				<div class="space-y-4">
					<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Save your sign-in key</h2>
					<div class="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-left">
						<p class="text-xs text-amber-700 dark:text-amber-300 mb-3">Shown only once. Keep it in a password manager.</p>
						<div class="flex items-center gap-2">
							<code class="flex-1 px-3 py-2 rounded bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-700 text-xs font-mono text-slate-900 dark:text-slate-100 select-all break-all">{authStore.personalAccessToken}</code>
							<button onclick={copyKey} class="shrink-0 px-3 py-2 rounded bg-amber-100 dark:bg-amber-900 hover:bg-amber-200 dark:hover:bg-amber-800 text-amber-800 dark:text-amber-200 text-xs font-medium transition-colors">{keyCopied ? 'Copied!' : 'Copy'}</button>
						</div>
						{#if keyCopyFailed}<p class="text-xs text-red-600 dark:text-red-400 mt-2">Couldn't copy. Select the key and copy it by hand.</p>{/if}
						<p class="text-xs text-amber-600 dark:text-amber-400 mt-3">
							Lost it? Run <code class="font-mono font-semibold text-amber-900 dark:text-amber-100 bg-amber-200/70 dark:bg-amber-800/60 px-1.5 py-0.5 rounded">clopen reset-pat</code>.
						</p>
					</div>
					<label class="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer text-left">
						<input type="checkbox" bind:checked={keySaved} class="w-4 h-4 accent-violet-600" />
						I've saved it
					</label>
					<button onclick={() => { showKey = false; next(); }} disabled={!keySaved} class={primaryButton}>Continue</button>
				</div>

			<!-- ════════ 2. AI ════════ -->
			{:else if currentStep === 'ai'}
				<div class="space-y-4 text-left">
					<div class="text-center">
						<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-1">The AI behind Clopen</h2>
						<p class="text-sm text-slate-500 dark:text-slate-400">OpenCode is free and installs itself. Add an API key or another agent anytime.</p>
					</div>
					<!-- OpenCode first: free, installing in the background, its panel takes an API key. -->
					<AIEnginesSettings showHeader={false} compact />
					<div class={footer}>
						<button onclick={back} class={backButton}>Back</button>
						<button onclick={next} class="flex-1 py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors">Continue</button>
					</div>
				</div>

			<!-- ════════ 3. Preferences ════════ -->
			{:else}
				<div class="space-y-4 text-left">
					<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 text-center">A few preferences</h2>
					<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 divide-y divide-slate-200 dark:divide-slate-700/50">
						<div class="flex items-center gap-3 p-3.5">
							<Icon name="lucide:messages-square" class="w-4 h-4 text-violet-500 shrink-0" />
							<div class="flex-1">
								<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Ask me before acting</div>
								<div class="text-xs text-slate-500 dark:text-slate-400">Off: Clopen just gets it done.</div>
							</div>
							{@render toggle(askFirst, () => (askFirst = !askFirst), 'Ask me before acting')}
						</div>
						{#if autostart?.supported}
							<div class="flex items-center gap-3 p-3.5">
								<Icon name="lucide:power" class="w-4 h-4 text-violet-500 shrink-0" />
								<div class="flex-1">
									<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Start with this computer</div>
									<div class="text-xs text-slate-500 dark:text-slate-400">Automations keep running after a restart.</div>
								</div>
								{@render toggle(wantAutostart, () => (wantAutostart = !wantAutostart), 'Start with this computer')}
							</div>
						{/if}
						<div class="flex items-center gap-3 p-3.5">
							<Icon name={themeStore.isDark ? 'lucide:moon' : 'lucide:sun'} class="w-4 h-4 text-violet-500 shrink-0" />
							<div class="flex-1">
								<div class="text-sm font-medium text-slate-900 dark:text-slate-100">Dark mode</div>
							</div>
							{@render toggle(themeStore.isDark, toggleDarkMode, 'Dark mode')}
						</div>
					</div>
					{#if finishError}<p class="text-sm text-red-500">{finishError}</p>{/if}
					<div class={footer}>
						<button onclick={back} class={backButton}>Back</button>
						<button onclick={finish} disabled={finishLoading} class="flex-1 py-2.5 px-4 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium transition-colors disabled:opacity-50">
							{finishLoading ? 'Opening…' : 'Open Clopen'}
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
	</div>
</div>

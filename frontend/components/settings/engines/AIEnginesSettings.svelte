<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$frontend/app-environment';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { ENGINES } from '$shared/constants/engines';
	import { claudeAccountsStore, type ClaudeAccountItem as ClaudeCodeAccountItem } from '$frontend/stores/features/claude-accounts.svelte';
	import { opencodeProvidersStore, type OpenCodeProviderItem, type ModelsDevProviderItem } from '$frontend/stores/features/opencode-providers.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';

	const claudeCodeEngine = ENGINES.find(e => e.type === 'claude-code')!;
	const openCodeEngine = ENGINES.find(e => e.type === 'opencode')!;

	interface ClaudeCodeStatus {
		installed: boolean;
		version: string | null;
		activeAccount: { id: number; name: string } | null;
		accountsCount: number;
		backendOS: 'windows' | 'macos' | 'linux';
	}

	interface OpenCodeStatus {
		installed: boolean;
		version: string | null;
		backendOS: 'windows' | 'macos' | 'linux';
	}

	let claudeCodeStatus = $state<ClaudeCodeStatus | null>(null);
	let isLoadingClaudeCodeStatus = $state(true);
	const claudeCodeAccounts = $derived(claudeAccountsStore.accounts);

	// OpenCode state
	let openCodeStatus = $state<OpenCodeStatus | null>(null);
	let isLoadingOpenCodeStatus = $state(true);

	// Add account flow
	type ClaudeCodeSetupStep = 'idle' | 'loading-url' | 'waiting-code' | 'submitting' | 'success' | 'error';
	let claudeCodeSetupStep = $state<ClaudeCodeSetupStep>('idle');
	let claudeCodeSetupId = $state<string | null>(null);
	let claudeCodeAuthUrl = $state<string | null>(null);
	let claudeCodeAuthCode = $state('');
	let claudeCodeAccountName = $state('');
	let claudeCodeSetupError = $state('');

	// Install guide - Claude Code
	type ClaudeCodeInstallTab = 'unix' | 'powershell';
	let activeClaudeCodeInstallTab = $state<ClaudeCodeInstallTab>('unix');

	// Install guide - OpenCode
	type OpenCodeInstallTab = 'unix' | 'bun';
	let activeOpenCodeInstallTab = $state<OpenCodeInstallTab>('unix');

	// Rename
	let claudeCodeRenamingId = $state<number | null>(null);
	let claudeCodeRenameValue = $state('');

	// Delete confirmation dialog
	let claudeCodeDeleteDialogOpen = $state(false);
	let claudeCodeDeleteTargetId = $state<number | null>(null);

	// Copy URL feedback
	let claudeCodeUrlCopied = $state(false);
	let claudeCodeUrlCopiedTimer: ReturnType<typeof setTimeout> | null = null;

	// Copy command feedback
	let claudeCodeCommandCopied = $state(false);
	let claudeCodeCommandCopiedTimer: ReturnType<typeof setTimeout> | null = null;

	// Copy command feedback - OpenCode
	let openCodeCommandCopied = $state(false);
	let openCodeCommandCopiedTimer: ReturnType<typeof setTimeout> | null = null;

	// OpenCode provider management
	const ocProviders = $derived(opencodeProvidersStore.providers);
	const ocCatalog = $derived(opencodeProvidersStore.catalog);

	// Add provider flow
	type OCAddStep = 'idle' | 'picking' | 'configuring' | 'saving' | 'success' | 'error';
	let ocAddStep = $state<OCAddStep>('idle');
	let ocAddError = $state('');
	let ocCatalogSearch = $state('');
	let ocSelectedCatalogProvider = $state<ModelsDevProviderItem | null>(null);
	let ocAddAccountName = $state('');
	let ocAddApiKey = $state('');
	let ocAddOptions = $state<Record<string, string>>({});
	let ocCatalogRefreshing = $state(false);

	// Provider account management
	let ocRenamingAccountId = $state<number | null>(null);
	let ocRenameValue = $state('');
	let ocAddingAccountForProvider = $state<number | null>(null);
	let ocNewAccountName = $state('');
	let ocNewAccountApiKey = $state('');

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

	// Debug PTY (xterm.js)
	const showDebug = $state(false);
	let debugTermContainer = $state<HTMLDivElement>();
	let debugTerminal: Terminal | null = null;
	let debugFitAddon: FitAddon | null = null;
	let debugTermReady = $state(false);
	let ptyPhase = $state('');
	let ptyBufferLen = $state(0);
	let hasPtyData = $state(false);

	// Event listener cleanup functions
	const cleanups: Array<() => void> = [];

	const claudeCodeInstallCommands: Record<ClaudeCodeInstallTab, { label: string; command: string }> = {
		unix: { label: 'macOS / Linux / WSL', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
		powershell: { label: 'Windows PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' },
	};

	const openCodeInstallCommands: Record<OpenCodeInstallTab, { label: string; command: string }> = {
		unix: { label: 'macOS / Linux / WSL', command: 'curl -fsSL https://opencode.ai/install | bash' },
		bun: { label: 'Bun', command: 'bun add -g opencode-ai' },
	};

	async function initDebugTerminal() {
		if (!browser || !debugTermContainer || debugTerminal) return;

		const [{ Terminal }, { FitAddon }] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit')
		]);

		await import('@xterm/xterm/css/xterm.css');

		debugTerminal = new Terminal({
			theme: {
				background: '#0f172a',
				foreground: '#e2e8f0',
				cursor: '#22c55e',
				black: '#18181b',
				red: '#ef4444',
				green: '#22c55e',
				yellow: '#eab308',
				blue: '#60a5fa',
				magenta: '#a855f7',
				cyan: '#06b6d4',
				white: '#f4f4f5',
				brightBlack: '#52525b',
				brightRed: '#f87171',
				brightGreen: '#4ade80',
				brightYellow: '#facc15',
				brightBlue: '#60a5fa',
				brightMagenta: '#c084fc',
				brightCyan: '#22d3ee',
				brightWhite: '#ffffff'
			},
			fontSize: 11,
			fontFamily: 'JetBrains Mono, Monaco, "Cascadia Code", Consolas, monospace',
			lineHeight: 1.1,
			cursorBlink: false,
			cursorStyle: 'underline' as const,
			convertEol: true,
			scrollback: 5000,
			disableStdin: true,
			allowTransparency: false,
			cols: 120,
			rows: 20
		});

		debugFitAddon = new FitAddon();
		debugTerminal.loadAddon(debugFitAddon);
		debugTerminal.open(debugTermContainer);
		debugFitAddon.fit();
		debugTermReady = true;
	}

	function disposeDebugTerminal() {
		if (debugTerminal) {
			debugTerminal.dispose();
			debugTerminal = null;
			debugFitAddon = null;
			debugTermReady = false;
		}
	}

	onMount(async () => {
		// Listen for setup events from backend
		cleanups.push(
			ws.on('engine:claude-account-setup-url', (data: { setupId: string; authUrl: string }) => {
				claudeCodeSetupId = data.setupId;
				claudeCodeAuthUrl = data.authUrl;
				claudeCodeSetupStep = 'waiting-code';
			}),
			ws.on('engine:claude-account-setup-complete', async (_data: { setupId: string; accountId: number }) => {
				claudeCodeSetupStep = 'success';
				await refreshClaudeCodeAccounts();
			}),
			ws.on('engine:claude-account-setup-error', (data: { setupId: string; message: string }) => {
				claudeCodeSetupError = data.message;
				claudeCodeSetupStep = 'error';
			}),
			ws.on('engine:claude-account-setup-pty-data', (data: { setupId: string; data: string; phase: string; bufferLength: number }) => {
				hasPtyData = true;
				ptyPhase = data.phase;
				ptyBufferLen = data.bufferLength;
				// Write raw data to xterm.js — it handles ANSI natively
				if (debugTerminal) {
					debugTerminal.write(data.data);
				}
			})
		);

		await Promise.all([refreshClaudeCodeStatus(), refreshOpenCodeStatus()]);
	});

	onDestroy(() => {
		// Cleanup all event listeners
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;

		// Dispose debug terminal
		disposeDebugTerminal();

		// Cancel any running setup
		if (claudeCodeSetupId && claudeCodeSetupStep !== 'idle' && claudeCodeSetupStep !== 'success' && claudeCodeSetupStep !== 'error') {
			ws.emit('engine:claude-account-setup-cancel', { setupId: claudeCodeSetupId });
		}
	});

	// Init debug terminal when container is available
	$effect(() => {
		if (debugTermContainer && !debugTerminal && showDebug) {
			initDebugTerminal();
		}
	});

	// Fit debug terminal on resize
	$effect(() => {
		if (debugTermReady && debugFitAddon && debugTermContainer) {
			const observer = new ResizeObserver(() => {
				debugFitAddon?.fit();
			});
			observer.observe(debugTermContainer);
			return () => observer.disconnect();
		}
	});

	async function refreshClaudeCodeStatus() {
		isLoadingClaudeCodeStatus = true;
		try {
			claudeCodeStatus = await ws.http('engine:claude-status', {});

			if (claudeCodeStatus) {
				activeClaudeCodeInstallTab = claudeCodeStatus.backendOS === 'windows' ? 'powershell' : 'unix';
			}

			if (claudeCodeStatus?.installed) {
				await refreshClaudeCodeAccounts();
			}
		} catch {
			claudeCodeStatus = null;
		}
		isLoadingClaudeCodeStatus = false;
	}

	async function refreshClaudeCodeAccounts() {
		await claudeAccountsStore.refresh();
	}

	function startClaudeCodeSetup() {
		claudeCodeSetupStep = 'loading-url';
		claudeCodeSetupError = '';
		claudeCodeAuthCode = '';
		claudeCodeAccountName = '';
		ptyPhase = '';
		ptyBufferLen = 0;
		hasPtyData = false;
		// Clear debug terminal
		if (debugTerminal) {
			debugTerminal.clear();
			debugTerminal.reset();
		}

		// Fire-and-forget: server will emit 'setup-url' or 'setup-error' back
		ws.emit('engine:claude-account-setup-start', {});
	}

	function submitClaudeCodeAuth() {
		if (!claudeCodeSetupId || !claudeCodeAuthCode.trim() || !claudeCodeAccountName.trim()) return;

		claudeCodeSetupStep = 'submitting';
		claudeCodeSetupError = '';

		// Fire-and-forget: server will emit 'setup-complete' or 'setup-error' back
		ws.emit('engine:claude-account-setup-submit', {
			setupId: claudeCodeSetupId,
			code: claudeCodeAuthCode.trim(),
			name: claudeCodeAccountName.trim()
		});
	}

	function cancelClaudeCodeSetup() {
		if (claudeCodeSetupId) {
			ws.emit('engine:claude-account-setup-cancel', { setupId: claudeCodeSetupId });
		}
		resetClaudeCodeSetup();
	}

	function resetClaudeCodeSetup() {
		claudeCodeSetupStep = 'idle';
		claudeCodeSetupId = null;
		claudeCodeAuthUrl = null;
		claudeCodeAuthCode = '';
		claudeCodeAccountName = '';
		claudeCodeSetupError = '';
	}

	async function switchClaudeCodeAccount(id: number) {
		try {
			await ws.http('engine:claude-accounts-switch', { id });
			await refreshClaudeCodeAccounts();
		} catch {
			// Ignore
		}
	}

	function confirmDeleteClaudeCodeAccount(id: number) {
		claudeCodeDeleteTargetId = id;
		claudeCodeDeleteDialogOpen = true;
	}

	async function deleteClaudeCodeAccount() {
		if (claudeCodeDeleteTargetId === null) return;
		try {
			await ws.http('engine:claude-accounts-delete', { id: claudeCodeDeleteTargetId });
			await refreshClaudeCodeAccounts();
		} catch {
			// Ignore
		}
	}

	function startClaudeCodeRename(account: ClaudeCodeAccountItem) {
		claudeCodeRenamingId = account.id;
		claudeCodeRenameValue = account.name;
	}

	async function submitClaudeCodeRename() {
		if (claudeCodeRenamingId === null || !claudeCodeRenameValue.trim()) return;

		try {
			await ws.http('engine:claude-accounts-rename', { id: claudeCodeRenamingId, name: claudeCodeRenameValue.trim() });
			claudeCodeRenamingId = null;
			claudeCodeRenameValue = '';
			await refreshClaudeCodeAccounts();
		} catch {
			// Ignore
		}
	}

	function cancelClaudeCodeRename() {
		claudeCodeRenamingId = null;
		claudeCodeRenameValue = '';
	}

	async function refreshOpenCodeStatus() {
		isLoadingOpenCodeStatus = true;
		try {
			openCodeStatus = await ws.http('engine:opencode-status', {});

			if (openCodeStatus) {
				// On Windows, default to bun since quick install requires WSL
				activeOpenCodeInstallTab = openCodeStatus.backendOS === 'windows' ? 'bun' : 'unix';
			}
		} catch {
			openCodeStatus = null;
		}
		isLoadingOpenCodeStatus = false;

		if (openCodeStatus?.installed) {
			await opencodeProvidersStore.fetchProviders();
			await opencodeProvidersStore.fetchCatalog();
		}
	}

	// ── OpenCode Provider Management ──

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
			// Build options JSON from the key-value pairs (excluding apiKey which is separate)
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

	// Get env var label for a provider by looking it up in the catalog
	function getProviderEnvLabel(slug: string): string {
		const catalogEntry = ocCatalog.find(c => c.id === slug);
		return catalogEntry?.env?.[0] || 'API Key';
	}

	// Account CRUD within a provider
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

	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Fallback
		}
	}

	async function copyClaudeCodeCommand() {
		await copyToClipboard(claudeCodeInstallCommands[activeClaudeCodeInstallTab].command);
		claudeCodeCommandCopied = true;
		if (claudeCodeCommandCopiedTimer) clearTimeout(claudeCodeCommandCopiedTimer);
		claudeCodeCommandCopiedTimer = setTimeout(() => { claudeCodeCommandCopied = false; }, 2000);
	}

	async function copyOpenCodeCommand() {
		await copyToClipboard(openCodeInstallCommands[activeOpenCodeInstallTab].command);
		openCodeCommandCopied = true;
		if (openCodeCommandCopiedTimer) clearTimeout(openCodeCommandCopiedTimer);
		openCodeCommandCopiedTimer = setTimeout(() => { openCodeCommandCopied = false; }, 2000);
	}

	async function copyClaudeCodeAuthUrl() {
		if (!claudeCodeAuthUrl) return;
		await copyToClipboard(claudeCodeAuthUrl);
		claudeCodeUrlCopied = true;
		if (claudeCodeUrlCopiedTimer) clearTimeout(claudeCodeUrlCopiedTimer);
		claudeCodeUrlCopiedTimer = setTimeout(() => { claudeCodeUrlCopied = false; }, 2000);
	}
</script>

<div class="space-y-6">
	<!-- Header -->
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Engines</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-4">
		Manage engine installations and accounts
	</p>

	<!-- Claude Code Card -->
	<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
		<!-- Card Header -->
		<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
			<div class="flex items-center gap-3">
				<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
					{@html isDarkMode() ? claudeCodeEngine.icon.dark : claudeCodeEngine.icon.light}
				</div>
				<div>
					<h3 class="font-semibold text-slate-900 dark:text-slate-100">{claudeCodeEngine.name}</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400">{claudeCodeEngine.description}</p>
				</div>
			</div>

			{#if isLoadingClaudeCodeStatus}
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
					<Icon name="lucide:loader" class="w-3 h-3 animate-spin" />
					Checking...
				</span>
			{:else if claudeCodeStatus?.installed}
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
					<span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
					Installed
				</span>
			{:else}
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
					<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
					Not Installed
				</span>
			{/if}
		</div>

		<!-- Card Body -->
		<div class="px-5 py-4">
			{#if isLoadingClaudeCodeStatus}
				<div class="flex items-center justify-center py-8">
					<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
				</div>
			{:else if claudeCodeStatus && !claudeCodeStatus.installed}
				<!-- Install Guide -->
				<div class="space-y-4">
					<p class="text-sm text-slate-600 dark:text-slate-300">
						Claude Code is not installed on this system. Install it using one of the methods below:
					</p>

					<!-- Tab Buttons -->
					<div class="flex flex-wrap gap-1.5">
						{#each Object.entries(claudeCodeInstallCommands) as [key, { label }]}
							<button
								type="button"
								class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
									{activeClaudeCodeInstallTab === key
									? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
									: 'bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
								onclick={() => (activeClaudeCodeInstallTab = key as ClaudeCodeInstallTab)}
							>
								{label}
							</button>
						{/each}
					</div>

					<!-- Command Block -->
					<div class="relative group">
						<pre class="bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200 rounded-lg px-4 py-3 text-sm font-mono overflow-x-auto">{claudeCodeInstallCommands[activeClaudeCodeInstallTab].command}</pre>
						<button
							type="button"
							class="flex absolute top-2 right-2 p-1.5 rounded-md transition-colors {claudeCodeCommandCopied ? 'bg-violet-600/80 text-white' : 'bg-slate-300/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-slate-400/80 dark:hover:bg-slate-600'}"
							onclick={copyClaudeCodeCommand}
							aria-label="Copy command"
						>
							<Icon name={claudeCodeCommandCopied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
						</button>
					</div>

					<!-- Windows Git Bash note -->
					{#if claudeCodeStatus.backendOS === 'windows'}
						<div class="flex gap-2.5 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-700/50">
							<Icon name="lucide:info" class="w-4 h-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
							<div class="text-sm text-amber-800 dark:text-amber-300 space-y-1">
								<p class="font-medium">Git Bash is required</p>
								<p class="text-xs text-amber-700 dark:text-amber-400">
									Claude Code requires Git Bash to run on Windows. If you haven't installed it yet, download and install it first:
								</p>
								<a
									href="https://git-scm.com/install/windows"
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 underline underline-offset-2"
								>
									https://git-scm.com/install/windows
								</a>
							</div>
						</div>
					{/if}

					<!-- More info link -->
					<div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
						<Icon name="lucide:book-open" class="w-3.5 h-3.5 shrink-0" />
						<div>
							<span>For complete installation instructions, visit the</span>
							<a
								href="https://code.claude.com/docs/en/quickstart"
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 font-medium text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 underline underline-offset-2"
							>
								official documentation
							</a>
						</div>
					</div>

					<button
						type="button"
						class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors"
						onclick={refreshClaudeCodeStatus}
					>
						<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						Recheck Installation
					</button>
				</div>
			{:else if claudeCodeStatus}
				<!-- Installed View -->
				<div class="space-y-5">
					<!-- Version -->
					<div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
						<Icon name="lucide:tag" class="w-4 h-4 text-slate-400" />
						<span>Version: <span class="font-mono font-medium text-slate-900 dark:text-slate-100">{claudeCodeStatus.version || 'Unknown'}</span></span>
					</div>

					<!-- Providers Section (2-level display: Provider → Accounts) -->
					<div class="space-y-3">
						<div class="flex items-center justify-between">
							<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Providers</h4>
							<span class="text-xs text-slate-500">1 provider</span>
						</div>

						<!-- Anthropic provider (pre-seeded, no delete/add-provider buttons) -->
						<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
							<!-- Provider header -->
							<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
								<div class="flex items-center gap-2 min-w-0">
									<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">Anthropic</span>
									<span class="text-2xs text-slate-400 font-mono">anthropic</span>
									<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
								</div>
							</div>

							<!-- Accounts list -->
							<div class="px-3.5 py-2.5 space-y-2">
								{#if claudeCodeAccounts.length === 0}
									<p class="text-xs text-slate-500 italic">No accounts</p>
								{:else}
									{#each claudeCodeAccounts as account (account.id)}
										<div class="flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
											<div class="w-full flex items-center gap-2.5 min-w-0">
												<Icon name="lucide:user" class="w-4 h-4 shrink-0 text-slate-400" />
												{#if claudeCodeRenamingId === account.id}
													<div class="w-full flex items-center gap-2.5">
														<input
															type="text"
															bind:value={claudeCodeRenameValue}
															class="w-full px-2 py-0.5 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
														/>
														<div class="flex items-center gap-1">
															<button
																type="button"
																class="flex p-1.5 rounded-md text-slate-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
																onclick={submitClaudeCodeRename}
																aria-label="Save"
															>
																<Icon name="lucide:check" class="w-3.5 h-3.5" />
															</button>
															<button
																type="button"
																class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
																onclick={cancelClaudeCodeRename}
																aria-label="Cancel"
															>
																<Icon name="lucide:x" class="w-3.5 h-3.5" />
															</button>
														</div>
													</div>
												{:else}
													<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
													{#if account.isActive}
														<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">
															Active
														</span>
													{/if}
												{/if}
											</div>

											{#if claudeCodeRenamingId !== account.id}
												<div class="flex items-center gap-1">
													{#if !account.isActive}
														<button
															type="button"
															class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors"
															onclick={() => switchClaudeCodeAccount(account.id)}
															title="Switch to this account"
														>
															<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
														</button>
													{/if}
													<button
														type="button"
														class="flex p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
														onclick={() => startClaudeCodeRename(account)}
														title="Rename"
													>
														<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
													</button>
													<button
														type="button"
														class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
														onclick={() => confirmDeleteClaudeCodeAccount(account.id)}
														title="Delete account"
													>
														<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
													</button>
												</div>
											{/if}
										</div>
									{/each}
								{/if}

								<!-- Add Account Flow -->
								<div class="pt-1">
							{#if claudeCodeSetupStep === 'idle'}
								<button
									type="button"
									class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center"
									onclick={startClaudeCodeSetup}
								>
									<Icon name="lucide:plus" class="w-4 h-4" />
									Add Account
								</button>
							{:else if claudeCodeSetupStep === 'loading-url'}
								<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
									<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
										<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
										<span>Starting authentication process...</span>
									</div>
								</div>
							{:else if claudeCodeSetupStep === 'waiting-code'}
								<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
									<!-- Step indicator -->
									<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
										<Icon name="lucide:key" class="w-3.5 h-3.5" />
										Step 1: Authenticate via browser
									</div>

									<p class="text-sm text-slate-600 dark:text-slate-400">
										Open the URL below in your browser, complete the sign-in, then copy the authentication code back here.
									</p>

									<!-- Auth URL -->
									<div>
										<div class="bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 dark:text-slate-300 break-all border border-slate-200 dark:border-slate-700">
											{claudeCodeAuthUrl}
										</div>
										<div class="flex gap-2 mt-2">
											<button
												type="button"
												class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
													{claudeCodeUrlCopied
													? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
													: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'}"
												onclick={copyClaudeCodeAuthUrl}
											>
												{#if claudeCodeUrlCopied}
													<Icon name="lucide:check" class="w-3 h-3" />
													Copied
												{:else}
													<Icon name="lucide:copy" class="w-3 h-3" />
													Copy URL
												{/if}
											</button>
											<a
												href={claudeCodeAuthUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-800/40 transition-colors"
											>
												<Icon name="lucide:external-link" class="w-3 h-3" />
												Open in Browser
											</a>
										</div>
									</div>

									<!-- Divider -->
									<div class="border-t border-slate-200 dark:border-slate-700/50"></div>

									<!-- Step 2 -->
									<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
										<Icon name="lucide:clipboard-paste" class="w-3.5 h-3.5" />
										Step 2: Paste the code and name your account
									</div>

									<div class="space-y-2">
										<input
											type="text"
											bind:value={claudeCodeAuthCode}
											placeholder="Paste authentication code here"
											class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
										/>
										<input
											type="text"
											bind:value={claudeCodeAccountName}
											placeholder="Account name (e.g. Personal, Work)"
											class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
										/>
									</div>

									<!-- Actions -->
									<div class="flex gap-2">
										<button
											type="button"
											class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
											onclick={submitClaudeCodeAuth}
											disabled={!claudeCodeAuthCode.trim() || !claudeCodeAccountName.trim()}
										>
											<Icon name="lucide:send" class="w-4 h-4" />
											Submit
										</button>
										<button
											type="button"
											class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
											onclick={cancelClaudeCodeSetup}
										>
											Cancel
										</button>
									</div>

									<p class="text-2xs text-slate-400 dark:text-slate-500">
										A background process is running. It will auto-close in 5 minutes if not completed.
									</p>
								</div>
							{:else if claudeCodeSetupStep === 'submitting'}
								<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
									<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
										<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
										<span>Verifying code and retrieving token...</span>
									</div>
								</div>
							{:else if claudeCodeSetupStep === 'success'}
								<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
									<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
									<span class="text-sm text-green-700 dark:text-green-300">Account added successfully!</span>
									<button
										type="button"
										class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline"
										onclick={resetClaudeCodeSetup}
									>
										Dismiss
									</button>
								</div>
							{:else if claudeCodeSetupStep === 'error'}
								<div class="space-y-3">
									<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
										<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
										<span class="text-sm text-red-700 dark:text-red-300">{claudeCodeSetupError}</span>
									</div>
									<button
										type="button"
										class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
										onclick={resetClaudeCodeSetup}
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

	<!-- Debug PTY Output (xterm.js) -->
	{#if showDebug && (hasPtyData || claudeCodeSetupStep !== 'idle')}
		<div class="rounded-xl border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10 overflow-hidden">
			<div class="flex items-center justify-between px-4 py-2 border-b border-amber-200 dark:border-amber-700/50">
				<div class="flex items-center gap-2">
					<Icon name="lucide:bug" class="w-4 h-4 text-amber-600" />
					<span class="text-xs font-semibold text-amber-700 dark:text-amber-300">Debug: PTY Output</span>
					<span class="text-3xs font-mono px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200">
						phase={ptyPhase} | buf={ptyBufferLen} | step={claudeCodeSetupStep}
					</span>
				</div>
				<button
					type="button"
					class="text-xs text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
					onclick={() => { if (debugTerminal) { debugTerminal.clear(); debugTerminal.reset(); } hasPtyData = false; }}
				>
					Clear
				</button>
			</div>
			<div
				bind:this={debugTermContainer}
				class="h-80 bg-[#0f172a]"
			></div>
		</div>
	{/if}

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

			{#if isLoadingOpenCodeStatus}
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
					<Icon name="lucide:loader" class="w-3 h-3 animate-spin" />
					Checking...
				</span>
			{:else if openCodeStatus?.installed}
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
					<span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
					Installed
				</span>
			{:else}
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">
					<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
					Not Installed
				</span>
			{/if}
		</div>

		<!-- Card Body -->
		<div class="px-5 py-4">
			{#if isLoadingOpenCodeStatus}
				<div class="flex items-center justify-center py-8">
					<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
				</div>
			{:else if openCodeStatus && !openCodeStatus.installed}
				<!-- Install Guide -->
				<div class="space-y-4">
					<p class="text-sm text-slate-600 dark:text-slate-300">
						Open Code is not installed on this system. Install it using one of the methods below:
					</p>

					<!-- Tab Buttons -->
					<div class="flex flex-wrap gap-1.5">
						{#each Object.entries(openCodeInstallCommands) as [key, { label }]}
							<button
								type="button"
								class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
									{activeOpenCodeInstallTab === key
									? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
									: 'bg-slate-100 dark:bg-slate-700/50 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
								onclick={() => (activeOpenCodeInstallTab = key as OpenCodeInstallTab)}
							>
								{label}
							</button>
						{/each}
					</div>

					<!-- Command Block -->
					<div class="relative group">
						<pre class="bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-200 rounded-lg px-4 py-3 text-sm font-mono overflow-x-auto">{openCodeInstallCommands[activeOpenCodeInstallTab].command}</pre>
						<button
							type="button"
							class="flex absolute top-2 right-2 p-1.5 rounded-md transition-colors {openCodeCommandCopied ? 'bg-violet-600/80 text-white' : 'bg-slate-300/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-slate-400/80 dark:hover:bg-slate-600'}"
							onclick={copyOpenCodeCommand}
							aria-label="Copy command"
						>
							<Icon name={openCodeCommandCopied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
						</button>
					</div>

					<!-- More info link -->
					<div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
						<Icon name="lucide:book-open" class="w-3.5 h-3.5 shrink-0" />
						<div>
							<span>For complete installation instructions, visit the</span>
							<a
								href="https://opencode.ai/docs"
								target="_blank"
								rel="noopener noreferrer"
								class="inline-flex items-center gap-1 font-medium text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-200 underline underline-offset-2"
							>
								official documentation
							</a>
						</div>
					</div>

					<button
						type="button"
						class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors"
						onclick={refreshOpenCodeStatus}
					>
						<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						Recheck Installation
					</button>
				</div>
			{:else if openCodeStatus}
				<!-- Installed View -->
				<div class="space-y-5">
					<!-- Version + Restart Server -->
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
							<Icon name="lucide:tag" class="w-4 h-4 text-slate-400" />
							<span>Version: <span class="font-mono font-medium text-slate-900 dark:text-slate-100">{openCodeStatus.version || 'Unknown'}</span></span>
						</div>
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
					</div>

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

						{#each ocProviders as provider (provider.id)}
							<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
								<!-- Provider header -->
								<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
									<div class="flex items-center gap-2 min-w-0">
										<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{provider.name}</span>
										<span class="text-2xs text-slate-400 font-mono">{provider.slug}</span>
										{#if !provider.isEnabled}
											<span class="px-1.5 py-0.5 text-3xs rounded bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">Disabled</span>
										{/if}
									</div>
									<div class="flex items-center gap-1">
										<button
											type="button"
											class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
											onclick={() => confirmDeleteOCProvider(provider)}
											title="Remove provider"
										>
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									</div>
								</div>

								<!-- Accounts list -->
								<div class="px-3.5 py-2.5 space-y-2">
									{#if provider.accounts.length === 0}
										<p class="text-xs text-slate-500 italic">No accounts</p>
									{:else}
										{#each provider.accounts as account (account.id)}
											<div class="flex items-center justify-between px-3.5 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
												<div class="w-full flex items-center gap-2.5 min-w-0">
													<Icon name="lucide:key" class="w-4 h-4 shrink-0 text-slate-400" />
													{#if ocRenamingAccountId === account.id}
														<div class="w-full flex items-center gap-2.5">
															<input
																type="text"
																bind:value={ocRenameValue}
																class="w-full px-2 py-0.5 text-sm rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
															/>
															<div class="flex items-center gap-1">
																<button
																	type="button"
																	class="flex p-1.5 rounded-md text-slate-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
																	onclick={submitOCRename}
																	aria-label="Save"
																>
																	<Icon name="lucide:check" class="w-3.5 h-3.5" />
																</button>
																<button
																	type="button"
																	class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
																	onclick={cancelOCRename}
																	aria-label="Cancel"
																>
																	<Icon name="lucide:x" class="w-3.5 h-3.5" />
																</button>
															</div>
														</div>
													{:else}
														<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
														{#if account.isActive}
															<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
														{/if}
													{/if}
												</div>

												{#if ocRenamingAccountId !== account.id}
													<div class="flex items-center gap-1">
														{#if !account.isActive}
															<button
																type="button"
																class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors"
																onclick={() => switchOCAccount(account.id)}
																title="Switch to this account"
															>
																<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
															</button>
														{/if}
														<button
															type="button"
															class="flex p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
															onclick={() => startOCRename(account.id, account.name)}
															title="Rename"
														>
															<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
														</button>
														<button
															type="button"
															class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
															onclick={() => confirmDeleteOCAccount(account.id, account.name)}
															title="Delete"
														>
															<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
														</button>
													</div>
												{/if}
											</div>
										{/each}
									{/if}

									<!-- Add account inline -->
									{#if ocAddingAccountForProvider === provider.id}
										<div class="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-700/50">
											<input type="text" bind:value={ocNewAccountName} placeholder="Account name (e.g. Personal, Work)" class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500" />
											<input type="text" bind:value={ocNewAccountApiKey} placeholder={getProviderEnvLabel(provider.slug)} class="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500 font-mono" />
											<div class="flex gap-2">
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
														<span class="text-2xs text-slate-400 font-mono ml-2">{cp.id}</span>
													</div>
													<Icon name="lucide:chevron-right" class="w-3.5 h-3.5 text-slate-400" />
												</button>
											{/each}
										{/if}
									</div>

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
</div>

<Dialog
	bind:isOpen={claudeCodeDeleteDialogOpen}
	onClose={() => { claudeCodeDeleteDialogOpen = false; claudeCodeDeleteTargetId = null; }}
	type="error"
	title="Delete Account"
	message="Are you sure you want to delete this account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteClaudeCodeAccount}
/>

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

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$frontend/app-environment';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { debug } from '$shared/utils/logger';
	import { setActiveSection, settingsModalState, clearEngineFocus } from '$frontend/stores/ui/settings-modal.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType, QwenProviderPresetId } from '$shared/types/unified';

	interface Props {
		showHeader?: boolean;
		compact?: boolean;
	}
	const { showHeader = true, compact = false }: Props = $props();

	let activeEngine = $state<EngineType>(settingsModalState.engineFocus ?? 'claude-code');

	// Consume engineFocus deep-link requests (set when other settings pages
	// route the user here, e.g. EngineModelPicker's "Go to Engines" button).
	$effect(() => {
		if (settingsModalState.engineFocus) {
			activeEngine = settingsModalState.engineFocus;
			clearEngineFocus();
		}
	});
	import { claudeAccountsStore, type ClaudeAccountItem as ClaudeCodeAccountItem } from '$frontend/stores/features/claude-accounts.svelte';
	import { copilotAccountsStore, type CopilotAccountItem } from '$frontend/stores/features/copilot-accounts.svelte';
	import { codexAccountsStore, type CodexAccountItem } from '$frontend/stores/features/codex-accounts.svelte';
	import { qwenAccountsStore, type QwenAccountItem } from '$frontend/stores/features/qwen-accounts.svelte';
	import { qwenPresetsStore } from '$frontend/stores/features/qwen-presets.svelte';
	import { piAccountsStore, type PiAccountItem } from '$frontend/stores/features/pi-accounts.svelte';
	import { piPresetsStore } from '$frontend/stores/features/pi-presets.svelte';
	import { opencodeProvidersStore, type OpenCodeProviderItem, type OpenCodeAccountItem, type ModelsDevProviderItem } from '$frontend/stores/features/opencode-providers.svelte';
	import AccountEditForm from './AccountEditForm.svelte';
	import AccountField from './AccountField.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { settings, togglePinnedModel } from '$frontend/stores/features/settings.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';
	import type { TerminalViewerHandle } from '@myrialabs/ptykit/client';

	const claudeCodeEngine = ENGINES.find(e => e.type === 'claude-code')!;
	const openCodeEngine = ENGINES.find(e => e.type === 'opencode')!;
	const copilotEngine = ENGINES.find(e => e.type === 'copilot')!;
	const codexEngine = ENGINES.find(e => e.type === 'codex')!;
	const qwenEngine = ENGINES.find(e => e.type === 'qwen')!;
	const piEngine = ENGINES.find(e => e.type === 'pi')!;

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

	interface CopilotStatus {
		installed: boolean;
		version: string | null;
		activeAccount: { id: number; name: string } | null;
		accountsCount: number;
		backendOS: 'windows' | 'macos' | 'linux';
	}

	// Copilot state
	let copilotStatus = $state<CopilotStatus | null>(null);
	let isLoadingCopilotStatus = $state(true);
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

	// ── Codex state ──
	interface CodexStatus {
		installed: boolean;
		version: string | null;
		sdkVersion: string | null;
		activeAccount: { id: number; name: string; authMode: 'api_key' | 'chatgpt' | null } | null;
		accountsCount: number;
		backendOS: 'windows' | 'macos' | 'linux';
	}
	let codexStatus = $state<CodexStatus | null>(null);
	let isLoadingCodexStatus = $state(true);
	const codexAccounts = $derived(codexAccountsStore.accounts);

	// Codex add-account flow — dual mode
	// ChatGPT flow always runs `codex login --device-auth` (works on
	// remote/headless machines and gives a stable URL+code prompt we can
	// scrape). The browser-OAuth variant is intentionally not exposed.
	type CodexAuthMode = 'api_key' | 'chatgpt';
	type CodexAddStep =
		| 'idle'
		| 'picking-mode'
		| 'editing-api-key'
		| 'chatgpt-loading'      // codex login spawned, waiting for device code
		| 'chatgpt-waiting'      // device code shown, waiting for user to verify in browser
		| 'saving'
		| 'success'
		| 'error';
	let codexAddStep = $state<CodexAddStep>('idle');
	let codexAddMode = $state<CodexAuthMode | null>(null);
	let codexAddName = $state('');
	let codexAddApiKey = $state('');
	let codexAddError = $state('');
	let codexSetupId = $state<string | null>(null);
	let codexDeviceCode = $state<{ code: string; verificationUrl: string } | null>(null);
	let codexUrlCopied = $state(false);
	let codexCodeCopied = $state(false);

	// Codex rename / delete / restart
	let codexRenamingId = $state<number | null>(null);
	let codexRenameValue = $state('');
	let codexRenameApiKey = $state('');
	// When re-authenticating an existing ChatGPT account, the login flow targets it in place.
	let codexReauthAccountId = $state<number | null>(null);
	let codexDeleteDialogOpen = $state(false);
	let codexDeleteTargetId = $state<number | null>(null);
	let codexRestarting = $state(false);

	// ── Qwen Code state ──
	interface QwenStatus {
		installed: boolean;
		version: string | null;
		activeAccount: { id: number; name: string } | null;
		accountsCount: number;
		backendOS: 'windows' | 'macos' | 'linux';
	}
	let qwenStatus = $state<QwenStatus | null>(null);
	let isLoadingQwenStatus = $state(true);
	const qwenAccounts = $derived(qwenAccountsStore.accounts);

	// Qwen add-account flow (paste API key, choose preset)
	type QwenAddStep = 'idle' | 'editing' | 'saving' | 'success' | 'error';
	let qwenAddStep = $state<QwenAddStep>('idle');
	let qwenAddName = $state('');
	let qwenAddApiKey = $state('');
	let qwenAddPreset = $state<QwenProviderPresetId>('dashscope-intl');
	let qwenAddError = $state('');

	// Qwen rename / delete
	let qwenRenamingId = $state<number | null>(null);
	let qwenRenameValue = $state('');
	let qwenRenameApiKey = $state('');
	let qwenRenamePreset = $state<QwenProviderPresetId>('dashscope-intl');
	let qwenDeleteDialogOpen = $state(false);
	let qwenDeleteTargetId = $state<number | null>(null);

	// Add account flow
	type ClaudeCodeSetupStep = 'idle' | 'loading-url' | 'waiting-code' | 'submitting' | 'success' | 'error';
	let claudeCodeSetupStep = $state<ClaudeCodeSetupStep>('idle');
	let claudeCodeSetupId = $state<string | null>(null);
	let claudeCodeAuthUrl = $state<string | null>(null);
	let claudeCodeAuthCode = $state('');
	let claudeCodeAccountName = $state('');
	let claudeCodeSetupError = $state('');

	// Rename
	let claudeCodeRenamingId = $state<number | null>(null);
	let claudeCodeRenameValue = $state('');
	// When re-authenticating an existing account, the setup-token flow updates it in place.
	let claudeCodeReauthAccountId = $state<number | null>(null);

	// Delete confirmation dialog
	let claudeCodeDeleteDialogOpen = $state(false);
	let claudeCodeDeleteTargetId = $state<number | null>(null);

	// Copy URL feedback
	let claudeCodeUrlCopied = $state(false);
	let claudeCodeUrlCopiedTimer: ReturnType<typeof setTimeout> | null = null;

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

	// Debug stream (xterm.js) — Claude Code
	// `showClaudeDebug` is intentionally hardcoded — flip to `true` in source
	// when debugging the setup-token PTY flow. No UI toggle on purpose.
	let showClaudeDebug = $state(false);
	let claudeDebugTermContainer = $state<HTMLDivElement>();
	let claudeDebugTerminal: TerminalViewerHandle | null = null;
	let claudeDebugTermReady = $state(false);
	let claudeDebugPhase = $state('');
	let claudeDebugBufferLen = $state(0);
	let hasClaudeDebugData = $state(false);

	// Debug stream (xterm.js) — Codex
	// `showCodexDebug` is intentionally hardcoded — flip to `true` in source
	// when debugging the codex login PTY flow. No UI toggle on purpose.
	let showCodexDebug = $state(false);
	let codexDebugTermContainer = $state<HTMLDivElement>();
	let codexDebugTerminal: TerminalViewerHandle | null = null;
	let codexDebugTermReady = $state(false);
	let codexDebugBufferLen = $state(0);
	let hasCodexDebugData = $state(false);

	// Event listener cleanup functions
	const cleanups: Array<() => void> = [];

	// Shared read-only debug terminal (PtyKit viewer — no PTY/input, just output).
	async function mountDebugViewer(container: HTMLElement): Promise<TerminalViewerHandle> {
		const { mountViewer } = await import('@myrialabs/ptykit/client');
		return mountViewer(container, {
			// theme, font family, scrollback, convertEol, cursor all default in PtyKit;
			// only the compact debug-panel font size + grid are app-specific.
			theme: 'dark',
			fontSize: 11,
			cols: 120,
			rows: 20
		});
	}

	async function initClaudeDebugTerminal() {
		if (!browser || !claudeDebugTermContainer || claudeDebugTerminal) return;
		claudeDebugTerminal = await mountDebugViewer(claudeDebugTermContainer);
		claudeDebugTermReady = true;
	}

	function disposeClaudeDebugTerminal() {
		if (claudeDebugTerminal) {
			claudeDebugTerminal.dispose();
			claudeDebugTerminal = null;
			claudeDebugTermReady = false;
		}
	}

	async function initCodexDebugTerminal() {
		if (!browser || !codexDebugTermContainer || codexDebugTerminal) return;
		codexDebugTerminal = await mountDebugViewer(codexDebugTermContainer);
		codexDebugTermReady = true;
	}

	function disposeCodexDebugTerminal() {
		if (codexDebugTerminal) {
			codexDebugTerminal.dispose();
			codexDebugTerminal = null;
			codexDebugTermReady = false;
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
				hasClaudeDebugData = true;
				claudeDebugPhase = data.phase;
				claudeDebugBufferLen = data.bufferLength;
				// Write raw data to xterm.js — it handles ANSI natively
				if (claudeDebugTerminal) {
					claudeDebugTerminal.write(data.data);
				}
			})
		);

		// Codex login event listeners
		// Note: the backend generates its own setupId per session — we capture
		// it from the first inbound event (mirroring the Claude Code flow).
		// Filtering by setupId on these per-user broadcasts isn't necessary;
		// the backend already serializes one login at a time per user.
		cleanups.push(
			ws.on('engine:codex-account-setup-device-code', (data: { setupId: string; code: string; verificationUrl: string }) => {
				if (codexAddStep !== 'chatgpt-loading' && codexAddStep !== 'chatgpt-waiting') return;
				codexSetupId = data.setupId;
				codexDeviceCode = { code: data.code, verificationUrl: data.verificationUrl };
				codexAddStep = 'chatgpt-waiting';
			}),
			ws.on('engine:codex-account-setup-complete', async (data: { setupId: string; accountId: number }) => {
				if (codexAddStep !== 'chatgpt-loading' && codexAddStep !== 'chatgpt-waiting') return;
				codexSetupId = data.setupId;
				codexAddStep = 'success';
				await codexAccountsStore.refresh();
				await refreshCodexStatus();
			}),
			ws.on('engine:codex-account-setup-error', (data: { setupId: string; message: string }) => {
				if (codexAddStep !== 'chatgpt-loading' && codexAddStep !== 'chatgpt-waiting') return;
				codexSetupId = data.setupId;
				codexAddError = data.message;
				codexAddStep = 'error';
			}),
			ws.on('engine:codex-account-setup-stream-data', (data: { setupId: string; data: string }) => {
				if (codexAddStep !== 'chatgpt-loading' && codexAddStep !== 'chatgpt-waiting') return;
				codexSetupId = data.setupId;
				hasCodexDebugData = true;
				codexDebugBufferLen += data.data.length;
				if (codexDebugTerminal) {
					codexDebugTerminal.write(data.data);
				}
			})
		);

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

		await Promise.all([
			refreshClaudeCodeStatus(),
			refreshOpenCodeStatus(),
			refreshCopilotStatus(),
			refreshCodexStatus(),
			refreshQwenStatus(),
			qwenPresetsStore.fetch(),
			refreshPiStatus(),
			piPresetsStore.fetch(),
		]);
	});

	onDestroy(() => {
		// Cleanup all event listeners
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;

		// Dispose debug terminals
		disposeClaudeDebugTerminal();
		disposeCodexDebugTerminal();

		// Cancel any running setup
		if (claudeCodeSetupId && claudeCodeSetupStep !== 'idle' && claudeCodeSetupStep !== 'success' && claudeCodeSetupStep !== 'error') {
			ws.emit('engine:claude-account-setup-cancel', { setupId: claudeCodeSetupId });
		}
	});

	// Init Claude debug terminal when container is available
	$effect(() => {
		if (claudeDebugTermContainer && !claudeDebugTerminal && showClaudeDebug) {
			initClaudeDebugTerminal();
		}
	});

	// Init Codex debug terminal when container is available
	$effect(() => {
		if (codexDebugTermContainer && !codexDebugTerminal && showCodexDebug) {
			initCodexDebugTerminal();
		}
	});

	// (Fit-on-resize is handled by mountViewer's own ResizeObserver.)

	async function refreshClaudeCodeStatus() {
		isLoadingClaudeCodeStatus = true;
		try {
			claudeCodeStatus = await ws.http('engine:claude-status', {});

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
		claudeCodeReauthAccountId = null;
		claudeDebugPhase = '';
		claudeDebugBufferLen = 0;
		hasClaudeDebugData = false;
		// Clear debug terminal
		if (claudeDebugTerminal) {
			claudeDebugTerminal.clear();
		}

		// Fire-and-forget: server will emit 'setup-url' or 'setup-error' back
		ws.emit('engine:claude-account-setup-start', {});
	}

	// Re-authenticate an existing account in place: run the setup-token flow but
	// carry the account id (+ prefill its name) so completion updates it.
	function startClaudeCodeReauth(account: ClaudeCodeAccountItem) {
		startClaudeCodeSetup();
		claudeCodeReauthAccountId = account.id;
		claudeCodeAccountName = account.name;
	}

	function submitClaudeCodeAuth() {
		if (!claudeCodeSetupId || !claudeCodeAuthCode.trim() || !claudeCodeAccountName.trim()) return;

		claudeCodeSetupStep = 'submitting';
		claudeCodeSetupError = '';

		// Fire-and-forget: server will emit 'setup-complete' or 'setup-error' back
		ws.emit('engine:claude-account-setup-submit', {
			setupId: claudeCodeSetupId,
			code: claudeCodeAuthCode.trim(),
			name: claudeCodeAccountName.trim(),
			...(claudeCodeReauthAccountId != null ? { reauthAccountId: claudeCodeReauthAccountId } : {})
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
		claudeCodeReauthAccountId = null;
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
		} catch {
			openCodeStatus = null;
		}
		isLoadingOpenCodeStatus = false;

		if (openCodeStatus?.installed) {
			await opencodeProvidersStore.fetchProviders();
			await opencodeProvidersStore.fetchCatalog();
		}
	}

	// ── Copilot Account Management ──

	async function refreshCopilotStatus() {
		isLoadingCopilotStatus = true;
		try {
			copilotStatus = await ws.http('engine:copilot-status', {});
			if (copilotStatus?.installed) {
				await copilotAccountsStore.refresh();
			}
		} catch {
			copilotStatus = null;
		}
		isLoadingCopilotStatus = false;
	}

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

	// ── Codex Account Management ──

	async function refreshCodexStatus() {
		isLoadingCodexStatus = true;
		try {
			codexStatus = await ws.http('engine:codex-status', {});
			await codexAccountsStore.refresh();
		} catch {
			codexStatus = null;
		}
		isLoadingCodexStatus = false;
	}

	function startCodexAdd() {
		codexAddStep = 'picking-mode';
		codexAddMode = null;
		codexAddName = '';
		codexAddApiKey = '';
		codexAddError = '';
		codexSetupId = null;
		codexDeviceCode = null;
		codexUrlCopied = false;
		codexCodeCopied = false;
		codexReauthAccountId = null;
	}

	function proceedCodexMode() {
		if (!codexAddName.trim() || !codexAddMode) return;
		if (codexAddMode === 'api_key') {
			codexAddStep = 'editing-api-key';
		} else {
			startCodexChatGptLogin();
		}
	}

	async function submitCodexApiKey() {
		if (!codexAddName.trim() || !codexAddApiKey.trim()) return;
		codexAddStep = 'saving';
		codexAddError = '';
		try {
			await ws.http('engine:codex-accounts-add-api-key', {
				name: codexAddName.trim(),
				apiKey: codexAddApiKey.trim(),
			});
			codexAddStep = 'success';
			await codexAccountsStore.refresh();
			await refreshCodexStatus();
		} catch (error: unknown) {
			codexAddError = error instanceof Error ? error.message : String(error);
			codexAddStep = 'error';
		}
	}

	function startCodexChatGptLogin() {
		if (!codexAddName.trim()) {
			codexAddError = 'Account name is required';
			codexAddStep = 'error';
			return;
		}
		codexAddStep = 'chatgpt-loading';
		codexAddError = '';
		codexDeviceCode = null;
		codexUrlCopied = false;
		codexCodeCopied = false;
		hasCodexDebugData = false;
		codexDebugBufferLen = 0;
		if (codexDebugTerminal) {
			codexDebugTerminal.clear();
		}
		// The backend generates the canonical setupId — we capture it from
		// the first inbound event (device-code / stream-data).
		codexSetupId = null;
		ws.emit('engine:codex-account-setup-start', {
			name: codexAddName.trim(),
			deviceAuth: true,
			...(codexReauthAccountId != null ? { reauthAccountId: codexReauthAccountId } : {}),
		});
	}

	function cancelCodexAdd() {
		const inFlight = codexAddStep === 'chatgpt-loading' || codexAddStep === 'chatgpt-waiting';
		if (codexSetupId && inFlight) {
			ws.emit('engine:codex-account-setup-cancel', { setupId: codexSetupId });
		}
		codexAddStep = 'idle';
		codexSetupId = null;
		codexDeviceCode = null;
		codexAddName = '';
		codexAddApiKey = '';
		codexAddError = '';
		codexUrlCopied = false;
		codexCodeCopied = false;
		codexReauthAccountId = null;
	}

	async function copyCodexVerificationUrl() {
		if (!codexDeviceCode) return;
		try {
			await navigator.clipboard.writeText(codexDeviceCode.verificationUrl);
			codexUrlCopied = true;
			setTimeout(() => { codexUrlCopied = false; }, 2000);
		} catch { /* ignore */ }
	}

	async function copyCodexDeviceCode() {
		if (!codexDeviceCode) return;
		try {
			await navigator.clipboard.writeText(codexDeviceCode.code);
			codexCodeCopied = true;
			setTimeout(() => { codexCodeCopied = false; }, 2000);
		} catch { /* ignore */ }
	}

	async function switchCodexAccount(id: number) {
		try {
			await ws.http('engine:codex-accounts-switch', { id });
			await codexAccountsStore.refresh();
			await refreshCodexStatus();
			await modelStore.refreshModels('codex');
		} catch {
			// Ignore
		}
	}

	function confirmDeleteCodexAccount(id: number) {
		codexDeleteTargetId = id;
		codexDeleteDialogOpen = true;
	}

	async function deleteCodexAccount() {
		if (codexDeleteTargetId === null) return;
		try {
			await ws.http('engine:codex-accounts-delete', { id: codexDeleteTargetId });
			await codexAccountsStore.refresh();
			await refreshCodexStatus();
		} catch {
			// Ignore
		}
	}

	function startCodexRename(account: CodexAccountItem) {
		codexRenamingId = account.id;
		codexRenameValue = account.name;
		codexRenameApiKey = '';
	}

	async function submitCodexRename() {
		if (codexRenamingId === null || !codexRenameValue.trim()) return;
		const id = codexRenamingId;
		try {
			await ws.http('engine:codex-accounts-rename', { id, name: codexRenameValue.trim() });
			// api_key accounts may also replace their key; blank keeps the stored one.
			const apiKey = codexRenameApiKey.trim();
			if (apiKey) await ws.http('engine:codex-accounts-update-api-key', { id, apiKey });
			codexRenamingId = null;
			codexRenameValue = '';
			codexRenameApiKey = '';
			await codexAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	function cancelCodexRename() {
		codexRenamingId = null;
		codexRenameValue = '';
		codexRenameApiKey = '';
	}

	// Re-authenticate an existing ChatGPT account in place by re-running the
	// device-code login flow, reusing the same add-account UI.
	function startCodexReauth(account: CodexAccountItem) {
		codexReauthAccountId = account.id;
		codexAddName = account.name;
		codexAddMode = 'chatgpt';
		startCodexChatGptLogin();
	}

	async function handleCodexRestart() {
		codexRestarting = true;
		try {
			await ws.http('engine:codex-restart', {});
			await modelStore.refreshModels('codex');
			await refreshCodexStatus();
			showSuccess('Codex Restarted', 'Codex engine restarted. Models refreshed.');
		} catch {
			// Ignore
		} finally {
			codexRestarting = false;
		}
	}

	// ── OpenCode Provider Management ──

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

	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Fallback
		}
	}

	function openSystemToolsSection() {
		setActiveSection('system-tools');
	}

	// ── Qwen Code Account Management ──

	async function refreshQwenStatus() {
		isLoadingQwenStatus = true;
		try {
			qwenStatus = await ws.http('engine:qwen-status', {});
			if (qwenStatus?.installed) {
				await qwenAccountsStore.refresh();
			}
		} catch {
			qwenStatus = null;
		}
		isLoadingQwenStatus = false;
	}

	function startQwenAdd() {
		qwenAddStep = 'editing';
		qwenAddName = '';
		qwenAddApiKey = '';
		qwenAddPreset = qwenPresetsStore.defaultPreset;
		qwenAddError = '';
	}

	async function submitQwenAdd() {
		if (!qwenAddName.trim() || !qwenAddApiKey.trim()) return;
		qwenAddStep = 'saving';
		qwenAddError = '';
		try {
			await ws.http('engine:qwen-accounts-add', {
				name: qwenAddName.trim(),
				apiKey: qwenAddApiKey.trim(),
				preset: qwenAddPreset,
			});
			qwenAddStep = 'success';
			await qwenAccountsStore.refresh();
			await refreshQwenStatus();
			await modelStore.refreshModels('qwen');
		} catch (error: any) {
			qwenAddError = error?.message || 'Failed to add account';
			qwenAddStep = 'error';
		}
	}

	function cancelQwenAdd() {
		qwenAddStep = 'idle';
		qwenAddName = '';
		qwenAddApiKey = '';
		qwenAddPreset = qwenPresetsStore.defaultPreset;
		qwenAddError = '';
	}

	async function switchQwenAccount(id: number) {
		try {
			await ws.http('engine:qwen-accounts-switch', { id });
			await qwenAccountsStore.refresh();
			await refreshQwenStatus();
			await modelStore.refreshModels('qwen');
		} catch {
			// Ignore
		}
	}

	function confirmDeleteQwenAccount(id: number) {
		qwenDeleteTargetId = id;
		qwenDeleteDialogOpen = true;
	}

	async function deleteQwenAccount() {
		if (qwenDeleteTargetId === null) return;
		try {
			await ws.http('engine:qwen-accounts-delete', { id: qwenDeleteTargetId });
			await qwenAccountsStore.refresh();
			await refreshQwenStatus();
		} catch {
			// Ignore
		}
	}

	function startQwenRename(account: QwenAccountItem) {
		qwenRenamingId = account.id;
		qwenRenameValue = account.name;
		qwenRenameApiKey = '';
		qwenRenamePreset = account.preset;
	}

	async function submitQwenRename() {
		if (qwenRenamingId === null || !qwenRenameValue.trim()) return;
		const id = qwenRenamingId;
		try {
			await ws.http('engine:qwen-accounts-rename', { id, name: qwenRenameValue.trim() });
			// Update key/preset in one call — omit apiKey when blank to keep the stored one.
			const apiKey = qwenRenameApiKey.trim();
			await ws.http('engine:qwen-accounts-update', { id, preset: qwenRenamePreset, ...(apiKey ? { apiKey } : {}) });
			qwenRenamingId = null;
			qwenRenameValue = '';
			qwenRenameApiKey = '';
			await qwenAccountsStore.refresh();
		} catch {
			// Ignore
		}
	}

	function cancelQwenRename() {
		qwenRenamingId = null;
		qwenRenameValue = '';
		qwenRenameApiKey = '';
	}

	// ── Pi Account Management ──

	interface PiStatus {
		installed: boolean;
		version: string | null;
		activeAccount: { id: number; name: string } | null;
		accountsCount: number;
		backendOS: 'windows' | 'macos' | 'linux';
	}

	let piStatus = $state<PiStatus | null>(null);
	let isLoadingPiStatus = $state(true);
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

	async function refreshPiStatus() {
		isLoadingPiStatus = true;
		try {
			piStatus = await ws.http('engine:pi-status', {});
			if (piStatus?.installed) await piAccountsStore.refresh();
		} catch {
			piStatus = null;
		}
		isLoadingPiStatus = false;
	}

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
		piEditingId = null;
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

	async function copyClaudeCodeAuthUrl() {
		if (!claudeCodeAuthUrl) return;
		await copyToClipboard(claudeCodeAuthUrl);
		claudeCodeUrlCopied = true;
		if (claudeCodeUrlCopiedTimer) clearTimeout(claudeCodeUrlCopiedTimer);
		claudeCodeUrlCopiedTimer = setTimeout(() => { claudeCodeUrlCopied = false; }, 2000);
	}
</script>

<div class={compact ? '' : 'space-y-6'}>
	{#if showHeader}
		<!-- Header -->
		<div class="mb-4">
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Engines</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">
				Connect accounts and configure providers for your AI engines.
			</p>
		</div>
	{/if}

	<!-- Engine selector grid -->
	<div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-6">
		{#each ENGINES as eng (eng.type)}
			{@const isActive = activeEngine === eng.type}
			{@const stat =
				eng.type === 'claude-code' ? { installed: claudeCodeStatus?.installed ?? null, count: claudeCodeAccounts.length } :
				eng.type === 'opencode' ? { installed: openCodeStatus?.installed ?? null, count: ocProviders.reduce((sum, p) => sum + p.accounts.length, 0) } :
				eng.type === 'copilot' ? { installed: copilotStatus?.installed ?? null, count: copilotAccounts.length } :
				eng.type === 'codex' ? { installed: codexStatus?.installed ?? null, count: codexAccounts.length } :
				eng.type === 'qwen' ? { installed: qwenStatus?.installed ?? null, count: qwenAccounts.length } :
				{ installed: piStatus?.installed ?? null, count: piAccounts.length }}
			{@const countLabel = `${stat.count} account${stat.count === 1 ? '' : 's'}`}
			<button
				type="button"
				class="flex items-center gap-2.5 p-3 overflow-hidden border-2 rounded-xl text-left cursor-pointer transition-all duration-200
					{isActive
						? 'border-violet-600 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/12 dark:to-purple-500/8'
						: 'border-slate-200 dark:border-slate-800 bg-slate-100/80 dark:bg-slate-800/80 hover:border-violet-500/20 dark:hover:border-violet-500/35'}"
				onclick={() => { activeEngine = eng.type; }}
				title={eng.name}
			>
				<div class="shrink-0 flex items-center justify-center w-5 h-5 [&>svg]:w-5 [&>svg]:h-5">
					{@html isDarkMode() ? eng.icon.dark : eng.icon.light}
				</div>
				<div class="flex-1 min-w-0">
					<div class="font-bold text-sm text-slate-900 dark:text-slate-100 truncate">{eng.name}</div>
					{#if !compact}
						<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
							{#if stat.installed === false}
								Not installed
							{:else if stat.installed === null}
								—
							{:else}
								{countLabel}
							{/if}
						</div>
					{/if}
				</div>
			</button>
		{/each}
	</div>

	<!-- Active engine pane -->
	<div class="space-y-6">

	{#if activeEngine === 'claude-code'}
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
		</div>

		<!-- Card Body -->
		<div class="px-5 py-4">
			{#if isLoadingClaudeCodeStatus}
				<div class="flex items-center justify-center py-8">
					<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
				</div>
			{:else if claudeCodeStatus && !claudeCodeStatus.installed}
				<!-- Redirect to System Tools -->
				<div class="flex items-start gap-3 p-4 rounded-lg bg-violet-50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800/50">
					<Icon name="lucide:hammer" class="w-5 h-5 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
					<div class="flex-1 space-y-2">
						<div>
							<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Claude Code is not installed</p>
							<p class="text-xs text-slate-600 dark:text-slate-400">Install it from the System Tools section. You can return here once it's installed to connect accounts.</p>
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
			{:else if claudeCodeStatus}
				<!-- Installed View -->
				<div class="space-y-5">
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
									<span class="text-2xs text-slate-400">anthropic</span>
									<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
								</div>
							</div>

							<!-- Accounts list -->
							<div class="px-3.5 py-2.5 space-y-2">
								{#if claudeCodeAccounts.length === 0}
									<p class="text-xs text-slate-500 italic">No accounts</p>
								{:else}
									{#each claudeCodeAccounts as account (account.id)}
										<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
											<div class="flex items-center justify-between px-3.5 py-2.5">
												<div class="w-full flex items-center gap-2.5 min-w-0">
													<Icon name="lucide:user" class="w-4 h-4 shrink-0 text-slate-400" />
													<div class="flex items-center gap-2 min-w-0">
														<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
														{#if account.isActive}
															<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
														{/if}
													</div>
												</div>
												<div class="flex items-center gap-1">
													{#if !account.isActive}
														<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchClaudeCodeAccount(account.id)} title="Switch to this account">
															<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
														</button>
													{/if}
													<button type="button" class="flex p-1.5 rounded-md {claudeCodeRenamingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => claudeCodeRenamingId === account.id ? cancelClaudeCodeRename() : startClaudeCodeRename(account)} title="Edit account">
														<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
													</button>
													<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteClaudeCodeAccount(account.id)} title="Delete account">
														<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
													</button>
												</div>
											</div>
											{#if claudeCodeRenamingId === account.id}
												<AccountEditForm onSave={submitClaudeCodeRename} onCancel={cancelClaudeCodeRename} onReauth={() => startClaudeCodeReauth(account)} saveDisabled={!claudeCodeRenameValue.trim()}>
													<AccountField label="Account name" bind:value={claudeCodeRenameValue} />
												</AccountEditForm>
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

	<!-- Claude Code Debug Stream (xterm.js) — toggled via the hardcoded showClaudeDebug flag -->
	{#if showClaudeDebug && (hasClaudeDebugData || claudeCodeSetupStep !== 'idle')}
		<div class="rounded-xl border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10 overflow-hidden">
			<div class="flex items-center justify-between px-4 py-2 border-b border-amber-200 dark:border-amber-700/50">
				<div class="flex items-center gap-2">
					<Icon name="lucide:bug" class="w-4 h-4 text-amber-600" />
					<span class="text-xs font-semibold text-amber-700 dark:text-amber-300">Claude Debug: Setup-Token PTY</span>
					<span class="text-3xs px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200">
						phase={claudeDebugPhase} | buf={claudeDebugBufferLen} | step={claudeCodeSetupStep}
					</span>
				</div>
				<button
					type="button"
					class="text-xs text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
					onclick={() => { claudeDebugTerminal?.clear(); hasClaudeDebugData = false; claudeDebugBufferLen = 0; }}
				>
					Clear
				</button>
			</div>
			<div
				bind:this={claudeDebugTermContainer}
				class="h-80 bg-[#0f172a]"
			></div>
		</div>
	{/if}

	{:else if activeEngine === 'copilot'}
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

	{:else if activeEngine === 'codex'}
	<!-- Codex Card -->
	<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
		<!-- Card Header -->
		<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
			<div class="flex items-center gap-3">
				<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
					{@html isDarkMode() ? codexEngine.icon.dark : codexEngine.icon.light}
				</div>
				<div>
					<h3 class="font-semibold text-slate-900 dark:text-slate-100">{codexEngine.name}</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400">{codexEngine.description}</p>
				</div>
			</div>
			<div class="flex items-center gap-2">
				{#if codexStatus?.installed && codexStatus?.activeAccount}
					<button
						type="button"
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
							text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50
							hover:bg-amber-100 dark:hover:bg-amber-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
						onclick={handleCodexRestart}
						disabled={codexRestarting}
					>
						<Icon name={codexRestarting ? 'lucide:loader' : 'lucide:rotate-cw'} class="w-3.5 h-3.5 {codexRestarting ? 'animate-spin' : ''}" />
						{codexRestarting ? 'Restarting...' : 'Restart Server'}
					</button>
				{/if}
			</div>
		</div>

		<!-- Card Body -->
		<div class="px-5 py-4">
			{#if isLoadingCodexStatus}
				<div class="flex items-center justify-center py-8">
					<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
				</div>
			{:else if codexStatus && !codexStatus.installed}
				<!-- Redirect to System Tools -->
				<div class="flex items-start gap-3 p-4 rounded-lg bg-violet-50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800/50">
					<Icon name="lucide:hammer" class="w-5 h-5 shrink-0 mt-0.5 text-violet-600 dark:text-violet-400" />
					<div class="flex-1 space-y-2">
						<div>
							<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Codex CLI is not installed</p>
							<p class="text-xs text-slate-600 dark:text-slate-400">Install it from the System Tools section. You can return here once it's installed to connect accounts.</p>
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
			{:else if codexStatus}
				<div class="space-y-5">
					<div class="space-y-3">
						<div class="flex items-center justify-between">
							<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Providers</h4>
							<span class="text-xs text-slate-500">1 provider</span>
						</div>

						<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
							<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
								<div class="flex items-center gap-2 min-w-0">
									<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">OpenAI</span>
									<span class="text-2xs text-slate-400">openai</span>
									<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
								</div>
							</div>

							<div class="px-3.5 py-2.5 space-y-2">
								{#if codexAccounts.length === 0}
									<p class="text-xs text-slate-500 italic">No accounts</p>
								{:else}
									{#each codexAccounts as account (account.id)}
										<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
											<div class="flex items-center justify-between px-3.5 py-2.5">
												<div class="w-full flex items-center gap-2.5 min-w-0">
													<Icon name={account.authMode === 'chatgpt' ? 'lucide:user-round' : 'lucide:key'} class="w-4 h-4 shrink-0 text-slate-400" />
													<div class="flex items-center gap-2 min-w-0">
														<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
														<span class="text-3xs px-1.5 py-px rounded bg-slate-100 dark:bg-slate-700/60 text-slate-500 dark:text-slate-400">{account.authMode === 'chatgpt' ? 'ChatGPT' : 'API key'}</span>
														{#if account.isActive}
															<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
														{/if}
													</div>
												</div>
												<div class="flex items-center gap-1">
													{#if !account.isActive}
														<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20" onclick={() => switchCodexAccount(account.id)} title="Switch to this account">
															<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
														</button>
													{/if}
													<button type="button" class="flex p-1.5 rounded-md {codexRenamingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'}" onclick={() => codexRenamingId === account.id ? cancelCodexRename() : startCodexRename(account)} title="Edit account">
														<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
													</button>
													<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20" onclick={() => confirmDeleteCodexAccount(account.id)} title="Delete account">
														<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
													</button>
												</div>
											</div>
											{#if codexRenamingId === account.id}
												<AccountEditForm onSave={submitCodexRename} onCancel={cancelCodexRename} onReauth={account.authMode === 'chatgpt' ? () => startCodexReauth(account) : undefined} reauthLabel="Re-authenticate (ChatGPT)" saveDisabled={!codexRenameValue.trim()}>
													<AccountField label="Account name" bind:value={codexRenameValue} />
													{#if account.authMode !== 'chatgpt'}
														<AccountField label="API key" secret hint="(leave blank to keep)" bind:value={codexRenameApiKey} />
													{/if}
												</AccountEditForm>
											{/if}
										</div>
									{/each}
								{/if}

								<!-- Add Account Flow (dual mode) -->
								<div class="pt-1">
									{#if codexAddStep === 'idle'}
										<button type="button" class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center" onclick={startCodexAdd}>
											<Icon name="lucide:plus" class="w-4 h-4" />
											Add Account
										</button>
									{:else if codexAddStep === 'picking-mode'}
										<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
												<Icon name="lucide:user-plus" class="w-3.5 h-3.5" />
												Add a Codex account
											</div>
											<input
												type="text"
												bind:value={codexAddName}
												placeholder="Account name (e.g. Personal, Work)"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>

											<div class="space-y-2" role="radiogroup" aria-label="Authentication mode">
												<button type="button" role="radio" aria-checked={codexAddMode === 'api_key'} onclick={() => { codexAddMode = 'api_key'; }} class="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg border cursor-pointer transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 {codexAddMode === 'api_key' ? 'border-violet-400 ring-1 ring-violet-500/40 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:border-violet-400'}">
													<span class="relative flex items-center justify-center w-4 h-4 rounded-full border-2 transition-colors {codexAddMode === 'api_key' ? 'border-violet-500' : 'border-slate-300 dark:border-slate-500'}">
														<span class="w-2 h-2 rounded-full bg-violet-500 transition-transform {codexAddMode === 'api_key' ? 'scale-100' : 'scale-0'}"></span>
													</span>
													<Icon name="lucide:key" class="w-3.5 h-3.5" />
													<span>API key</span>
												</button>
												<button type="button" role="radio" aria-checked={codexAddMode === 'chatgpt'} onclick={() => { codexAddMode = 'chatgpt'; }} class="w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg border cursor-pointer transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 {codexAddMode === 'chatgpt' ? 'border-violet-400 ring-1 ring-violet-500/40 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100' : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:border-violet-400'}">
													<span class="relative flex items-center justify-center w-4 h-4 rounded-full border-2 transition-colors {codexAddMode === 'chatgpt' ? 'border-violet-500' : 'border-slate-300 dark:border-slate-500'}">
														<span class="w-2 h-2 rounded-full bg-violet-500 transition-transform {codexAddMode === 'chatgpt' ? 'scale-100' : 'scale-0'}"></span>
													</span>
													<Icon name="lucide:user-round" class="w-3.5 h-3.5" />
													<span>Sign in with ChatGPT</span>
												</button>
											</div>

											<div class="flex gap-2">
												<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={proceedCodexMode} disabled={!codexAddName.trim() || !codexAddMode}>
													<Icon name="lucide:arrow-right" class="w-4 h-4" />
													Next
												</button>
												<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelCodexAdd}>
													Cancel
												</button>
											</div>
										</div>
									{:else if codexAddStep === 'editing-api-key'}
										<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
												<Icon name="lucide:key" class="w-3.5 h-3.5" />
												Paste your OpenAI API key
											</div>
											<input
												type="text"
												bind:value={codexAddApiKey}
												placeholder="sk-…"
												class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
											/>
											<div class="flex gap-2">
												<button type="button" class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={submitCodexApiKey} disabled={!codexAddName.trim() || !codexAddApiKey.trim()}>
													<Icon name="lucide:plus" class="w-4 h-4" />
													Save
												</button>
												<button type="button" class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelCodexAdd}>
													Cancel
												</button>
											</div>
										</div>
									{:else if codexAddStep === 'chatgpt-loading'}
										<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
												<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
												<span>Starting Codex device-auth…</span>
											</div>
										</div>
									{:else if codexAddStep === 'chatgpt-waiting' && codexDeviceCode}
										<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<!-- Step 1 -->
											<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
												<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
												Step 1: Open the verification URL
											</div>

											<p class="text-sm text-slate-600 dark:text-slate-400">
												Open the URL below in your browser and sign in to your ChatGPT account.
											</p>

											<div>
												<div class="bg-white dark:bg-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-700 dark:text-slate-300 break-all border border-slate-200 dark:border-slate-700">
													{codexDeviceCode.verificationUrl}
												</div>
												<div class="flex gap-2 mt-2">
													<button
														type="button"
														class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
															{codexUrlCopied
															? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
															: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'}"
														onclick={copyCodexVerificationUrl}
													>
														{#if codexUrlCopied}
															<Icon name="lucide:check" class="w-3 h-3" />
															Copied
														{:else}
															<Icon name="lucide:copy" class="w-3 h-3" />
															Copy URL
														{/if}
													</button>
													<a
														href={codexDeviceCode.verificationUrl}
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
												<Icon name="lucide:hash" class="w-3.5 h-3.5" />
												Step 2: Enter the one-time code
											</div>

											<p class="text-sm text-slate-600 dark:text-slate-400">
												Enter this code on the verification page. It expires in 15 minutes.
											</p>

											<div>
												<div class="px-4 py-3 rounded-lg border-2 border-violet-300 dark:border-violet-700/50 bg-white dark:bg-slate-800 font-mono text-2xl tracking-[0.2em] text-violet-700 dark:text-violet-300 text-center select-all">
													{codexDeviceCode.code}
												</div>
												<div class="flex gap-2 mt-2">
													<button
														type="button"
														class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
															{codexCodeCopied
															? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
															: 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'}"
														onclick={copyCodexDeviceCode}
													>
														{#if codexCodeCopied}
															<Icon name="lucide:check" class="w-3 h-3" />
															Copied
														{:else}
															<Icon name="lucide:copy" class="w-3 h-3" />
															Copy code
														{/if}
													</button>
												</div>
											</div>

											<!-- Divider -->
											<div class="border-t border-slate-200 dark:border-slate-700/50"></div>

											<!-- Status -->
											<div class="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
												<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin text-violet-500" />
												Waiting for verification… the CLI will detect it automatically once you submit the code in the browser.
											</div>

											<button type="button" class="w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={cancelCodexAdd}>
												Cancel
											</button>

											<p class="text-2xs text-slate-400 dark:text-slate-500">
												A background process is running. It will auto-close in 10 minutes if not completed.
											</p>
										</div>
									{:else if codexAddStep === 'saving'}
										<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
												<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
												<span>Saving account…</span>
											</div>
										</div>
									{:else if codexAddStep === 'success'}
										<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
											<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
											<span class="text-sm text-green-700 dark:text-green-300">Codex account added!</span>
											<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={cancelCodexAdd}>Dismiss</button>
										</div>
									{:else if codexAddStep === 'error'}
										<div class="space-y-3">
											<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
												<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
												<span class="text-sm text-red-700 dark:text-red-300">{codexAddError}</span>
											</div>
											<button type="button" class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" onclick={() => { codexAddStep = 'picking-mode'; codexAddError = ''; }}>
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

	<!-- Codex Debug Stream Output (xterm.js) -->
	{#if showCodexDebug && (hasCodexDebugData || codexAddStep === 'chatgpt-loading' || codexAddStep === 'chatgpt-waiting')}
		<div class="rounded-xl border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/10 overflow-hidden">
			<div class="flex items-center justify-between px-4 py-2 border-b border-amber-200 dark:border-amber-700/50">
				<div class="flex items-center gap-2">
					<Icon name="lucide:bug" class="w-4 h-4 text-amber-600" />
					<span class="text-xs font-semibold text-amber-700 dark:text-amber-300">Codex Debug: Login Stream</span>
					<span class="text-3xs px-1.5 py-0.5 rounded bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200">
						buf={codexDebugBufferLen} | step={codexAddStep}
					</span>
				</div>
				<button
					type="button"
					class="text-xs text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
					onclick={() => { codexDebugTerminal?.clear(); hasCodexDebugData = false; codexDebugBufferLen = 0; }}
				>
					Clear
				</button>
			</div>
			<div
				bind:this={codexDebugTermContainer}
				class="h-80 bg-[#0f172a]"
			></div>
		</div>
	{/if}

	{:else if activeEngine === 'qwen'}
	<!-- Qwen Code Card -->
	<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
		<!-- Card Header -->
		<div class="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
			<div class="flex items-center gap-3">
				<div class="flex items-center justify-center [&>svg]:w-6 [&>svg]:h-6">
					{@html isDarkMode() ? qwenEngine.icon.dark : qwenEngine.icon.light}
				</div>
				<div>
					<h3 class="font-semibold text-slate-900 dark:text-slate-100">{qwenEngine.name}</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400">{qwenEngine.description}</p>
				</div>
			</div>
		</div>

		<!-- Card Body -->
		<div class="px-5 py-4">
			{#if isLoadingQwenStatus}
				<div class="flex items-center justify-center py-8">
					<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-slate-400" />
				</div>
			{:else if qwenStatus}
				<div class="space-y-5">
					<!-- Providers Section -->
					<div class="space-y-3">
						<div class="flex items-center justify-between">
							<h4 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Providers</h4>
							<span class="text-xs text-slate-500">1 provider</span>
						</div>

						<!-- Qwen provider (pre-seeded) -->
						<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 overflow-hidden">
							<div class="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-700/50">
								<div class="flex items-center gap-2 min-w-0">
									<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">Qwen</span>
									<span class="text-2xs text-slate-400">qwen</span>
									<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Built-in</span>
								</div>
							</div>

							<!-- Accounts list -->
							<div class="px-3.5 py-2.5 space-y-2">
								{#if qwenAccounts.length === 0}
									<p class="text-xs text-slate-500 italic">No accounts</p>
								{:else}
									{#each qwenAccounts as account (account.id)}
										{@const accountPreset = qwenPresetsStore.getPreset(account.preset)}
										<div class="rounded-lg border border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-800/80 {account.isActive ? 'ring-1 ring-violet-500/40' : ''}">
											<div class="flex items-center justify-between px-3.5 py-2.5">
												<div class="w-full flex items-center gap-2.5 min-w-0">
													<Icon name="lucide:key" class="w-4 h-4 shrink-0 text-slate-400" />
													<div class="flex flex-col min-w-0 gap-0.5">
														<div class="flex items-center gap-2 min-w-0">
															<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{account.name}</span>
															{#if account.isActive}
																<span class="inline-flex items-center px-2 py-0.5 rounded-full text-3xs font-semibold bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300">Active</span>
															{/if}
														</div>
														<div class="flex items-center gap-2 min-w-0 text-2xs text-slate-500 dark:text-slate-400">
															<span class="font-medium">{accountPreset?.name ?? account.preset}</span>
														</div>
													</div>
												</div>
												<div class="flex items-center gap-1">
													{#if !account.isActive}
														<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={() => switchQwenAccount(account.id)} title="Switch to this account">
															<Icon name="lucide:arrow-right-left" class="w-3.5 h-3.5" />
														</button>
													{/if}
													<button type="button" class="flex p-1.5 rounded-md {qwenRenamingId === account.id ? 'text-violet-600 bg-violet-50 dark:bg-violet-900/20' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20'} transition-colors" onclick={() => qwenRenamingId === account.id ? cancelQwenRename() : startQwenRename(account)} title="Edit account">
														<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
													</button>
													<button type="button" class="flex p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors" onclick={() => confirmDeleteQwenAccount(account.id)} title="Delete account">
														<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
													</button>
												</div>
											</div>
											{#if qwenRenamingId === account.id}
												<AccountEditForm onSave={submitQwenRename} onCancel={cancelQwenRename} saveDisabled={!qwenRenameValue.trim()}>
													<AccountField label="Account name" bind:value={qwenRenameValue} />
													<div class="space-y-1">
														<span class="block text-2xs font-medium text-slate-500 dark:text-slate-400">Provider preset</span>
														<select bind:value={qwenRenamePreset} class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500">
															{#each qwenPresetsStore.presets as preset (preset.id)}
																<option value={preset.id}>{preset.name}</option>
															{/each}
														</select>
													</div>
													<AccountField label="API key" secret hint="(leave blank to keep)" bind:value={qwenRenameApiKey} />
												</AccountEditForm>
											{/if}
										</div>
									{/each}
								{/if}

								<!-- Add Account Flow (paste API key) -->
								<div class="pt-1">
									{#if qwenAddStep === 'idle'}
										<button
											type="button"
											class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center"
											onclick={startQwenAdd}
										>
											<Icon name="lucide:plus" class="w-4 h-4" />
											Add Account
										</button>
									{:else if qwenAddStep === 'editing'}
										<div class="space-y-3 p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center gap-2 text-xs font-medium text-violet-600 dark:text-violet-400">
												<Icon name="lucide:key" class="w-3.5 h-3.5" />
												Add an OpenAI-compatible API key
											</div>

											<div class="text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
												<p>Add an OpenAI-compatible API key for your Qwen Code account.</p>
											</div>

											<div class="space-y-2">
												<input
													type="text"
													bind:value={qwenAddName}
													placeholder="Account name (e.g. Personal, Work)"
													class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
												/>
												<select
													bind:value={qwenAddPreset}
													class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
												>
													{#each qwenPresetsStore.presets as preset (preset.id)}
														<option value={preset.id}>{preset.name}</option>
													{/each}
												</select>
												<input
													type="text"
													bind:value={qwenAddApiKey}
													placeholder="sk-…"
													class="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
												/>
											</div>

											<div class="flex gap-2">
												<button
													type="button"
													class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
													onclick={submitQwenAdd}
													disabled={!qwenAddName.trim() || !qwenAddApiKey.trim()}
												>
													<Icon name="lucide:plus" class="w-4 h-4" />
													Save
												</button>
												<button
													type="button"
													class="px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
													onclick={cancelQwenAdd}
												>
													Cancel
												</button>
											</div>
										</div>
									{:else if qwenAddStep === 'saving'}
										<div class="p-4 rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-900/10">
											<div class="flex items-center justify-center gap-2 text-sm text-slate-500">
												<Icon name="lucide:loader" class="w-4 h-4 animate-spin" />
												<span>Saving API key...</span>
											</div>
										</div>
									{:else if qwenAddStep === 'success'}
										<div class="flex items-center gap-2 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50">
											<Icon name="lucide:circle-check" class="w-5 h-5 text-green-600 dark:text-green-400" />
											<span class="text-sm text-green-700 dark:text-green-300">Account added successfully!</span>
											<button type="button" class="ml-auto text-xs text-green-600 dark:text-green-400 hover:underline" onclick={cancelQwenAdd}>Dismiss</button>
										</div>
									{:else if qwenAddStep === 'error'}
										<div class="space-y-3">
											<div class="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50">
												<Icon name="lucide:circle-alert" class="w-5 h-5 shrink-0 text-red-600 dark:text-red-400" />
												<span class="text-sm text-red-700 dark:text-red-300">{qwenAddError}</span>
											</div>
											<button
												type="button"
												class="flex items-center justify-center gap-2 w-full px-4 py-2 text-sm font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
												onclick={() => { qwenAddStep = 'editing'; }}
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

	{:else if activeEngine === 'pi'}
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
								</div>
							{/each}
						{/if}
					</div>

					<!-- Add Account Flow -->
					<div class="pt-1">
						{#if piAddStep === 'idle'}
							<button type="button" class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center" onclick={startPiAdd}>
								<Icon name="lucide:plus" class="w-4 h-4" />
								Add Account
							</button>
						{:else if piAddStep === 'choose'}
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
					</div>
				</div>
			{/if}
		</div>
	</div>

	{:else if activeEngine === 'opencode'}
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
	bind:isOpen={copilotDeleteDialogOpen}
	onClose={() => { copilotDeleteDialogOpen = false; copilotDeleteTargetId = null; }}
	type="error"
	title="Delete Account"
	message="Are you sure you want to delete this Copilot account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteCopilotAccount}
/>

<Dialog
	bind:isOpen={codexDeleteDialogOpen}
	onClose={() => { codexDeleteDialogOpen = false; codexDeleteTargetId = null; }}
	type="error"
	title="Delete Codex Account"
	message="Are you sure you want to delete this Codex account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteCodexAccount}
/>

<Dialog
	bind:isOpen={qwenDeleteDialogOpen}
	onClose={() => { qwenDeleteDialogOpen = false; qwenDeleteTargetId = null; }}
	type="error"
	title="Delete Qwen Code Account"
	message="Are you sure you want to delete this Qwen Code account? This action cannot be undone."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={deleteQwenAccount}
/>

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

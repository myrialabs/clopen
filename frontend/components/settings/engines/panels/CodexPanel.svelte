<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$frontend/app-environment';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import { codexAccountsStore, type CodexAccountItem } from '$frontend/stores/features/codex-accounts.svelte';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { showSuccess } from '$frontend/stores/ui/notification.svelte';
	import type { TerminalViewerHandle } from '@myrialabs/ptykit/client';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import { mountDebugViewer } from './debug-viewer';
	import type { CodexStatus } from './panel-types';

	interface Props {
		status: CodexStatus | null;
		isLoading: boolean;
		onRefreshStatus: () => Promise<void> | void;
	}
	const { status, isLoading, onRefreshStatus }: Props = $props();

	const codexStatus = $derived(status);
	const isLoadingCodexStatus = $derived(isLoading);
	const refreshCodexStatus = () => onRefreshStatus();
	const codexEngine = ENGINES.find(e => e.type === 'codex')!;
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

	onMount(() => {
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
	});

	onDestroy(() => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;

		disposeCodexDebugTerminal();
	});

	// Init Codex debug terminal when container is available
	$effect(() => {
		if (codexDebugTermContainer && !codexDebugTerminal && showCodexDebug) {
			initCodexDebugTerminal();
		}
	});

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

	function openSystemToolsSection() {
		setActiveSection('system-tools');
	}
</script>

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
											{#if codexReauthAccountId === account.id && codexAddStep !== 'idle'}
												<div class="px-3.5 pb-3 pt-2 border-t border-slate-200 dark:border-slate-700/50">
													{@render codexAddFlow()}
												</div>
											{:else}
												<AccountEditForm onSave={submitCodexRename} onCancel={cancelCodexRename} onReauth={account.authMode === 'chatgpt' ? () => startCodexReauth(account) : undefined} reauthLabel="Re-authenticate (ChatGPT)" saveDisabled={!codexRenameValue.trim()}>
													<AccountField label="Account name" bind:value={codexRenameValue} />
													{#if account.authMode !== 'chatgpt'}
														<AccountField label="API key" secret hint="(leave blank to keep)" bind:value={codexRenameApiKey} />
													{/if}
												</AccountEditForm>
											{/if}
										{/if}
									</div>
								{/each}
							{/if}

							<!-- Add Account Flow (dual mode) -->
							<div class="pt-1">
								{#if codexAddStep === 'idle' || codexReauthAccountId !== null}
									<button type="button" class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center" onclick={startCodexAdd}>
										<Icon name="lucide:plus" class="w-4 h-4" />
										Add Account
									</button>
								{:else}
									{@render codexAddFlow()}
								{/if}
							</div>

							{#snippet codexAddFlow()}
								{#if codexAddStep === 'picking-mode'}
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
							{/snippet}
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

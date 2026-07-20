<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$frontend/app-environment';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import { claudeAccountsStore, type ClaudeAccountItem as ClaudeCodeAccountItem } from '$frontend/stores/features/claude-accounts.svelte';
	import type { TerminalViewerHandle } from '@myrialabs/ptykit/client';
	import AccountEditForm from '../AccountEditForm.svelte';
	import AccountField from '../AccountField.svelte';
	import { mountDebugViewer } from './debug-viewer';
	import type { ClaudeCodeStatus } from './panel-types';

	interface Props {
		status: ClaudeCodeStatus | null;
		isLoading: boolean;
	}
	const { status, isLoading }: Props = $props();

	// Alias props/stores back to the original names so the template + handlers
	// read exactly as they did in the monolithic component.
	const claudeCodeStatus = $derived(status);
	const isLoadingClaudeCodeStatus = $derived(isLoading);
	const claudeCodeEngine = ENGINES.find(e => e.type === 'claude-code')!;
	const claudeCodeAccounts = $derived(claudeAccountsStore.accounts);

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

	// Event listener cleanup functions
	const cleanups: Array<() => void> = [];

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

	onMount(() => {
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
	});

	onDestroy(() => {
		for (const cleanup of cleanups) cleanup();
		cleanups.length = 0;

		disposeClaudeDebugTerminal();

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

	async function copyClaudeCodeAuthUrl() {
		if (!claudeCodeAuthUrl) return;
		await copyToClipboard(claudeCodeAuthUrl);
		claudeCodeUrlCopied = true;
		if (claudeCodeUrlCopiedTimer) clearTimeout(claudeCodeUrlCopiedTimer);
		claudeCodeUrlCopiedTimer = setTimeout(() => { claudeCodeUrlCopied = false; }, 2000);
	}
</script>

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
											{#if claudeCodeReauthAccountId === account.id && claudeCodeSetupStep !== 'idle'}
												<div class="px-3.5 pb-3 pt-2 border-t border-slate-200 dark:border-slate-700/50">
													{@render claudeCodeSetupFlow()}
												</div>
											{:else}
												<AccountEditForm onSave={submitClaudeCodeRename} onCancel={cancelClaudeCodeRename} onReauth={() => startClaudeCodeReauth(account)} saveDisabled={!claudeCodeRenameValue.trim()}>
													<AccountField label="Account name" bind:value={claudeCodeRenameValue} />
												</AccountEditForm>
											{/if}
										{/if}
									</div>
								{/each}
							{/if}

							<!-- Add Account Flow -->
							<div class="pt-1">
						{#if claudeCodeSetupStep === 'idle' || claudeCodeReauthAccountId !== null}
							<button
								type="button"
								class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-dashed border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors w-full justify-center"
								onclick={startClaudeCodeSetup}
							>
								<Icon name="lucide:plus" class="w-4 h-4" />
								Add Account
							</button>
						{:else}
							{@render claudeCodeSetupFlow()}
						{/if}
							</div>

						{#snippet claudeCodeSetupFlow()}
						{#if claudeCodeSetupStep === 'loading-url'}
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
						{/snippet}
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

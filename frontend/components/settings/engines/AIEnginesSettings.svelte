<script lang="ts">
	import { onMount } from 'svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { settingsModalState, clearEngineFocus, setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType } from '$shared/types/unified';
	import { claudeAccountsStore } from '$frontend/stores/features/claude-accounts.svelte';
	import { copilotAccountsStore } from '$frontend/stores/features/copilot-accounts.svelte';
	import { codexAccountsStore } from '$frontend/stores/features/codex-accounts.svelte';
	import { qwenAccountsStore } from '$frontend/stores/features/qwen-accounts.svelte';
	import { piAccountsStore } from '$frontend/stores/features/pi-accounts.svelte';
	import { clineAccountsStore } from '$frontend/stores/features/cline-accounts.svelte';
	import { cursorAccountsStore } from '$frontend/stores/features/cursor-accounts.svelte';
	import { opencodeProvidersStore } from '$frontend/stores/features/opencode-providers.svelte';
	import ClaudeCodePanel from './panels/ClaudeCodePanel.svelte';
	import CopilotPanel from './panels/CopilotPanel.svelte';
	import CodexPanel from './panels/CodexPanel.svelte';
	import QwenPanel from './panels/QwenPanel.svelte';
	import PiPanel from './panels/PiPanel.svelte';
	import ClinePanel from './panels/ClinePanel.svelte';
	import CursorPanel from './panels/CursorPanel.svelte';
	import OpenCodePanel from './panels/OpenCodePanel.svelte';
	import type {
		ClaudeCodeStatus,
		OpenCodeStatus,
		CopilotStatus,
		CodexStatus,
		QwenStatus,
		PiStatus,
		ClineStatus,
		CursorStatus,
	} from './panels/panel-types';

	interface Props {
		showHeader?: boolean;
		compact?: boolean;
		/**
		 * Override for the "Open Stack" action shown when an engine isn't installed.
		 * In the Settings modal this defaults to routing to the Stack section; the
		 * setup Wizard passes a callback that returns to its Stack step instead.
		 */
		onOpenStack?: () => void;
	}
	const { showHeader = true, compact = false, onOpenStack }: Props = $props();

	let activeEngine = $state<EngineType>(settingsModalState.engineFocus ?? 'claude-code');

	// Consume engineFocus deep-link requests (set when other settings pages
	// route the user here, e.g. EngineModelPicker's "Go to Engines" button).
	$effect(() => {
		if (settingsModalState.engineFocus) {
			activeEngine = settingsModalState.engineFocus;
			clearEngineFocus();
		}
	});

	// ── Per-engine status (fetched here for the selector grid, passed down to panels) ──
	let claudeCodeStatus = $state<ClaudeCodeStatus | null>(null);
	let isLoadingClaudeCodeStatus = $state(true);
	const claudeCodeAccounts = $derived(claudeAccountsStore.accounts);

	let openCodeStatus = $state<OpenCodeStatus | null>(null);
	let isLoadingOpenCodeStatus = $state(true);

	let copilotStatus = $state<CopilotStatus | null>(null);
	let isLoadingCopilotStatus = $state(true);
	const copilotAccounts = $derived(copilotAccountsStore.accounts);

	let codexStatus = $state<CodexStatus | null>(null);
	let isLoadingCodexStatus = $state(true);
	const codexAccounts = $derived(codexAccountsStore.accounts);

	let qwenStatus = $state<QwenStatus | null>(null);
	let isLoadingQwenStatus = $state(true);
	const qwenAccounts = $derived(qwenAccountsStore.accounts);

	let piStatus = $state<PiStatus | null>(null);
	let isLoadingPiStatus = $state(true);
	const piAccounts = $derived(piAccountsStore.accounts);

	let clineStatus = $state<ClineStatus | null>(null);
	let isLoadingClineStatus = $state(true);
	const clineAccounts = $derived(clineAccountsStore.accounts);

	let cursorStatus = $state<CursorStatus | null>(null);
	let isLoadingCursorStatus = $state(true);
	const cursorAccounts = $derived(cursorAccountsStore.accounts);

	const ocProviders = $derived(opencodeProvidersStore.providers);

	// Status of the currently-selected engine, for the not-installed notice below.
	const activeStatus = $derived(
		activeEngine === 'claude-code' ? claudeCodeStatus :
		activeEngine === 'opencode' ? openCodeStatus :
		activeEngine === 'copilot' ? copilotStatus :
		activeEngine === 'codex' ? codexStatus :
		activeEngine === 'qwen' ? qwenStatus :
		activeEngine === 'pi' ? piStatus :
		activeEngine === 'cline' ? clineStatus :
		cursorStatus
	);

	async function refreshClaudeCodeStatus() {
		isLoadingClaudeCodeStatus = true;
		try {
			claudeCodeStatus = await ws.http('engine:claude-status', {});
			if (claudeCodeStatus?.installed) {
				await claudeAccountsStore.refresh();
			}
		} catch {
			claudeCodeStatus = null;
		}
		isLoadingClaudeCodeStatus = false;
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

	async function refreshClineStatus() {
		isLoadingClineStatus = true;
		try {
			clineStatus = await ws.http('engine:cline-status', {});
			if (clineStatus?.installed) await clineAccountsStore.refresh();
		} catch {
			clineStatus = null;
		}
		isLoadingClineStatus = false;
	}

	async function refreshCursorStatus() {
		isLoadingCursorStatus = true;
		try {
			cursorStatus = await ws.http('engine:cursor-status', {});
			if (cursorStatus?.installed) await cursorAccountsStore.refresh();
		} catch {
			cursorStatus = null;
		}
		isLoadingCursorStatus = false;
	}

	onMount(async () => {
		await Promise.all([
			refreshClaudeCodeStatus(),
			refreshOpenCodeStatus(),
			refreshCopilotStatus(),
			refreshCodexStatus(),
			refreshQwenStatus(),
			refreshPiStatus(),
			refreshClineStatus(),
			refreshCursorStatus(),
		]);
	});
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
				eng.type === 'pi' ? { installed: piStatus?.installed ?? null, count: piAccounts.length } :
				eng.type === 'cline' ? { installed: clineStatus?.installed ?? null, count: clineAccounts.length } :
				{ installed: cursorStatus?.installed ?? null, count: cursorAccounts.length }}
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
		{#if activeStatus && activeStatus.installed === false}
			<div class="flex items-start gap-3 p-4 rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10">
				<svg viewBox="0 0 24 24" fill="none" class="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" aria-hidden="true">
					<path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
				<div class="flex-1 min-w-0">
					<p class="text-sm text-amber-900 dark:text-amber-100">
						Engine "{activeEngine}" is not installed. Open Settings → Stack to install it before using this engine.
					</p>
					<button
						type="button"
						class="mt-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-amber-600 hover:bg-amber-700 text-white cursor-pointer transition-colors"
						onclick={() => (onOpenStack ? onOpenStack() : setActiveSection('stack'))}
					>
						Open Stack
					</button>
				</div>
			</div>
		{:else if activeEngine === 'claude-code'}
			<ClaudeCodePanel status={claudeCodeStatus} isLoading={isLoadingClaudeCodeStatus} />
		{:else if activeEngine === 'copilot'}
			<CopilotPanel status={copilotStatus} isLoading={isLoadingCopilotStatus} onRefreshStatus={refreshCopilotStatus} />
		{:else if activeEngine === 'codex'}
			<CodexPanel status={codexStatus} isLoading={isLoadingCodexStatus} onRefreshStatus={refreshCodexStatus} />
		{:else if activeEngine === 'qwen'}
			<QwenPanel status={qwenStatus} isLoading={isLoadingQwenStatus} onRefreshStatus={refreshQwenStatus} />
		{:else if activeEngine === 'pi'}
			<PiPanel status={piStatus} isLoading={isLoadingPiStatus} onRefreshStatus={refreshPiStatus} />
		{:else if activeEngine === 'cline'}
			<ClinePanel status={clineStatus} isLoading={isLoadingClineStatus} onRefreshStatus={refreshClineStatus} />
		{:else if activeEngine === 'cursor'}
			<CursorPanel status={cursorStatus} isLoading={isLoadingCursorStatus} onRefreshStatus={refreshCursorStatus} />
		{:else if activeEngine === 'opencode'}
			<OpenCodePanel status={openCodeStatus} isLoading={isLoadingOpenCodeStatus} />
		{/if}
	</div>
</div>

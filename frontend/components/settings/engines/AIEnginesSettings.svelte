<script lang="ts">
	import { onMount } from 'svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { settingsModalState, clearEngineFocus } from '$frontend/stores/ui/settings-modal.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import type { EngineType } from '$shared/types/unified';
	import { claudeAccountsStore } from '$frontend/stores/features/claude-accounts.svelte';
	import { copilotAccountsStore } from '$frontend/stores/features/copilot-accounts.svelte';
	import { codexAccountsStore } from '$frontend/stores/features/codex-accounts.svelte';
	import { qwenAccountsStore } from '$frontend/stores/features/qwen-accounts.svelte';
	import { piAccountsStore } from '$frontend/stores/features/pi-accounts.svelte';
	import { clineAccountsStore } from '$frontend/stores/features/cline-accounts.svelte';
	import { opencodeProvidersStore } from '$frontend/stores/features/opencode-providers.svelte';
	import ClaudeCodePanel from './panels/ClaudeCodePanel.svelte';
	import CopilotPanel from './panels/CopilotPanel.svelte';
	import CodexPanel from './panels/CodexPanel.svelte';
	import QwenPanel from './panels/QwenPanel.svelte';
	import PiPanel from './panels/PiPanel.svelte';
	import ClinePanel from './panels/ClinePanel.svelte';
	import OpenCodePanel from './panels/OpenCodePanel.svelte';
	import type {
		ClaudeCodeStatus,
		OpenCodeStatus,
		CopilotStatus,
		CodexStatus,
		QwenStatus,
		PiStatus,
		ClineStatus,
	} from './panels/panel-types';

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

	const ocProviders = $derived(opencodeProvidersStore.providers);

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

	onMount(async () => {
		await Promise.all([
			refreshClaudeCodeStatus(),
			refreshOpenCodeStatus(),
			refreshCopilotStatus(),
			refreshCodexStatus(),
			refreshQwenStatus(),
			refreshPiStatus(),
			refreshClineStatus(),
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
				{ installed: clineStatus?.installed ?? null, count: clineAccounts.length }}
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
		{:else if activeEngine === 'opencode'}
			<OpenCodePanel status={openCodeStatus} isLoading={isLoadingOpenCodeStatus} />
		{/if}
	</div>
</div>

<script lang="ts">
	import { onMount } from 'svelte';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/utils/theme';
	import { settingsModalState, clearEngineFocus } from '$frontend/stores/ui/settings-modal.svelte';
	import { DEFAULT_ENGINE, ENGINES } from '$shared/constants/engines';
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
	import ToolInstallCard from '../stack/ToolInstallCard.svelte';
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
	}
	const { showHeader = true, compact = false }: Props = $props();

	// Opens on the DEFAULT engine, not a hardcoded one. It is the engine a fresh
	// install actually gets, the first card in `ENGINES`, and the one every other
	// default points at — landing on a different panel made Clopen look like it
	// shipped with Claude Code and left the user to discover otherwise.
	let activeEngine = $state<EngineType>(settingsModalState.engineFocus ?? DEFAULT_ENGINE);

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
			claudeCodeStatus = await ws.http('agents:claude-status', {});
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
			openCodeStatus = await ws.http('agents:opencode-status', {});
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
			copilotStatus = await ws.http('agents:copilot-status', {});
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
			codexStatus = await ws.http('agents:codex-status', {});
			await codexAccountsStore.refresh();
		} catch {
			codexStatus = null;
		}
		isLoadingCodexStatus = false;
	}

	async function refreshQwenStatus() {
		isLoadingQwenStatus = true;
		try {
			qwenStatus = await ws.http('agents:qwen-status', {});
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
			piStatus = await ws.http('agents:pi-status', {});
			if (piStatus?.installed) await piAccountsStore.refresh();
		} catch {
			piStatus = null;
		}
		isLoadingPiStatus = false;
	}

	async function refreshClineStatus() {
		isLoadingClineStatus = true;
		try {
			clineStatus = await ws.http('agents:cline-status', {});
			if (clineStatus?.installed) await clineAccountsStore.refresh();
		} catch {
			clineStatus = null;
		}
		isLoadingClineStatus = false;
	}

	async function refreshCursorStatus() {
		isLoadingCursorStatus = true;
		try {
			cursorStatus = await ws.http('agents:cursor-status', {});
			if (cursorStatus?.installed) await cursorAccountsStore.refresh();
		} catch {
			cursorStatus = null;
		}
		isLoadingCursorStatus = false;
	}

	/** The install tool behind each agent. */
	const INSTALL_TOOL: Record<EngineType, 'claude' | 'opencode' | 'copilot' | 'codex' | 'qwen' | 'pi' | 'cline' | 'cursor'> = {
		'claude-code': 'claude',
		opencode: 'opencode',
		copilot: 'copilot',
		codex: 'codex',
		qwen: 'qwen',
		pi: 'pi',
		cline: 'cline',
		cursor: 'cursor'
	};

	const REFRESH: Record<string, () => Promise<void>> = {
		claude: refreshClaudeCodeStatus,
		opencode: refreshOpenCodeStatus,
		copilot: refreshCopilotStatus,
		codex: refreshCodexStatus,
		qwen: refreshQwenStatus,
		pi: refreshPiStatus,
		cline: refreshClineStatus,
		cursor: refreshCursorStatus
	};

	// An agent installed right here (or anywhere) moves on to "Sign in" at once.
	$effect(() =>
		ws.on('agents:install-finished', (payload: { tool: string; status: string }) => {
			if (payload.status === 'success') void REFRESH[payload.tool]?.();
		})
	);

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
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Agents</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">Install, sign in, ready.</p>
		</div>
	{/if}

	<!-- Engines: compact chips, like every engine choice — a dot says where each one stands. -->
	<div class="flex flex-wrap gap-1.5 mb-6" role="tablist" aria-label="Agents">
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
			{@const ready = stat.installed === true && (stat.count > 0 || eng.type === 'opencode')}
			{@const state = stat.installed === false ? 'Not installed' : stat.installed === null ? 'Checking' : ready ? (stat.count > 0 ? 'Ready' : 'Ready · free') : 'Sign in'}
			<button
				type="button"
				role="tab"
				aria-selected={isActive}
				class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-colors
					{isActive
						? 'border-violet-500 bg-violet-500/10 text-violet-700 dark:text-violet-300'
						: 'border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:border-violet-500/40'}"
				onclick={() => { activeEngine = eng.type; }}
				title={`${eng.name} · ${state}`}
			>
				<span class="shrink-0 flex items-center justify-center w-4 h-4 [&>svg]:w-4 [&>svg]:h-4">
					{@html isDarkMode() ? eng.icon.dark : eng.icon.light}
				</span>
				{eng.name}
				<span class="w-1.5 h-1.5 rounded-full shrink-0 {ready ? 'bg-emerald-500' : stat.installed === false ? 'bg-slate-300 dark:bg-slate-600' : stat.installed === null ? 'bg-slate-200 dark:bg-slate-700' : 'bg-amber-500'}" aria-label={state}></span>
			</button>
		{/each}
	</div>

	<!-- Active engine pane -->
	<div class="space-y-6">
		{#if activeStatus && activeStatus.installed === false}
			<!-- Install here, then sign in below — no detour through a separate list. -->
			{@const engine = ENGINES.find((entry) => entry.type === activeEngine)}
			<ToolInstallCard tool={INSTALL_TOOL[activeEngine]} title={engine?.name ?? activeEngine} description="Install it, then sign in here." />
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

<script lang="ts">
	/**
	 * Settings → Integrations.
	 *
	 * ONE list of everything Clopen can use, whatever it came from: built-in
	 * tools, connected accounts, and hand-installed MCP servers. This section
	 * ABSORBS the old Connectors section rather than sitting beside it — two
	 * places to connect a service means two tokens in two tables.
	 *
	 * Browsing the official MCP registry and installing anything from it is
	 * exactly as possible as it was. It just stops being the front door.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import AddIntegrationModal from './AddIntegrationModal.svelte';
	import ConnectAccountModal from './ConnectAccountModal.svelte';
	import IntegrationDetail from './IntegrationDetail.svelte';
	import McpBrowseModal from './McpBrowseModal.svelte';
	import McpManualModal from './McpManualModal.svelte';
	import { CATEGORY_ICONS } from './capabilities';
	import { transportLabel } from './mcp-config-draft.svelte';
	import { integrationsStore } from '$frontend/stores/features/integrations.svelte';
	import { mcpServersStore, type InstalledMcpServer, type McpHealthState } from '$frontend/stores/features/mcp-servers.svelte';
	import { getProviderIcon } from '$shared/constants/tool-icons';
	import ws from '$frontend/utils/ws';
	import { isDarkMode } from '$frontend/stores/ui/theme.svelte';
	import { settingsModalState } from '$frontend/stores/ui/settings-modal.svelte';
	import type { IntegrationAccountInfo, IntegrationProviderInfo } from '$shared/types/integrations';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		showHeader?: boolean;
	}

	const { showHeader = true }: Props = $props();

	type RowKind = 'builtin' | 'apps' | 'custom';

	interface HubRow {
		key: string;
		kind: RowKind;
		name: string;
		description: string | null;
		server: InstalledMcpServer | null;
		account: IntegrationAccountInfo | null;
		provider: IntegrationProviderInfo | null;
	}

	const FILTERS: { id: 'all' | RowKind; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'builtin', label: 'Built-in' },
		// Not "Accounts": every row here is an account of some kind, including the
		// built-in ones. What sets these apart is that they are external services
		// you authorised, and "Apps" is both the word those services use for it
		// and the only one short enough to sit in a row of one-word chips.
		{ id: 'apps', label: 'Apps' },
		{ id: 'custom', label: 'Custom MCP' }
	];

	let filter = $state<'all' | RowKind>('all');
	let search = $state('');

	let addOpen = $state(false);
	let browseOpen = $state(false);
	let manualOpen = $state(false);
	let detailKey = $state<string | null>(null);
	let connectProvider = $state<IntegrationProviderInfo | null>(null);
	let connectAccount = $state<IntegrationAccountInfo | null>(null);

	const installed = $derived(mcpServersStore.installed);
	const statuses = $derived(mcpServersStore.statuses);
	const accountByMcpTarget = $derived(integrationsStore.accountByMcpTarget);
	const providerById = $derived(integrationsStore.providerById);
	const secretsHealth = $derived(integrationsStore.secretsHealth);

	onMount(() => {
		void (async () => {
			await Promise.all([
				mcpServersStore.refreshInstalled(),
				integrationsStore.refresh(),
				integrationsStore.refreshSecretsHealth()
			]);
			mcpServersStore.checkAllStatuses();
		})();

		// An account connected from anywhere — another admin, or a surface's own
		// connect entry point — creates and removes connector rows here, so both
		// lists have to be refreshed, not just the one that changed.
		return ws.on('integrations:changed', () => {
			void integrationsStore.refresh();
			void mcpServersStore.refreshInstalled();
		});
	});

	/**
	 * One row per usable thing.
	 *
	 * An account whose capabilities have no surface yet still gets a row — it is
	 * connected, and hiding it would make "connected" mean "connected and also
	 * projecting something", which is not what the user did.
	 */
	const rows = $derived.by<HubRow[]>(() => {
		const out: HubRow[] = [];
		const claimedAccounts = new Set<string>();

		for (const server of installed) {
			const account = accountByMcpTarget[String(server.id)] ?? null;
			if (account) claimedAccounts.add(account.id);
			out.push({
				key: `mcp:${server.id}`,
				kind: server.source === 'internal' ? 'builtin' : account ? 'apps' : 'custom',
				name: server.name,
				description: server.description,
				server,
				account,
				provider: account ? providerById[account.provider] ?? null : null
			});
		}

		for (const account of integrationsStore.accounts) {
			if (claimedAccounts.has(account.id)) continue;
			const provider = providerById[account.provider] ?? null;
			out.push({
				key: `account:${account.id}`,
				kind: 'apps',
				name: account.label,
				description: provider?.description ?? null,
				server: null,
				account,
				provider
			});
		}

		// Built-ins first — they are always present and always work, so they are
		// the least interesting thing to scroll past looking for a problem.
		return out.sort((a, b) => {
			const rank = (row: HubRow) => (row.kind === 'builtin' ? 0 : row.kind === 'apps' ? 1 : 2);
			return rank(a) - rank(b) || a.name.localeCompare(b.name);
		});
	});

	const visibleRows = $derived.by(() => {
		const query = search.trim().toLowerCase();
		return rows
			.filter(row => filter === 'all' || row.kind === filter)
			.filter(row => !query || `${row.name} ${row.description ?? ''}`.toLowerCase().includes(query));
	});

	const detailRow = $derived(visibleRows.find(row => row.key === detailKey) ?? rows.find(row => row.key === detailKey) ?? null);

	function statusMeta(state: McpHealthState): { label: string; icon: IconName; class: string } {
		switch (state) {
			case 'ok': return { label: 'Connected', icon: 'lucide:circle-check', class: 'text-emerald-600 dark:text-emerald-400' };
			case 'needs_auth': return { label: 'Needs sign-in', icon: 'lucide:lock', class: 'text-amber-600 dark:text-amber-400' };
			case 'needs_config': return { label: 'Needs setup', icon: 'lucide:key', class: 'text-amber-600 dark:text-amber-400' };
			case 'unreachable': return { label: 'Unreachable', icon: 'lucide:wifi-off', class: 'text-red-500 dark:text-red-400' };
			case 'error': return { label: 'Error', icon: 'lucide:triangle-alert', class: 'text-red-500 dark:text-red-400' };
			case 'local': return { label: 'Connected', icon: 'lucide:circle-check', class: 'text-emerald-600 dark:text-emerald-400' };
		}
	}

	/** The brand mark, or null when the provider has no artwork yet. */
	function brandMark(providerId: string | undefined): string | null {
		if (!providerId) return null;
		const icon = getProviderIcon(providerId);
		if (!icon) return null;
		return isDarkMode() ? icon.dark : icon.light;
	}

	function fallbackIcon(row: HubRow): IconName {
		if (row.provider) return CATEGORY_ICONS[row.provider.category];
		return 'lucide:plug';
	}

	function openDetail(row: HubRow) {
		detailKey = row.key;
	}

	function startConnect(provider: IntegrationProviderInfo) {
		addOpen = false;
		connectAccount = null;
		connectProvider = provider;
	}

	function startReconfigure(account: IntegrationAccountInfo, provider: IntegrationProviderInfo) {
		connectAccount = account;
		connectProvider = provider;
	}

	function closeConnect() {
		connectProvider = null;
		connectAccount = null;
	}

	/**
	 * Honour a deep-link that named the provider it wants connected.
	 *
	 * Waits for the registry to arrive, because the caller knows an id and this
	 * dialog needs the declaration behind it. The request is cleared whatever
	 * happens — including when the provider is unknown or already connected —
	 * so it cannot fire again the next time Integrations is opened.
	 */
	$effect(() => {
		const wanted = settingsModalState.integrationFocusProvider;
		if (!wanted) return;

		const providers = integrationsStore.providers;
		if (providers.length === 0) return;

		settingsModalState.integrationFocusProvider = null;

		const provider = providers.find((candidate) => candidate.id === wanted);
		if (!provider) return;

		const existing = integrationsStore.accounts.find((account) => account.provider === wanted);
		if (existing) {
			// Opening Connect on a provider that is already set up would look like
			// Clopen forgot. Land on its row instead.
			detailKey = `account:${existing.id}`;
			return;
		}

		startConnect(provider);
	});
</script>

<div class="space-y-5">
	{#if showHeader}
		<div>
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Integrations</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500">
				Connect a service here; use it in the panel that owns that work.
			</p>
		</div>
	{/if}

	<!-- Secrets banner. Only shows when something is actually wrong: a key that
	     cannot open stored values, or a column still holding plaintext. -->
	{#if secretsHealth && (secretsHealth.failureCount > 0 || secretsHealth.unsealedColumns.length > 0)}
		<div class="flex items-start gap-2 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg text-amber-700 dark:text-amber-300">
			<Icon name="lucide:key-round" class="w-4 h-4 mt-0.5 shrink-0" />
			<div class="space-y-1 text-xs">
				{#if secretsHealth.failureCount > 0}
					<p>
						{secretsHealth.failureCount} stored credential{secretsHealth.failureCount === 1 ? '' : 's'}
						could not be decrypted with the active key
						(<span class="font-mono">{secretsHealth.keyFingerprint}</span>, from
						{secretsHealth.keySource === 'env' ? 'CLOPEN_MASTER_KEY' : 'the data directory'}).
						{#if secretsHealth.unknownKeyFingerprints.length > 0}
							They were sealed with
							<span class="font-mono">{secretsHealth.unknownKeyFingerprints.join(', ')}</span> —
							restore that key, or re-enter the credentials.
						{/if}
					</p>
				{/if}
				{#if secretsHealth.unsealedColumns.length > 0}
					<p>
						Some stored secrets are still unencrypted
						({secretsHealth.unsealedColumns.map(c => `${c.table}.${c.column}`).join(', ')}).
					</p>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Two fixed rows rather than one that wraps.
	     Pills, a search box and several buttons on a single flex line reflow into
	     a different arrangement at every panel width, and the panel is resizable.
	     One row of controls plus one row of pills looks the same at any width. -->
	<div class="space-y-2">
		<div class="flex items-center gap-2">
			<div class="relative flex-1 min-w-0">
				<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
					<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
					<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				<input
					type="text"
					bind:value={search}
					placeholder="Filter integrations…"
					class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
				/>
			</div>
			<Button variant="primary" size="sm" class="gap-1.5 shrink-0" onclick={() => (addOpen = true)}>
				<Icon name="lucide:plus" class="w-4 h-4" />
				Add
			</Button>
		</div>
		<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg overflow-x-auto">
			{#each FILTERS as entry (entry.id)}
				<button
					type="button"
					class="px-3 py-1.5 text-sm font-semibold rounded-md transition-colors whitespace-nowrap
						{filter === entry.id
						? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
						: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => (filter = entry.id)}
				>
					{entry.label}
				</button>
			{/each}
		</div>
	</div>

	<!-- Everything in use -->
	{#if visibleRows.length === 0}
		<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">
			{search.trim() ? `Nothing matches "${search.trim()}".` : 'Nothing here yet.'}
		</p>
	{:else}
		<div class="space-y-3">
			{#each visibleRows as row (row.key)}
				{@const mark = brandMark(row.provider?.id)}
				<button
					type="button"
					onclick={() => openDetail(row)}
					class="w-full text-left flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl hover:border-violet-500/40 transition-colors"
				>
					{#if mark}
						<span class="w-5 h-5 mt-0.5 shrink-0 [&>svg]:w-full [&>svg]:h-full">{@html mark}</span>
					{:else}
						<Icon
							name={fallbackIcon(row)}
							class="w-5 h-5 mt-0.5 shrink-0 {row.server?.enabled === false ? 'text-slate-400' : 'text-violet-600'}"
						/>
					{/if}
					<div class="flex-1 min-w-0">
						<span class="font-semibold text-slate-900 dark:text-slate-100">{row.name}</span>
						<div class="flex items-center gap-1.5 flex-wrap mt-1">
							{#if row.kind === 'builtin'}
								<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">Built-in</span>
							{:else if row.kind === 'apps'}
								<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400">Integration</span>
							{/if}
							{#if row.server}
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{row.server.namespace}</span>
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(row.server.transport)}</span>
								{#if row.server.restrictedToolCount > 0}
									<span class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
										<Icon name="lucide:sliders-horizontal" class="w-3 h-3" />
										{row.server.restrictedToolCount} restricted
									</span>
								{/if}
							{/if}
						</div>
						{#if row.description}
							<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{row.description}</p>
						{/if}
						{#if row.server && row.server.source !== 'internal'}
							<div class="flex items-center gap-2 mt-2">
								{#if !row.server.enabled}
									<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
										<Icon name="lucide:ban" class="w-3.5 h-3.5" />
										Disabled
									</span>
								{:else if mcpServersStore.checking[row.server.id]}
									<span class="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
										<span class="w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></span>
										Checking…
									</span>
								{:else if statuses[row.server.id]}
									{@const meta = statusMeta(statuses[row.server.id].state)}
									<span class="inline-flex items-center gap-1 text-[11px] font-semibold {meta.class}">
										<Icon name={meta.icon} class="w-3.5 h-3.5" />
										{meta.label}
									</span>
								{/if}
							</div>
						{/if}
					</div>
					<Icon name="lucide:chevron-right" class="w-4 h-4 mt-1 shrink-0 text-slate-300 dark:text-slate-600" />
				</button>
			{/each}
		</div>
	{/if}
</div>

<IntegrationDetail
	isOpen={detailRow !== null}
	server={detailRow?.server ?? null}
	account={detailRow?.account ?? null}
	provider={detailRow?.provider ?? null}
	onClose={() => (detailKey = null)}
	onReconfigureAccount={(account, provider) => { detailKey = null; startReconfigure(account, provider); }}
/>

<AddIntegrationModal
	isOpen={addOpen}
	onClose={() => (addOpen = false)}
	onConnect={startConnect}
	onBrowseRegistry={() => { addOpen = false; browseOpen = true; }}
	onAddManually={() => { addOpen = false; manualOpen = true; }}
/>

<ConnectAccountModal
	provider={connectProvider}
	account={connectAccount}
	onClose={closeConnect}
/>

<McpBrowseModal isOpen={browseOpen} onClose={() => (browseOpen = false)} />
<McpManualModal isOpen={manualOpen} onClose={() => (manualOpen = false)} />

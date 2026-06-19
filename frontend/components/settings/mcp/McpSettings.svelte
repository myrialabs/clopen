<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import {
		mcpServersStore,
		type CatalogServer,
		type InstalledMcpServer
	} from '$frontend/stores/features/mcp-servers.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		showHeader?: boolean;
	}

	const { showHeader = true }: Props = $props();

	type Tab = 'installed' | 'browse';
	let activeTab = $state<Tab>('installed');

	// Restore the previous search term so the input and the persisted results
	// stay consistent when the modal is reopened.
	let searchInput = $state(mcpServersStore.catalogSearch);
	let installedFilter = $state('');
	let busyId = $state<number | null>(null);

	// Sentinel for infinite scroll in Browse tab
	let sentinelEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const el = sentinelEl;
		if (!el) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && mcpServersStore.catalogCursor && !mcpServersStore.catalogLoading) {
					mcpServersStore.loadMoreCatalog();
				}
			},
			{ rootMargin: '200px' }
		);
		observer.observe(el);
		return () => observer.disconnect();
	});

	// Install modal
	let installTarget = $state<CatalogServer | null>(null);
	let envDraft = $state<Record<string, string>>({});
	let headerDraft = $state<Record<string, string>>({});
	let installing = $state(false);
	let installError = $state<string | null>(null);

	// Configure modal (set env / headers on an installed server)
	let configTarget = $state<InstalledMcpServer | null>(null);
	let configRows = $state<{ key: string; value: string }[]>([]);
	let savingConfig = $state(false);

	// Delete confirmation modal
	let deleteTarget = $state<InstalledMcpServer | null>(null);
	let deleting = $state(false);

	const installed = $derived(mcpServersStore.installed);
	const catalog = $derived(mcpServersStore.catalog);
	const installedRegistryNames = $derived(mcpServersStore.installedRegistryNames);

	// Built-in (internal) servers always sort to the top of the installed list.
	const sortedInstalled = $derived.by(() =>
		[...installed].sort((a, b) => {
			const ai = a.source === 'internal' ? 0 : 1;
			const bi = b.source === 'internal' ? 0 : 1;
			return ai - bi;
		})
	);

	// Frontend-only filtering of the installed list (no server round-trip).
	const filteredInstalled = $derived.by(() => {
		const q = installedFilter.trim().toLowerCase();
		if (!q) return sortedInstalled;
		return sortedInstalled.filter(s =>
			`${s.name} ${s.slug} ${s.description ?? ''}`.toLowerCase().includes(q)
		);
	});

	onMount(() => {
		mcpServersStore.refreshInstalled();
	});

	function transportLabel(t: string): string {
		if (t === 'stdio') return 'local (stdio)';
		if (t === 'sse') return 'remote (sse)';
		return 'remote (http)';
	}

	function commandLine(s: { transport: string; command?: string | null; args?: string[]; url?: string | null }): string {
		if (s.transport === 'stdio') return `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim();
		return s.url ?? '';
	}

	async function onToggle(server: InstalledMcpServer) {
		busyId = server.id;
		try {
			await mcpServersStore.toggle(server.id, !server.enabled);
			mcpServersStore.hasPendingChanges = true;
		} catch (error) {
			debug.error('settings', 'toggle MCP failed', error);
		} finally {
			busyId = null;
		}
	}

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		try {
			await mcpServersStore.uninstall(deleteTarget.id);
			mcpServersStore.hasPendingChanges = true;
			deleteTarget = null;
		} catch (error) {
			debug.error('settings', 'uninstall MCP failed', error);
		} finally {
			deleting = false;
		}
	}

	function goBrowse() {
		activeTab = 'browse';
		if (catalog.length === 0 && !mcpServersStore.catalogLoading) mcpServersStore.loadCatalog(false);
	}

	function runSearch() {
		mcpServersStore.searchCatalog(searchInput.trim());
	}

	function cleanMap(obj: Record<string, string>): Record<string, string> {
		return Object.fromEntries(Object.entries(obj).filter(([, v]) => v.trim() !== ''));
	}

	// --- Install flow (modal + confirmation) ---
	function openInstall(server: CatalogServer) {
		installError = null;
		installTarget = server;
		envDraft = Object.fromEntries(server.envVars.map(v => [v.name, v.default ?? '']));
		headerDraft = Object.fromEntries(server.headerVars.map(v => [v.name, v.default ?? '']));
	}

	function closeInstall() {
		installTarget = null;
		envDraft = {};
		headerDraft = {};
		installError = null;
	}

	async function confirmInstall() {
		const server = installTarget;
		if (!server) return;
		const missing = [
			...server.envVars.filter(v => v.isRequired && !(envDraft[v.name] ?? '').trim()),
			...server.headerVars.filter(v => v.isRequired && !(headerDraft[v.name] ?? '').trim())
		];
		if (missing.length > 0) {
			installError = `Required: ${missing.map(m => m.name).join(', ')}`;
			return;
		}
		installing = true;
		installError = null;
		try {
			await mcpServersStore.install({
				slug: server.slug,
				name: server.title,
				description: server.description,
				registryName: server.registryName,
				version: server.version,
				transport: server.transport,
				command: server.command,
				args: server.args,
				url: server.url,
				env: cleanMap(envDraft),
				headers: cleanMap(headerDraft),
				source: 'registry'
			});
			mcpServersStore.hasPendingChanges = true;
			closeInstall();
		} catch (error) {
			installError = error instanceof Error ? error.message : 'Install failed';
		} finally {
			installing = false;
		}
	}

	// --- Configure flow (set env / headers after install) ---
	function openConfig(server: InstalledMcpServer) {
		configTarget = server;
		// stdio servers configure env vars; remote servers configure headers.
		const keys = server.transport === 'stdio' ? server.envKeys : server.headerKeys;
		configRows = keys.length > 0
			? keys.map(key => ({ key, value: '' }))
			: [{ key: '', value: '' }];
	}

	function closeConfig() {
		configTarget = null;
		configRows = [];
	}

	function addConfigRow() {
		configRows = [...configRows, { key: '', value: '' }];
	}

	function removeConfigRow(index: number) {
		configRows = configRows.filter((_, i) => i !== index);
	}

	async function saveConfig() {
		const server = configTarget;
		if (!server) return;
		savingConfig = true;
		try {
			const map: Record<string, string> = {};
			for (const row of configRows) {
				if (row.key.trim() && row.value.trim()) map[row.key.trim()] = row.value;
			}
			// updateConfig overwrites both columns; send the map to the relevant
			// one for this transport and leave the other empty.
			if (server.transport === 'stdio') {
				await mcpServersStore.updateConfig(server.id, map, {});
			} else {
				await mcpServersStore.updateConfig(server.id, {}, map);
			}
			closeConfig();
		} catch (error) {
			debug.error('settings', 'update MCP config failed', error);
		} finally {
			savingConfig = false;
		}
	}
</script>

<div class="space-y-6">
	<!-- Header row: title/description on left, tabs on right -->
	<div class="flex items-start justify-between gap-3">
		{#if showHeader}
			<div>
				<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">MCP Servers</h3>
				<p class="text-sm text-slate-600 dark:text-slate-500">
					Built-in tools plus external servers from the official MCP registry.
				</p>
			</div>
		{:else}
			<div></div>
		{/if}
		<!-- Tabs -->
		<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg shrink-0">
			<button
				type="button"
				class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
					{activeTab === 'installed'
					? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => (activeTab = 'installed')}
			>
				Installed{installed.length ? ` (${installed.length})` : ''}
			</button>
			<button
				type="button"
				class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
					{activeTab === 'browse'
					? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={goBrowse}
			>
				Browse registry
			</button>
		</div>
	</div>

	{#if activeTab === 'installed'}
		{#if installed.length === 0}
			<div class="flex flex-col items-center gap-2 py-10 text-center">
				<Icon name="lucide:plug" class="w-8 h-8 text-slate-400" />
				<p class="text-sm text-slate-500 dark:text-slate-400">No MCP servers installed yet.</p>
				<Button variant="outline" size="sm" onclick={goBrowse}>Browse the registry</Button>
			</div>
		{:else}
			<div class="relative">
				<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
					<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
					<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				<input
					type="text"
					bind:value={installedFilter}
					placeholder="Filter installed servers…"
					class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
				/>
			</div>
			{#if filteredInstalled.length === 0}
				<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No installed server matches "{installedFilter}".</p>
			{:else}
				<div class="space-y-3">
					{#each filteredInstalled as server (server.id)}
						<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
							<Icon name="lucide:plug" class="w-5 h-5 mt-0.5 shrink-0 {server.enabled ? 'text-violet-600' : 'text-slate-400'}" />
							<div class="flex-1 min-w-0">
								<span class="font-semibold text-slate-900 dark:text-slate-100">{server.name}</span>
								<div class="flex items-center gap-1.5 flex-wrap mt-1">
									{#if server.source === 'internal'}
										<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">Built-in</span>
									{/if}
									<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{server.namespace}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(server.transport)}</span>
									{#if server.version}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">v{server.version}</span>
									{/if}
								</div>
								{#if server.description}
									<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{server.description}</p>
								{/if}
								{#if server.source !== 'internal'}
									<p class="text-[11px] font-mono text-slate-400 mt-1 truncate">{commandLine(server)}</p>
									{#if server.envKeys.length > 0}
										<p class="text-[11px] text-slate-400 mt-0.5">env: {server.envKeys.join(', ')}</p>
									{/if}
								{/if}
							</div>
							<div class="flex items-center gap-2 shrink-0">
								<button
									type="button"
									role="switch"
									aria-checked={server.enabled}
									disabled={busyId === server.id}
									onclick={() => onToggle(server)}
									class="relative w-10 h-6 rounded-full transition-colors disabled:opacity-50
										{server.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
									aria-label={server.enabled ? 'Disable server' : 'Enable server'}
								>
									<span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform {server.enabled ? 'translate-x-4' : ''}"></span>
								</button>
								{#if server.source !== 'internal'}
									<button
										type="button"
										onclick={() => openConfig(server)}
										class="p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors"
										aria-label="Configure server"
										title="Configure credentials"
									>
										<Icon name="lucide:settings-2" class="w-4 h-4" />
									</button>
									<button
										type="button"
										disabled={busyId === server.id}
										onclick={() => (deleteTarget = server)}
										class="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
										aria-label="Uninstall server"
									>
										<Icon name="lucide:trash-2" class="w-4 h-4" />
									</button>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	{:else}
		<!-- Browse registry -->
		<form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); runSearch(); }}>
			<div class="relative flex-1">
				<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
					<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
					<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				<input
					type="text"
					bind:value={searchInput}
					placeholder="Search the MCP registry (e.g. filesystem, github)…"
					class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
				/>
			</div>
			{#if mcpServersStore.catalogLoading}
				<Button variant="outline" size="sm" onclick={() => mcpServersStore.cancelSearch()}>Cancel</Button>
			{:else}
				<Button type="submit" variant="primary" size="sm" onclick={runSearch}>Search</Button>
			{/if}
		</form>

		{#if mcpServersStore.catalogError}
			<div class="flex items-start gap-2 p-3 bg-red-500/5 border border-red-500/20 rounded-lg text-sm text-red-600 dark:text-red-400">
				<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0" />
				<span>{mcpServersStore.catalogError}</span>
			</div>
		{/if}

		{#if mcpServersStore.catalogLoadingFresh}
			<div class="space-y-3">
				{#each [0, 1, 2, 3, 4] as i (i)}
					<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl animate-pulse">
						<div class="w-5 h-5 mt-0.5 rounded bg-slate-200 dark:bg-slate-800"></div>
						<div class="flex-1 min-w-0 space-y-2">
							<div class="h-4 w-40 rounded bg-slate-200 dark:bg-slate-800"></div>
							<div class="flex gap-1.5">
								<div class="h-3.5 w-20 rounded bg-slate-200 dark:bg-slate-800"></div>
								<div class="h-3.5 w-16 rounded bg-slate-200 dark:bg-slate-800"></div>
							</div>
							<div class="h-3 w-3/4 rounded bg-slate-200 dark:bg-slate-800"></div>
						</div>
						<div class="h-8 w-16 rounded bg-slate-200 dark:bg-slate-800 shrink-0"></div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="space-y-3">
				{#each catalog as server (server.registryName)}
					{@const alreadyInstalled = installedRegistryNames.has(server.registryName)}
					<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
						<Icon name="lucide:plug" class="w-5 h-5 mt-0.5 shrink-0 text-slate-400" />
						<div class="flex-1 min-w-0">
							<span class="font-semibold text-slate-900 dark:text-slate-100">{server.title}</span>
							<div class="flex items-center gap-1.5 flex-wrap mt-1">
								<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{server.slug}</span>
								<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(server.transport)}</span>
								{#if server.version}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">v{server.version}</span>
								{/if}
								{#if server.envVars.length > 0}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{server.envVars.length} config var{server.envVars.length === 1 ? '' : 's'}</span>
								{/if}
							</div>
							{#if server.description}
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{server.description}</p>
							{/if}
							<p class="text-[11px] font-mono text-slate-400 mt-1 truncate">{server.packageHint ?? commandLine(server)}</p>
						</div>
						<div class="shrink-0">
							{#if alreadyInstalled}
								<span class="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
									<Icon name="lucide:check" class="w-4 h-4" /> installed
								</span>
							{:else}
								<Button variant="outline" size="sm" onclick={() => openInstall(server)}>Install</Button>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			{#if mcpServersStore.catalogCursor}
				<div bind:this={sentinelEl} class="h-4"></div>
			{/if}

			{#if mcpServersStore.catalogLoading && catalog.length > 0}
				<div class="flex justify-center py-4">
					<div class="w-5 h-5 border-2 border-violet-600 border-t-transparent rounded-full animate-spin"></div>
				</div>
			{/if}

			{#if catalog.length === 0 && !mcpServersStore.catalogError}
				<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No results. Try a different search.</p>
			{/if}
		{/if}
	{/if}
</div>

<!-- Install confirmation modal -->
<Modal isOpen={installTarget !== null} onClose={closeInstall} title={`Install ${installTarget?.title ?? ''}`} size="md">
	{#snippet children()}
		{#if installTarget}
			<div class="space-y-4 text-sm">
				<p class="text-slate-600 dark:text-slate-300">
					Install this MCP server? It will be available to every engine once enabled.
				</p>
				<p class="font-mono text-xs text-slate-500 break-all">{installTarget.packageHint ?? commandLine(installTarget)}</p>

				{#if installTarget.envVars.length > 0 || installTarget.headerVars.length > 0}
					<div class="space-y-3 pt-2 border-t border-slate-200 dark:border-slate-800">
						<p class="text-xs text-slate-500 dark:text-slate-400">Configuration (fill what applies — required fields are marked *):</p>
						{#each installTarget.envVars as v (v.name)}
							<Input
								label={`${v.name}${v.isRequired ? ' *' : ''}`}
								type={v.isSecret ? 'password' : 'text'}
								placeholder={v.description ?? v.name}
								bind:value={envDraft[v.name]}
							/>
						{/each}
						{#each installTarget.headerVars as v (v.name)}
							<Input
								label={`${v.name}${v.isRequired ? ' *' : ''} (header)`}
								type={v.isSecret ? 'password' : 'text'}
								placeholder={v.description ?? v.name}
								bind:value={headerDraft[v.name]}
							/>
						{/each}
					</div>
				{/if}

				{#if installError}
					<p class="text-xs text-red-500">{installError}</p>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeInstall}>Cancel</Button>
		<Button variant="primary" loading={installing} onclick={confirmInstall}>Install</Button>
	{/snippet}
</Modal>

<!-- Configure modal (env vars / auth headers) -->
<Modal isOpen={configTarget !== null} onClose={closeConfig} title={`Configure ${configTarget?.name ?? ''}`} size="md">
	{#snippet children()}
		{#if configTarget}
			<div class="space-y-4 text-sm">
				<p class="text-slate-600 dark:text-slate-300">
					{#if configTarget.transport === 'stdio'}
						Add environment variables only if this server needs them (e.g. API keys). Leave empty otherwise.
					{:else}
						Add an auth header only if this server needs one, e.g.
						<span class="font-mono">Authorization</span> = <span class="font-mono">Bearer …</span>. Leave empty for public servers.
					{/if}
				</p>

				<div class="space-y-2">
					{#each configRows as row, i (i)}
						<div class="flex gap-2 items-center">
							<div class="w-2/5">
								<Input bind:value={row.key} placeholder={configTarget.transport === 'stdio' ? 'VAR_NAME' : 'Header'} />
							</div>
							<div class="flex-1">
								<Input type="password" bind:value={row.value} placeholder="value" />
							</div>
							<button
								type="button"
								onclick={() => removeConfigRow(i)}
								class="p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
								aria-label="Remove row"
							>
								<Icon name="lucide:x" class="w-4 h-4" />
							</button>
						</div>
					{/each}
					<Button variant="ghost" size="sm" onclick={addConfigRow}>+ Add field</Button>
				</div>

				{#if configTarget.transport !== 'stdio'}
					<p class="text-[11px] text-slate-400">
						If this server signs in via OAuth (browser redirect), header auth won't apply — disable it to stop connection errors.
					</p>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeConfig}>Cancel</Button>
		<Button variant="primary" loading={savingConfig} onclick={saveConfig}>Save</Button>
	{/snippet}
</Modal>

<!-- Delete confirmation modal -->
<Modal isOpen={deleteTarget !== null} onClose={() => (deleteTarget = null)} title="Uninstall MCP server" size="sm">
	{#snippet children()}
		{#if deleteTarget}
			<p class="text-sm text-slate-600 dark:text-slate-300">
				Uninstall <span class="font-semibold text-slate-900 dark:text-slate-100">{deleteTarget.name}</span>?
				It will be removed from every engine. This can't be undone.
			</p>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
		<Button variant="primary" loading={deleting} class="!bg-red-600 hover:!bg-red-700" onclick={confirmDelete}>Uninstall</Button>
	{/snippet}
</Modal>

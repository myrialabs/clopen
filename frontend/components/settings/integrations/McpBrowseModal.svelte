<script lang="ts">
	/**
	 * Browse the official MCP registry and install from it.
	 *
	 * Still exactly as possible as it was — it just stops being the front door.
	 * The hub's own list and catalogue come first; this is reached from a button.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import McpConfigForm from './McpConfigForm.svelte';
	import { McpConfigDraft, commandLine, transportLabel } from './mcp-config-draft.svelte';
	import { mcpServersStore, type CatalogServer } from '$frontend/stores/features/mcp-servers.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	const { isOpen, onClose }: Props = $props();

	const draft = new McpConfigDraft();

	let searchInput = $state(mcpServersStore.catalogSearch);
	let sentinelEl = $state<HTMLDivElement | null>(null);

	let installTarget = $state<CatalogServer | null>(null);
	let installing = $state(false);
	let installError = $state<string | null>(null);

	const catalog = $derived(mcpServersStore.catalog);
	const installedRegistryNames = $derived(mcpServersStore.installedRegistryNames);

	// A remote catalog entry that declares no credential fields almost always
	// authenticates via OAuth — say so, so the user knows to finish sign-in from
	// the connector's detail view after installing.
	const installNeedsOAuth = $derived(
		!!installTarget && installTarget.transport !== 'stdio'
			&& installTarget.envVars.length === 0 && installTarget.headerVars.length === 0
	);

	$effect(() => {
		if (isOpen && catalog.length === 0 && !mcpServersStore.catalogLoading) {
			mcpServersStore.loadCatalog(false);
		}
	});

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

	function runSearch() {
		mcpServersStore.searchCatalog(searchInput.trim());
	}

	function openInstall(server: CatalogServer) {
		installError = null;
		installTarget = server;
		draft.transport = server.transport;
		draft.fields = [
			...server.envVars.map(v => ({ name: v.name, kind: 'env' as const, description: v.description, isRequired: v.isRequired, isSecret: v.isSecret })),
			...server.headerVars.map(v => ({ name: v.name, kind: 'header' as const, description: v.description, isRequired: v.isRequired, isSecret: v.isSecret }))
		];
		draft.values = Object.fromEntries([
			...server.envVars.map(v => [v.name, v.default ?? '']),
			...server.headerVars.map(v => [v.name, v.default ?? ''])
		]);
		draft.customEnv = [];
		draft.customHeader = [];
		// Pre-fill the launch command so users can repair incomplete registry
		// metadata (e.g. a missing `mcp` subcommand) before installing.
		draft.command = server.command ?? '';
		draft.argsText = (server.args ?? []).join('\n');
	}

	function closeInstall() {
		installTarget = null;
		installError = null;
		draft.reset();
	}

	async function confirmInstall() {
		const server = installTarget;
		if (!server) return;
		if (draft.missingRequired.length > 0) {
			installError = `Required: ${draft.missingRequired.map(f => f.name).join(', ')}`;
			return;
		}
		const isStdio = server.transport === 'stdio';
		if (isStdio && !draft.command.trim()) {
			installError = 'A local (stdio) server requires a command';
			return;
		}
		installing = true;
		installError = null;
		try {
			const { env, headers } = draft.collect();
			await mcpServersStore.install({
				slug: server.slug,
				name: server.title,
				description: server.description,
				registryName: server.registryName,
				version: server.version,
				transport: server.transport,
				command: isStdio ? draft.command.trim() : server.command,
				args: isStdio ? draft.args() : server.args,
				url: server.url,
				env,
				headers,
				configSchema: draft.fields,
				source: 'registry'
			});
			closeInstall();
		} catch (error) {
			installError = error instanceof Error ? error.message : 'Install failed';
		} finally {
			installing = false;
		}
	}
</script>

<Modal {isOpen} onClose={onClose} title="Browse the MCP registry" size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
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
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{server.slug}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(server.transport)}</span>
									{#if server.version}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">v{server.version}</span>
									{/if}
								</div>
								{#if server.description}
									<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{server.description}</p>
								{/if}
								<p class="text-[11px] text-slate-400 mt-1 truncate">{server.packageHint ?? commandLine(server)}</p>
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
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={onClose}>Close</Button>
	{/snippet}
</Modal>

<!-- Install modal -->
<Modal isOpen={installTarget !== null} onClose={closeInstall} title={`Install ${installTarget?.title ?? ''}`} size="md">
	{#snippet children()}
		{#if installTarget}
			<div class="space-y-4 text-sm">
				{#if installNeedsOAuth}
					<div class="flex items-start gap-2 p-3 bg-violet-500/5 border border-violet-500/20 rounded-lg text-violet-700 dark:text-violet-300">
						<Icon name="lucide:lock" class="w-4 h-4 mt-0.5 shrink-0" />
						<span class="text-xs">
							This server uses OAuth sign-in. After installing, open it from the
							Integrations list and click <span class="font-semibold">Authenticate</span> to connect.
						</span>
					</div>
				{/if}

				<McpConfigForm {draft} />

				{#if installError}
					<p class="text-xs text-red-500">{installError}</p>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeInstall}>Cancel</Button>
		<Button
			variant="primary"
			loading={installing}
			disabled={draft.missingRequired.length > 0 || (installTarget?.transport === 'stdio' && !draft.command.trim())}
			onclick={confirmInstall}
		>Install</Button>
	{/snippet}
</Modal>

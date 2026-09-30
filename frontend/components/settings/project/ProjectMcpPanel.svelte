<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import EngineCoverage from './EngineCoverage.svelte';
	import { projectArtifactsStore, type ProjectMcpFile, type ProjectMcpServer } from '$frontend/stores/features/project-artifacts.svelte';

	interface Props {
		projectId: string;
	}

	const { projectId }: Props = $props();

	$effect(() => {
		const id = projectId;
		untrack(() => void projectArtifactsStore.refresh(id));
	});

	const scan = $derived(projectArtifactsStore.scanProjectId === projectId ? projectArtifactsStore.scan : null);
	const agentsMcp = $derived<ProjectMcpFile | null>(scan?.mcp.find(f => f.sourceId === 'agents-mcp') ?? null);
	const rootMcp = $derived<ProjectMcpFile | null>(scan?.mcp.find(f => f.sourceId === 'root-mcp') ?? null);
	const trust = $derived(scan?.mcpTrust ?? null);
	const approved = $derived(!!agentsMcp && !!trust && trust.hash === agentsMcp.hash);
	// Approved once, then edited outside Clopen (e.g. a pull): needs a fresh look.
	const changedSinceApproval = $derived(!!agentsMcp && !!trust && trust.hash !== agentsMcp.hash);

	let filter = $state('');
	const matches = (server: ProjectMcpServer) => {
		const q = filter.trim().toLowerCase();
		return !q || `${server.name} ${describe(server)}`.toLowerCase().includes(q);
	};
	const agentsServers = $derived((agentsMcp?.servers ?? []).filter(matches));
	const rootServers = $derived((rootMcp?.servers ?? []).filter(matches));
	const hasAny = $derived((agentsMcp?.servers.length ?? 0) + (rootMcp?.servers.length ?? 0) > 0 || !!agentsMcp?.error);

	let actionError = $state<string | null>(null);
	let approving = $state(false);

	async function approve() {
		if (!agentsMcp) return;
		approving = true;
		actionError = null;
		try {
			await projectArtifactsStore.approveMcp(projectId, agentsMcp.hash);
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Approval failed';
		} finally {
			approving = false;
		}
	}

	function describe(server: ProjectMcpServer): string {
		return server.transport === 'stdio'
			? [server.command, ...server.args].filter(Boolean).join(' ')
			: `${server.transport.toUpperCase()} ${server.url ?? ''}`;
	}

	/** The file as an object, for a one-server edit. An absent file starts empty. */
	async function loadFile(): Promise<{ mcpServers: Record<string, unknown> }> {
		const { content } = await projectArtifactsStore.getMcp(projectId);
		if (!content.trim()) return { mcpServers: {} };
		const parsed = JSON.parse(content) as Record<string, unknown>;
		const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
		return { ...parsed, mcpServers: { ...servers } };
	}

	async function writeFile(file: { mcpServers: Record<string, unknown> }): Promise<void> {
		await projectArtifactsStore.saveMcp(projectId, `${JSON.stringify(file, null, 2)}\n`);
	}

	// --- One-server editor ---
	let editorOpen = $state(false);
	let editorOriginal = $state<string | null>(null);
	let edName = $state('');
	let edConfig = $state('');
	let editorError = $state<string | null>(null);
	let editorSaving = $state(false);

	const TEMPLATE = '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}';

	function openCreate() {
		editorOriginal = null;
		edName = '';
		edConfig = TEMPLATE;
		editorError = null;
		editorOpen = true;
	}

	async function openEdit(name: string) {
		editorOriginal = name;
		edName = name;
		edConfig = '';
		editorError = null;
		editorOpen = true;
		try {
			const file = await loadFile();
			edConfig = JSON.stringify(file.mcpServers[name] ?? {}, null, 2);
		} catch (e) {
			editorError = e instanceof Error ? e.message : 'Failed to read .agents/mcp.json';
		}
	}

	async function saveEditor() {
		const name = edName.trim();
		if (!name) { editorError = 'A name is required'; return; }
		let config: unknown;
		try {
			config = JSON.parse(edConfig);
		} catch (e) {
			editorError = e instanceof Error ? e.message : 'Invalid JSON';
			return;
		}
		if (!config || typeof config !== 'object' || Array.isArray(config)) { editorError = 'The configuration must be a JSON object'; return; }
		editorSaving = true;
		editorError = null;
		try {
			const file = await loadFile();
			if (name !== editorOriginal && name in file.mcpServers) throw new Error(`A server named "${name}" already exists`);
			if (editorOriginal && editorOriginal !== name) delete file.mcpServers[editorOriginal];
			file.mcpServers[name] = config;
			await writeFile(file);
			editorOpen = false;
		} catch (e) {
			editorError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			editorSaving = false;
		}
	}

	// --- Delete ---
	let deleteTarget = $state<string | null>(null);
	let deleting = $state(false);

	async function confirmDelete() {
		if (!deleteTarget) return;
		deleting = true;
		actionError = null;
		try {
			const file = await loadFile();
			delete file.mcpServers[deleteTarget];
			await writeFile(file);
		} catch (e) {
			actionError = e instanceof Error ? e.message : 'Delete failed';
		} finally {
			deleting = false;
			deleteTarget = null;
		}
	}

	// --- Raw editor, only for a file that no longer parses ---
	let rawOpen = $state(false);
	let rawContent = $state('');
	let rawError = $state<string | null>(null);
	let rawSaving = $state(false);

	async function openRaw() {
		rawError = null;
		rawOpen = true;
		try {
			rawContent = (await projectArtifactsStore.getMcp(projectId)).content;
		} catch (e) {
			rawError = e instanceof Error ? e.message : 'Failed to read .agents/mcp.json';
		}
	}

	async function saveRaw() {
		rawSaving = true;
		rawError = null;
		try {
			await projectArtifactsStore.saveMcp(projectId, rawContent);
			rawOpen = false;
		} catch (e) {
			rawError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			rawSaving = false;
		}
	}

	const textareaClass = 'w-full px-3 py-2 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 resize-y';
</script>

<div class="space-y-4">
	<div class="flex items-center gap-2">
		<div class="relative flex-1">
			<Icon name="lucide:search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
			<input
				type="text"
				bind:value={filter}
				placeholder="Filter servers…"
				class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
			/>
		</div>
		<Button variant="primary" size="sm" class="gap-1.5 shrink-0" disabled={!!agentsMcp?.error} onclick={openCreate}>
			<Icon name="lucide:plus" class="w-4 h-4" />
			New
		</Button>
	</div>

	{#if !scan}
		<div class="space-y-3">
			{#each [0, 1] as i (i)}
				<div class="h-16 rounded-xl bg-slate-100 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if !hasAny}
		<div class="flex flex-col items-center gap-2 py-10 text-center">
			<Icon name="lucide:plug" class="w-8 h-8 text-slate-400" />
			<p class="text-sm text-slate-500 dark:text-slate-400">No MCP servers in this repository.</p>
			<p class="text-xs text-slate-400">New ones are saved to <code class="text-[11px]">.agents/mcp.json</code>.</p>
		</div>
	{:else}
		{#if agentsMcp}
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<code class="text-xs font-semibold text-slate-700 dark:text-slate-300">.agents/mcp.json</code>
					<span class="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 font-semibold">editable</span>
					{#if approved}
						<span title={trust ? `Approved ${trust.approvedAt}` : undefined} class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-semibold">
							<Icon name="lucide:shield-check" class="w-3 h-3" /> approved
						</span>
					{/if}
				</div>

				{#if agentsMcp.error}
					<div class="flex items-start justify-between gap-3 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
						<p class="text-xs text-red-600 dark:text-red-400 font-mono break-all">{agentsMcp.error}</p>
						<Button variant="outline" size="sm" class="shrink-0" onclick={openRaw}>Edit file</Button>
					</div>
				{:else if !approved && agentsMcp.servers.length > 0}
					<!-- These run commands on this machine: nothing starts until an admin says so. -->
					<div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-amber-500/5 border border-amber-500/20">
						<p class="inline-flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
							<Icon name="lucide:shield-alert" class="w-4 h-4 shrink-0" />
							{changedSinceApproval ? 'Changed since it was approved.' : 'Not approved yet.'} These servers won't run until an admin approves them.
						</p>
						<Button variant="primary" size="sm" class="shrink-0" loading={approving} onclick={approve}>Approve</Button>
					</div>
				{/if}

				{#each agentsServers as server (server.name)}
					{@render serverCard(server, true)}
				{/each}
			</div>
		{/if}

		{#if rootMcp && (rootServers.length > 0 || rootMcp.error)}
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<code class="text-xs font-semibold text-slate-700 dark:text-slate-300">.mcp.json</code>
					<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">read-only</span>
					<EngineCoverage coverage={rootMcp.coverage} />
				</div>
				{#if rootMcp.error}
					<p class="text-xs text-red-500 font-mono">{rootMcp.error}</p>
				{/if}
				{#each rootServers as server (server.name)}
					{@render serverCard(server, false)}
				{/each}
			</div>
		{/if}

		{#if filter.trim() && agentsServers.length + rootServers.length === 0}
			<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No server matches "{filter}".</p>
		{/if}
	{/if}

	{#if actionError}
		<p class="text-xs text-red-500">{actionError}</p>
	{/if}
</div>

{#snippet serverCard(server: ProjectMcpServer, editable: boolean)}
	<div class="flex items-start gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
		<Icon name={server.transport === 'stdio' ? 'lucide:terminal' : 'lucide:globe'} class="w-5 h-5 mt-0.5 shrink-0 text-violet-600" />
		<div class="flex-1 min-w-0 space-y-1">
			<p class="font-semibold text-slate-900 dark:text-slate-100">{server.name}</p>
			<p class="text-xs font-mono text-slate-500 dark:text-slate-400 break-all line-clamp-2">{describe(server)}</p>
		</div>
		{#if editable}
			<div class="flex items-center gap-1 shrink-0">
				<button type="button" onclick={() => openEdit(server.name)} class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors" aria-label="Edit server" title="Edit">
					<Icon name="lucide:pencil" class="w-4 h-4" />
				</button>
				<button type="button" onclick={() => (deleteTarget = server.name)} class="flex p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors" aria-label="Delete server" title="Delete">
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</button>
			</div>
		{/if}
	</div>
{/snippet}

<!-- One-server editor -->
<Modal isOpen={editorOpen} onClose={() => (editorOpen = false)} title={editorOriginal ? 'Edit MCP server' : 'New MCP server'} size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<div class="space-y-1">
				<Input label="Name" required type="text" placeholder="e.g. filesystem" bind:value={edName} />
				<code class="block text-[11px] text-slate-400">.agents/mcp.json</code>
			</div>
			<div class="space-y-1">
				<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Configuration</p>
				<textarea bind:value={edConfig} rows="10" spellcheck="false" class={textareaClass}></textarea>
				<p class="text-[11px] text-slate-400">Same format as an entry in <code class="text-[11px]">.mcp.json</code>. Saving approves it.</p>
			</div>
			{#if editorError}
				<p class="text-xs text-red-500 font-mono">{editorError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (editorOpen = false)}>Cancel</Button>
		<Button variant="primary" loading={editorSaving} onclick={saveEditor}>{editorOriginal ? 'Save' : 'Create'}</Button>
	{/snippet}
</Modal>

<!-- Raw editor (invalid file) -->
<Modal isOpen={rawOpen} onClose={() => (rawOpen = false)} title=".agents/mcp.json" size="lg">
	{#snippet children()}
		<div class="space-y-3 text-sm">
			<textarea bind:value={rawContent} rows="16" spellcheck="false" class={textareaClass}></textarea>
			{#if rawError}
				<p class="text-xs text-red-500 font-mono">{rawError}</p>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (rawOpen = false)}>Cancel</Button>
		<Button variant="primary" loading={rawSaving} onclick={saveRaw}>Save</Button>
	{/snippet}
</Modal>

<!-- Delete confirmation -->
<Modal isOpen={deleteTarget !== null} onClose={() => (deleteTarget = null)} title="Delete MCP server" size="sm">
	{#snippet children()}
		<p class="text-sm text-slate-600 dark:text-slate-300">
			Remove <span class="font-semibold text-slate-900 dark:text-slate-100">{deleteTarget}</span> from <code class="text-xs">.agents/mcp.json</code>?
		</p>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
		<Button variant="danger" loading={deleting} onclick={confirmDelete}>Delete</Button>
	{/snippet}
</Modal>

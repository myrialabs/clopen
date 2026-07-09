<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import {
		mcpServersStore,
		type CatalogServer,
		type InstalledMcpServer,
		type McpConfigField,
		type McpHealthState,
		type McpToolInfo,
		type McpTransport,
		type ParsedMcpServer
	} from '$frontend/stores/features/mcp-servers.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import { debug } from '$shared/utils/logger';
	import type { IconName } from '$shared/types/ui/icons';

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
	let installing = $state(false);
	let installError = $state<string | null>(null);

	// A remote catalog entry that declares no credential fields almost always
	// authenticates via OAuth — surface that so the user knows to finish sign-in
	// from the Installed list after installing.
	const installNeedsOAuth = $derived(
		!!installTarget && installTarget.transport !== 'stdio'
			&& installTarget.envVars.length === 0 && installTarget.headerVars.length === 0
	);

	// Configure modal (edit env / headers on an installed server)
	let configTarget = $state<InstalledMcpServer | null>(null);
	let savingConfig = $state(false);

	// Shared config-form state — used by BOTH the Install and Configure modals so
	// the fields, grouping and helper text are identical in each.
	let cfgTransport = $state<McpTransport>('stdio'); // drives which sections show
	let cfgFields = $state<McpConfigField[]>([]); // registry-declared fields (fixed key)
	let cfgDraft = $state<Record<string, string>>({}); // field name → value
	let cfgCustomEnv = $state<{ key: string; value: string }[]>([]); // user-added env vars
	let cfgCustomHeader = $state<{ key: string; value: string }[]>([]); // user-added headers
	let cfgCommand = $state(''); // stdio command (Configure only)
	let cfgArgsText = $state(''); // stdio args, one per line (Configure only)
	let cfgUrl = $state(''); // remote url (Add manually only)

	// Group by source (env vars vs headers), not by required/optional — the
	// per-field "*" marks what's required within each group.
	const cfgEnvFields = $derived(cfgFields.filter(f => f.kind === 'env'));
	const cfgHeaderFields = $derived(cfgFields.filter(f => f.kind === 'header'));
	const cfgMissingRequired = $derived(cfgFields.filter(f => f.isRequired && !(cfgDraft[f.name] ?? '').trim()));
	// stdio servers use env vars; remote servers use headers. Show the relevant
	// section (plus any the registry happens to declare for the other kind).
	const showEnvSection = $derived(cfgTransport === 'stdio' || cfgEnvFields.length > 0);
	const showHeaderSection = $derived(cfgTransport !== 'stdio' || cfgHeaderFields.length > 0);

	// Delete confirmation modal
	let deleteTarget = $state<InstalledMcpServer | null>(null);
	let deleting = $state(false);

	// Add manually modal — paste any host's MCP JSON (Claude/Cursor/VS Code/
	// OpenCode/…) or fill a blank form. Both converge on the shared config form
	// (cfg* state) for filling required secrets, then install with source 'custom'.
	let manualOpen = $state(false);
	let manualMode = $state<'paste' | 'form'>('paste');
	let pasteText = $state('');
	let parsing = $state(false);
	// True once Preview has parsed at least one server — switches the paste view
	// from the textarea to the detected list / review form (Back returns here).
	let previewed = $state(false);
	let parseError = $state<string | null>(null);
	let parsed = $state<ParsedMcpServer[]>([]);
	let cfgName = $state(''); // server display name (Add manually only)
	// Whether the config form is showing (manual mode, or after picking a parsed
	// server). In paste mode while false, the textarea + detected list show.
	let manualEditing = $state(false);
	let manualError = $state<string | null>(null);
	let manualSaving = $state(false);

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
		void (async () => {
			await mcpServersStore.refreshInstalled();
			mcpServersStore.checkAllStatuses();
		})();
	});

	const statuses = $derived(mcpServersStore.statuses);
	const checking = $derived(mcpServersStore.checking);

	// Visual mapping for a probed connection state.
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

	function transportLabel(t: string): string {
		if (t === 'stdio') return 'local (stdio)';
		if (t === 'sse') return 'remote (sse)';
		return 'remote (http)';
	}

	function commandLine(s: { transport: string; command?: string | null; args?: string[]; url?: string | null }): string {
		if (s.transport === 'stdio') return `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim();
		return s.url ?? '';
	}

	async function onAuthenticate(server: InstalledMcpServer) {
		busyId = server.id;
		try {
			await mcpServersStore.authenticate(server.id);
		} catch (error) {
			debug.error('settings', 'authenticate MCP failed', error);
		} finally {
			busyId = null;
		}
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

	// --- Shared config form helpers (used by both Install and Configure) ---

	// Split the working draft back into the env (stdio) and header (remote) maps
	// the engines actually read. Blank fields are dropped.
	function collectConfig(): { env: Record<string, string>; headers: Record<string, string> } {
		const env: Record<string, string> = {};
		const headers: Record<string, string> = {};
		for (const f of cfgFields) {
			const val = (cfgDraft[f.name] ?? '').trim();
			if (!val) continue;
			if (f.kind === 'header') headers[f.name] = val;
			else env[f.name] = val;
		}
		for (const row of cfgCustomEnv) {
			const key = row.key.trim();
			if (key && row.value.trim()) env[key] = row.value;
		}
		for (const row of cfgCustomHeader) {
			const key = row.key.trim();
			if (key && row.value.trim()) headers[key] = row.value;
		}
		return { env, headers };
	}

	function addCustomEnv() {
		cfgCustomEnv = [...cfgCustomEnv, { key: '', value: '' }];
	}

	function removeCustomEnv(index: number) {
		cfgCustomEnv = cfgCustomEnv.filter((_, i) => i !== index);
	}

	function addCustomHeader() {
		cfgCustomHeader = [...cfgCustomHeader, { key: '', value: '' }];
	}

	function removeCustomHeader(index: number) {
		cfgCustomHeader = cfgCustomHeader.filter((_, i) => i !== index);
	}

	function resetConfigDraft() {
		cfgFields = [];
		cfgDraft = {};
		cfgCustomEnv = [];
		cfgCustomHeader = [];
		cfgCommand = '';
		cfgArgsText = '';
		cfgUrl = '';
	}

	// --- Add manually flow (paste JSON or blank form) ---
	const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

	// One-line summary of a detected server for the preview list.
	function parsedSummary(s: ParsedMcpServer): string {
		if (s.transport === 'stdio') return `${s.command ?? ''} ${s.args.join(' ')}`.trim() || '(no command)';
		return s.url ?? '(no url)';
	}

	function resetManualForm() {
		resetConfigDraft();
		cfgName = '';
		cfgTransport = 'stdio';
		manualError = null;
	}

	function openManual() {
		manualOpen = true;
		manualMode = 'paste';
		pasteText = '';
		parsed = [];
		parseError = null;
		previewed = false;
		manualEditing = false;
		resetManualForm();
	}

	function closeManual() {
		manualOpen = false;
		parsed = [];
		pasteText = '';
		parseError = null;
		previewed = false;
		resetManualForm();
	}

	function switchManualMode(mode: 'paste' | 'form') {
		manualMode = mode;
		manualError = null;
		previewed = false;
		if (mode === 'form') {
			resetManualForm();
			manualEditing = true;
		} else {
			manualEditing = false;
		}
	}

	// Return to the JSON textarea from the detected list or the review form.
	function backToTextarea() {
		previewed = false;
		manualEditing = false;
		resetManualForm();
	}

	// Return to the detected list from the review form (multi-server pastes only).
	function backToList() {
		manualEditing = false;
		resetManualForm();
	}

	// Load a parsed (or blank) server into the shared config form. Placeholder
	// fields become required so the user must supply a real value before install.
	function editParsed(s: ParsedMcpServer) {
		manualError = null;
		cfgName = s.name;
		cfgTransport = s.transport;
		cfgCommand = s.command ?? '';
		cfgArgsText = s.args.join('\n');
		cfgUrl = s.url ?? '';
		cfgFields = s.fields.map(f => ({ name: f.name, kind: f.kind, isRequired: f.isPlaceholder, isSecret: true }));
		cfgDraft = Object.fromEntries(s.fields.map(f => [f.name, f.value]));
		cfgCustomEnv = [];
		cfgCustomHeader = [];
		manualEditing = true;
	}

	async function runParse() {
		parsing = true;
		parseError = null;
		try {
			const { servers, errors } = await mcpServersStore.parseConfig(pasteText);
			parsed = servers;
			if (servers.length === 0) {
				parseError = errors[0] ?? 'No MCP server found in that JSON.';
				return;
			}
			previewed = true;
			// A single server skips the list and goes straight to review.
			if (servers.length === 1) editParsed(servers[0]);
			else manualEditing = false;
		} catch (error) {
			parseError = error instanceof Error ? error.message : 'Failed to parse';
		} finally {
			parsing = false;
		}
	}

	async function commitManual() {
		manualError = null;
		const name = cfgName.trim();
		if (!name) { manualError = 'A name is required'; return; }
		const isStdio = cfgTransport === 'stdio';
		if (isStdio && !cfgCommand.trim()) { manualError = 'A local (stdio) server requires a command'; return; }
		if (!isStdio && !cfgUrl.trim()) { manualError = 'A remote server requires a URL'; return; }
		if (cfgMissingRequired.length > 0) {
			manualError = `Required: ${cfgMissingRequired.map(m => m.name).join(', ')}`;
			return;
		}
		manualSaving = true;
		try {
			const { env, headers } = collectConfig();
			await mcpServersStore.install({
				slug: name, // backend slugifies + de-dupes
				name,
				transport: cfgTransport,
				command: isStdio ? cfgCommand.trim() : undefined,
				args: isStdio ? cfgArgsText.split('\n').map(a => a.trim()).filter(Boolean) : undefined,
				url: isStdio ? undefined : cfgUrl.trim(),
				env,
				headers,
				configSchema: cfgFields,
				source: 'custom'
			});
			mcpServersStore.hasPendingChanges = true;
			closeManual();
			activeTab = 'installed';
		} catch (error) {
			manualError = error instanceof Error ? error.message : 'Install failed';
		} finally {
			manualSaving = false;
		}
	}

	// --- Install flow (modal + confirmation) ---
	function openInstall(server: CatalogServer) {
		installError = null;
		installTarget = server;
		cfgTransport = server.transport;
		cfgFields = [
			...server.envVars.map(v => ({ name: v.name, kind: 'env' as const, description: v.description, isRequired: v.isRequired, isSecret: v.isSecret })),
			...server.headerVars.map(v => ({ name: v.name, kind: 'header' as const, description: v.description, isRequired: v.isRequired, isSecret: v.isSecret }))
		];
		cfgDraft = Object.fromEntries([
			...server.envVars.map(v => [v.name, v.default ?? '']),
			...server.headerVars.map(v => [v.name, v.default ?? ''])
		]);
		cfgCustomEnv = [];
		cfgCustomHeader = [];
		// Pre-fill the stdio launch command so users can repair incomplete registry
		// metadata (e.g. a missing `mcp` subcommand) before the server is installed.
		cfgCommand = server.command ?? '';
		cfgArgsText = (server.args ?? []).join('\n');
	}

	function closeInstall() {
		installTarget = null;
		installError = null;
		resetConfigDraft();
	}

	async function confirmInstall() {
		const server = installTarget;
		if (!server) return;
		if (cfgMissingRequired.length > 0) {
			installError = `Required: ${cfgMissingRequired.map(m => m.name).join(', ')}`;
			return;
		}
		const isStdio = server.transport === 'stdio';
		if (isStdio && !cfgCommand.trim()) {
			installError = 'A local (stdio) server requires a command';
			return;
		}
		installing = true;
		installError = null;
		try {
			const { env, headers } = collectConfig();
			await mcpServersStore.install({
				slug: server.slug,
				name: server.title,
				description: server.description,
				registryName: server.registryName,
				version: server.version,
				transport: server.transport,
				command: isStdio ? cfgCommand.trim() : server.command,
				args: isStdio ? cfgArgsText.split('\n').map(a => a.trim()).filter(Boolean) : server.args,
				url: server.url,
				env,
				headers,
				configSchema: cfgFields,
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

	// --- Configure flow (edit env / headers after install) ---
	function openConfig(server: InstalledMcpServer) {
		configTarget = server;
		cfgTransport = server.transport;
		// Registry-declared fields keep their labels/required markers; their stored
		// values pre-fill the draft.
		const schema = server.configSchema ?? [];
		cfgFields = schema;
		cfgDraft = Object.fromEntries(
			schema.map(f => [f.name, (f.kind === 'header' ? server.headers[f.name] : server.env[f.name]) ?? ''])
		);
		// stdio command/args are editable here so users can repair incomplete
		// registry metadata (e.g. a missing `mcp` subcommand).
		cfgCommand = server.command ?? '';
		cfgArgsText = (server.args ?? []).join('\n');
		// Stored keys NOT declared by the registry are user-added — show them,
		// pre-filled, in the Custom sections so they're clearly distinct.
		const knownEnv = new Set(schema.filter(f => f.kind === 'env').map(f => f.name));
		const knownHeader = new Set(schema.filter(f => f.kind === 'header').map(f => f.name));
		cfgCustomEnv = Object.entries(server.env).filter(([k]) => !knownEnv.has(k)).map(([key, value]) => ({ key, value }));
		cfgCustomHeader = Object.entries(server.headers).filter(([k]) => !knownHeader.has(k)).map(([key, value]) => ({ key, value }));
	}

	function closeConfig() {
		configTarget = null;
		resetConfigDraft();
	}

	async function saveConfig() {
		const server = configTarget;
		if (!server) return;
		if (cfgMissingRequired.length > 0) return;
		savingConfig = true;
		try {
			const { env, headers } = collectConfig();
			const isStdio = server.transport === 'stdio';
			const command = isStdio ? cfgCommand.trim() : undefined;
			const args = isStdio ? cfgArgsText.split('\n').map(a => a.trim()).filter(Boolean) : undefined;
			await mcpServersStore.updateConfig(server.id, env, headers, command, args);
			mcpServersStore.hasPendingChanges = true;
			const id = server.id;
			closeConfig();
			// Auto re-probe so the new status reflects whatever was edited, without
			// a manual Re-check.
			void mcpServersStore.checkStatus(id);
		} catch (error) {
			debug.error('settings', 'update MCP config failed', error);
		} finally {
			savingConfig = false;
		}
	}

	// --- Tool control flow (per-tool + per-engine exposure) ---

	// Each draft entry is the editable exposure for one tool: a master `enabled`
	// plus a per-engine map (keyed by EngineType). Saved wholesale on Save; the
	// backend prunes no-op entries so the stored column only holds restrictions.
	type ToolDraft = { enabled: boolean; engines: Record<string, boolean> };

	let toolsTarget = $state<InstalledMcpServer | null>(null);
	let toolsLoading = $state(false);
	let toolsError = $state<string | null>(null);
	let toolsList = $state<McpToolInfo[]>([]);
	let toolDraft = $state<Record<string, ToolDraft>>({});
	let toolsSaving = $state(false);

	async function openTools(server: InstalledMcpServer) {
		toolsTarget = server;
		toolsList = [];
		toolDraft = {};
		toolsError = null;
		toolsLoading = true;
		try {
			const tools = await mcpServersStore.fetchTools(server.id);
			toolsList = tools;
			toolDraft = Object.fromEntries(
				tools.map(t => [t.name, { enabled: t.enabled, engines: { ...t.engines } }])
			);
		} catch (error) {
			toolsError = error instanceof Error ? error.message : 'Failed to load tools';
		} finally {
			toolsLoading = false;
		}
	}

	function closeTools() {
		toolsTarget = null;
		toolsList = [];
		toolDraft = {};
		toolsError = null;
	}

	function toggleToolEnabled(name: string) {
		const cur = toolDraft[name];
		if (!cur) return;
		toolDraft = { ...toolDraft, [name]: { ...cur, enabled: !cur.enabled } };
	}

	function toggleToolEngine(name: string, engine: string) {
		const cur = toolDraft[name];
		if (!cur || !cur.enabled) return;
		toolDraft = { ...toolDraft, [name]: { ...cur, engines: { ...cur.engines, [engine]: !cur.engines[engine] } } };
	}

	// Count of tools hidden from at least one engine — drives the header summary.
	const restrictedCount = $derived(
		Object.values(toolDraft).filter(d => !d.enabled || Object.values(d.engines).some(on => !on)).length
	);

	async function saveTools() {
		const server = toolsTarget;
		if (!server) return;
		toolsSaving = true;
		try {
			const overrides = Object.fromEntries(
				Object.entries(toolDraft).map(([name, d]) => [name, { enabled: d.enabled, engines: d.engines }])
			);
			await mcpServersStore.setToolOverrides(server.id, overrides);
			closeTools();
		} catch (error) {
			toolsError = error instanceof Error ? error.message : 'Failed to save';
		} finally {
			toolsSaving = false;
		}
	}

	// --- Inspector flow (test-call a single tool) ---
	let inspectTool = $state<McpToolInfo | null>(null);
	let inspectArgs = $state('{}');
	let inspectShowSchema = $state(false);
	let inspectRunning = $state(false);
	let inspectError = $state<string | null>(null);
	let inspectResult = $state<string | null>(null);
	let inspectIsError = $state(false);

	// Tool descriptions arrive as one long blob with the source newlines stripped,
	// so `##` headers and `<example>` blocks run together. Re-introduce structure —
	// headers onto their own line, `<example>` bodies into fenced code blocks — then
	// render it through the shared Markdown surface instead of a raw wall of text.
	function formatToolDescription(raw: string): string {
		if (!raw) return '';
		let s = raw
			// "<example description="X">BODY</example>" → a labelled fenced block.
			.replace(
				/<example(?:\s+description="([^"]*)")?\s*>([\s\S]*?)<\/example>/g,
				(_m, desc: string, body: string) => `\n\n**Example${desc ? ` — ${desc}` : ''}**\n\n\`\`\`\n${body.trim()}\n\`\`\`\n`
			)
			// Put markdown headers back on their own line.
			.replace(/\s*(#{2,6})\s+/g, '\n\n$1 ')
			// Break inline "- " bullets onto their own lines (example JSON has none).
			.replace(/\s+-\s+/g, '\n- ')
			// Collapse the runs of blank lines the substitutions can create.
			.replace(/\n{3,}/g, '\n\n');
		return s.trim();
	}

	const inspectDescription = $derived(inspectTool ? formatToolDescription(inspectTool.description ?? '') : '');

	// Seed the args editor with a `{}` object carrying the schema's declared
	// property keys, so the user edits values rather than recalling field names.
	function argsTemplate(schema: unknown): string {
		const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
		if (!props || typeof props !== 'object') return '{}';
		const seed = Object.fromEntries(Object.keys(props).map(k => [k, '']));
		return JSON.stringify(seed, null, 2);
	}

	function openInspector(tool: McpToolInfo) {
		inspectTool = tool;
		inspectArgs = argsTemplate(tool.inputSchema);
		inspectShowSchema = false;
		inspectError = null;
		inspectResult = null;
		inspectIsError = false;
	}

	function closeInspector() {
		inspectTool = null;
		inspectError = null;
		inspectResult = null;
	}

	async function runInspect() {
		const server = toolsTarget;
		const tool = inspectTool;
		if (!server || !tool) return;
		let args: unknown;
		try {
			args = inspectArgs.trim() ? JSON.parse(inspectArgs) : {};
		} catch {
			inspectError = 'Arguments must be valid JSON.';
			return;
		}
		inspectRunning = true;
		inspectError = null;
		inspectResult = null;
		try {
			const result = await mcpServersStore.callTool(server.id, tool.name, args);
			inspectIsError = !!(result as { isError?: boolean } | null)?.isError;
			inspectResult = JSON.stringify(result, null, 2);
		} catch (error) {
			inspectError = error instanceof Error ? error.message : 'Tool call failed';
		} finally {
			inspectRunning = false;
		}
	}

	const schemaPreview = $derived(inspectTool ? JSON.stringify(inspectTool.inputSchema, null, 2) : '');
</script>

<div class="space-y-6">
	<!-- Header row: title/description on left, tabs on right -->
	<div class="flex items-start justify-between gap-3">
		{#if showHeader}
			<div>
				<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Connectors</h3>
				<p class="text-sm text-slate-600 dark:text-slate-500">
					Built-in tools and external connectors (MCP).
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
				Browse
			</button>
		</div>
	</div>

	{#if activeTab === 'installed'}
		{#if installed.length === 0}
			<div class="flex flex-col items-center gap-2 py-10 text-center">
				<Icon name="lucide:plug" class="w-8 h-8 text-slate-400" />
				<p class="text-sm text-slate-500 dark:text-slate-400">No connectors installed yet.</p>
				<div class="flex items-center gap-2">
					<Button variant="outline" size="sm" onclick={goBrowse}>Browse</Button>
					<Button variant="outline" size="sm" class="gap-1.5" onclick={openManual}>
						<Icon name="lucide:plus" class="w-4 h-4" />
						Add manually
					</Button>
				</div>
			</div>
		{:else}
			<div class="flex items-center gap-2">
				<div class="relative flex-1">
					<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
						<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
						<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
					<input
						type="text"
						bind:value={installedFilter}
						placeholder="Filter connectors…"
						class="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
					/>
				</div>
				<Button variant="outline" size="sm" class="gap-1.5 shrink-0" onclick={openManual}>
					<Icon name="lucide:plus" class="w-4 h-4" />
					Add manually
				</Button>
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
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{server.namespace}</span>
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(server.transport)}</span>
									{#if server.version}
										<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">v{server.version}</span>
									{/if}
									{#if server.restrictedToolCount > 0}
										<span class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400" title="Tools restricted for one or more engines">
											<Icon name="lucide:sliders-horizontal" class="w-3 h-3" />
											{server.restrictedToolCount} restricted
										</span>
									{/if}
								</div>
								{#if server.description}
									<p class="text-xs text-slate-500 dark:text-slate-400 mt-1.5 line-clamp-2">{server.description}</p>
								{/if}
								{#if server.source !== 'internal'}
									<p class="text-[11px] text-slate-400 mt-1 truncate">{commandLine(server)}</p>
								{/if}
								{#if server.source !== 'internal'}
									<div class="flex items-center gap-2 mt-2">
										{#if !server.enabled}
											<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
												<Icon name="lucide:ban" class="w-3.5 h-3.5" />
												Disabled
											</span>
										{:else if checking[server.id]}
											<span class="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
												<span class="w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin"></span>
												Checking…
											</span>
										{:else if statuses[server.id]}
											{@const health = statuses[server.id]}
											{@const meta = statusMeta(health.state)}
											<span class="inline-flex items-center gap-1 text-[11px] font-semibold {meta.class}" title={health.message ?? ''}>
												<Icon name={meta.icon} class="w-3.5 h-3.5" />
												{meta.label}
											</span>
											{#if health.state === 'needs_auth'}
												<button
													type="button"
													disabled={busyId === server.id}
													onclick={() => onAuthenticate(server)}
													class="text-[11px] font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400 disabled:opacity-50"
												>
													Authenticate
												</button>
											{:else if health.state === 'needs_config'}
												<button
													type="button"
													onclick={() => openConfig(server)}
													class="text-[11px] font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
												>
													Configure
												</button>
											{/if}
											<button
												type="button"
												onclick={() => mcpServersStore.checkStatus(server.id)}
												class="text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
											>
												Re-check
											</button>
										{/if}
									</div>
									{#if statuses[server.id]?.message && statuses[server.id].state !== 'ok' && statuses[server.id].state !== 'local'}
										{@const health = statuses[server.id]}
										<p class="text-[11px] mt-1 break-words {health.state === 'needs_auth' || health.state === 'needs_config' ? 'text-amber-600 dark:text-amber-400' : 'text-red-500 dark:text-red-400'}">
											{health.message}
										</p>
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
										onclick={() => openTools(server)}
										class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors"
										aria-label="Manage tools"
										title="Manage tools & inspector"
									>
										<Icon name="lucide:sliders-horizontal" class="w-4 h-4" />
									</button>
									<button
										type="button"
										onclick={() => openConfig(server)}
										class="flex p-2 rounded-lg text-slate-400 hover:text-violet-600 hover:bg-violet-500/10 transition-colors"
										aria-label="Configure server"
										title="Configure credentials"
									>
										<Icon name="lucide:settings-2" class="w-4 h-4" />
									</button>
									<button
										type="button"
										disabled={busyId === server.id}
										onclick={() => (deleteTarget = server)}
										class="flex p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-50"
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
	{/if}
</div>

<!-- Shared config form: fields grouped by source (Environment variables /
     Headers), each with its own "+ Add" button for extra fields. Used by BOTH
     the Install and Configure modals so the experience is identical. Required
     fields are marked per-field with "*". -->
{#snippet fieldInput(field: McpConfigField)}
	<div class="space-y-1">
		<Input
			label={field.name}
			required={field.isRequired}
			type="text"
			bind:value={cfgDraft[field.name]}
		/>
		{#if field.description}
			<p class="text-[11px] text-slate-400">{field.description}</p>
		{/if}
	</div>
{/snippet}

{#snippet customList(
	rows: { key: string; value: string }[],
	keyPlaceholder: string,
	addLabel: string,
	onAdd: () => void,
	onRemove: (index: number) => void
)}
	{#each rows as row, i (i)}
		<div class="flex gap-2 items-center">
			<div class="w-2/5">
				<Input bind:value={row.key} placeholder={keyPlaceholder} />
			</div>
			<div class="flex-1">
				<Input type="text" bind:value={row.value} placeholder="value" />
			</div>
			<button
				type="button"
				onclick={() => onRemove(i)}
				class="flex p-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-500/10 transition-colors"
				aria-label="Remove field"
			>
				<Icon name="lucide:x" class="w-4 h-4" />
			</button>
		</div>
	{/each}
	<Button variant="ghost" size="sm" onclick={onAdd}>{addLabel}</Button>
{/snippet}

{#snippet configForm(allowCommandEdit: boolean)}
	<div class="space-y-5">
		{#if allowCommandEdit && cfgTransport === 'stdio'}
			<div class="space-y-3">
				<div class="space-y-1">
					<Input label="Command" type="text" placeholder="npx" bind:value={cfgCommand} />
				</div>
				<div class="space-y-1">
					<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Arguments</p>
					<textarea
						bind:value={cfgArgsText}
						rows="3"
						placeholder={'-y\nxcodebuildmcp\nmcp'}
						class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
					></textarea>
					<p class="text-[11px] text-slate-400">One argument per line, in order.</p>
				</div>
				<div class="border-t border-slate-300 dark:border-slate-600"></div>
			</div>
		{/if}
		{#if showEnvSection}
			<div class="space-y-5">
				{#if cfgEnvFields.length > 0}
					<div class="space-y-2">
						<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Environment variables</p>
						{#each cfgEnvFields as field (field.name)}
							{@render fieldInput(field)}
						{/each}
					</div>
					<div class="border-t border-slate-300 dark:border-slate-600"></div>
				{/if}
				<div class="space-y-2">
					<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Custom variables</p>
					{@render customList(cfgCustomEnv, 'VAR_NAME', '+ Add variable', addCustomEnv, removeCustomEnv)}
				</div>
			</div>
		{/if}
		{#if showHeaderSection}
			<div class="space-y-3">
				{#if cfgHeaderFields.length > 0}
					<div class="space-y-2">
						<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Headers</p>
						{#each cfgHeaderFields as field (field.name)}
							{@render fieldInput(field)}
						{/each}
					</div>
				{/if}
				<div class="space-y-2">
					<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Custom headers</p>
					{@render customList(cfgCustomHeader, 'Header', '+ Add header', addCustomHeader, removeCustomHeader)}
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<!-- Add-manually form: name + transport + url/command, then the shared config
     form for env/headers/secrets. Used for both pasted servers and blank entries. -->
{#snippet manualForm()}
	<div class="space-y-5">
		<Input label="Name" required type="text" placeholder="e.g. Notion" bind:value={cfgName} />
		<div class="space-y-1">
			<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Transport</p>
			<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg w-max">
				{#each TRANSPORTS as t (t)}
					<button
						type="button"
						class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
							{cfgTransport === t
							? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
							: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
						onclick={() => (cfgTransport = t)}
					>
						{transportLabel(t)}
					</button>
				{/each}
			</div>
		</div>
		{#if cfgTransport !== 'stdio'}
			<Input label="URL" required type="text" placeholder="https://example.com/mcp" bind:value={cfgUrl} />
		{/if}
		{@render configForm(true)}
	</div>
{/snippet}

<!-- Install modal -->
<Modal isOpen={installTarget !== null} onClose={closeInstall} title={`Install ${installTarget?.title ?? ''}`} size="md">
	{#snippet children()}
		{#if installTarget}
			<div class="space-y-4 text-sm">
				{#if installNeedsOAuth}
					<div class="flex items-start gap-2 p-3 bg-violet-500/5 border border-violet-500/20 rounded-lg text-violet-700 dark:text-violet-300">
						<Icon name="lucide:lock" class="w-4 h-4 mt-0.5 shrink-0" />
						<span class="text-xs">
							This server uses OAuth sign-in. After installing, open it under
							<span class="font-semibold">Installed</span> and click
							<span class="font-semibold">Authenticate</span> to connect.
						</span>
					</div>
				{/if}

				{@render configForm(true)}

				{#if installError}
					<p class="text-xs text-red-500">{installError}</p>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeInstall}>Cancel</Button>
		<Button variant="primary" loading={installing} disabled={cfgMissingRequired.length > 0 || (installTarget?.transport === 'stdio' && !cfgCommand.trim())} onclick={confirmInstall}>Install</Button>
	{/snippet}
</Modal>

<!-- Configure modal -->
<Modal isOpen={configTarget !== null} onClose={closeConfig} title={`Configure ${configTarget?.name ?? ''}`} size="md">
	{#snippet children()}
		{#if configTarget}
			<div class="space-y-4 text-sm">
				{@render configForm(true)}

				{#if cfgMissingRequired.length > 0}
					<p class="text-xs text-red-500">Required: {cfgMissingRequired.map(m => m.name).join(', ')}</p>
				{/if}

				{#if configTarget.transport !== 'stdio'}
					<p class="text-[11px] text-slate-400">For OAuth servers, leave these blank and use Authenticate instead — sign-in is managed for you and applied to every engine.</p>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeConfig}>Cancel</Button>
		<Button variant="primary" loading={savingConfig} disabled={cfgMissingRequired.length > 0 || (configTarget?.transport === 'stdio' && !cfgCommand.trim())} onclick={saveConfig}>Save</Button>
	{/snippet}
</Modal>

<!-- Delete confirmation modal -->
<Modal isOpen={deleteTarget !== null} onClose={() => (deleteTarget = null)} title="Remove connector" size="sm">
	{#snippet children()}
		{#if deleteTarget}
			<p class="text-sm text-slate-600 dark:text-slate-300">
				Remove <span class="font-semibold text-slate-900 dark:text-slate-100">{deleteTarget.name}</span>?
				It will be removed from every engine. This can't be undone.
			</p>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteTarget = null)}>Cancel</Button>
		<Button variant="primary" loading={deleting} class="!bg-red-600 hover:!bg-red-700" onclick={confirmDelete}>Remove</Button>
	{/snippet}
</Modal>

<!-- Add manually modal: paste any host's MCP JSON, or build one by hand -->
<Modal isOpen={manualOpen} onClose={closeManual} title="Add connector" size="md">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<!-- Mode toggle -->
			<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg w-max">
				<button
					type="button"
					class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
						{manualMode === 'paste'
						? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
						: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => switchManualMode('paste')}
				>
					Paste JSON
				</button>
				<button
					type="button"
					class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
						{manualMode === 'form'
						? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
						: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => switchManualMode('form')}
				>
					Manual
				</button>
			</div>

			{#if manualMode === 'paste' && !previewed}
				<p class="text-xs text-slate-500 dark:text-slate-400">
					Paste a config from any tool (Cursor, Antigravity, Claude, etc.) — we'll detect the format.
				</p>
				<textarea
					bind:value={pasteText}
					rows="8"
					placeholder={'{\n  "mcpServers": {\n    "notion": {\n      "command": "npx",\n      "args": ["-y", "@notionhq/notion-mcp-server"],\n      "env": { "NOTION_TOKEN": "<your-token>" }\n    }\n  }\n}'}
					class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-y"
				></textarea>

				{#if parseError}
					<p class="text-xs text-red-500">{parseError}</p>
				{/if}
			{:else if manualMode === 'paste' && !manualEditing}
				<button
					type="button"
					class="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
					onclick={backToTextarea}
				>
					<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
					Back
				</button>
				<div class="space-y-2">
					{#each parsed as s (s.name)}
						<div class="flex items-start gap-3 p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
							<div class="flex-1 min-w-0">
								<span class="font-semibold text-slate-900 dark:text-slate-100">{s.name}</span>
								<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(s.transport)}</span>
								<p class="text-[11px] text-slate-400 mt-1 truncate font-mono">{parsedSummary(s)}</p>
								{#each s.warnings as w (w)}
									<p class="text-[11px] text-amber-600 dark:text-amber-400 mt-1">{w}</p>
								{/each}
							</div>
							<Button variant="outline" size="sm" onclick={() => editParsed(s)}>Configure</Button>
						</div>
					{/each}
				</div>
			{:else}
				{#if manualMode === 'paste'}
					<button
						type="button"
						class="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
						onclick={() => (parsed.length > 1 ? backToList() : backToTextarea())}
					>
						<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
						Back
					</button>
				{/if}
				{@render manualForm()}
				{#if manualError}
					<p class="text-xs text-red-500">{manualError}</p>
				{/if}
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		{#if manualMode === 'paste' && !previewed}
			<Button variant="ghost" onclick={closeManual}>Cancel</Button>
			<Button variant="primary" loading={parsing} disabled={!pasteText.trim()} onclick={runParse}>Preview</Button>
		{:else if manualMode === 'paste' && !manualEditing}
			<Button variant="ghost" onclick={closeManual}>Cancel</Button>
		{:else}
			<Button variant="ghost" onclick={closeManual}>Cancel</Button>
			<Button variant="primary" loading={manualSaving} onclick={commitManual}>Install</Button>
		{/if}
	{/snippet}
</Modal>

<!-- Tools modal: per-tool + per-engine exposure control for one installed server.
     The filter is enforced in Clopen's proxy bridge, so disabling a tool for an
     engine hides it from that engine's next stream regardless of its SDK. -->
<Modal isOpen={toolsTarget !== null} onClose={closeTools} title={`Tools · ${toolsTarget?.name ?? ''}`} size="lg">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			{#if toolsLoading}
				<div class="flex items-center justify-center gap-2 py-10 text-slate-400">
					<span class="w-4 h-4 border-2 border-violet-600 border-t-transparent rounded-full animate-spin"></span>
					Connecting to server…
				</div>
			{:else if toolsError}
				<div class="flex items-start gap-2 p-3 bg-red-500/5 border border-red-500/20 rounded-lg text-red-600 dark:text-red-400">
					<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0" />
					<span class="break-words">{toolsError}</span>
				</div>
			{:else if toolsList.length === 0}
				<p class="text-slate-500 dark:text-slate-400 text-center py-8">This server exposes no tools.</p>
			{:else}
				<p class="text-xs text-slate-500 dark:text-slate-400">
					Toggle a tool off to hide it from every engine, or switch off individual engines to
					trim the tool surface per engine. {restrictedCount > 0 ? `${restrictedCount} restricted.` : 'All tools exposed.'}
				</p>
				<div class="space-y-2.5">
					{#each toolsList as tool (tool.name)}
						{@const draft = toolDraft[tool.name]}
						<div class="p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl {draft?.enabled ? '' : 'opacity-70'}">
							<div class="flex items-start gap-3">
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2">
										<span class="font-mono text-[13px] font-semibold text-slate-900 dark:text-slate-100 truncate">{tool.name}</span>
									</div>
									{#if tool.description}
										<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{tool.description}</p>
									{/if}
								</div>
								<div class="flex items-center gap-2 shrink-0">
									<button
										type="button"
										onclick={() => openInspector(tool)}
										class="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
										title="Test this tool"
									>
										<Icon name="lucide:flask-conical" class="w-3.5 h-3.5" />
										Inspect
									</button>
									<button
										type="button"
										role="switch"
										aria-checked={draft?.enabled ?? true}
										onclick={() => toggleToolEnabled(tool.name)}
										class="relative w-10 h-6 rounded-full transition-colors {draft?.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
										aria-label={draft?.enabled ? 'Disable tool' : 'Enable tool'}
									>
										<span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform {draft?.enabled ? 'translate-x-4' : ''}"></span>
									</button>
								</div>
							</div>
							<!-- Two distinct controls: the switch above is the whole-tool kill
							     switch; the chips below pick engines only while the tool is on.
							     A disabled tool is hidden from every engine, full stop — so we
							     drop the chips entirely rather than grey them out. -->
							{#if draft?.enabled}
								<div class="mt-2.5">
									<p class="text-[11px] font-semibold text-slate-400 dark:text-slate-500 mb-1.5">Exposed to</p>
									<div class="flex flex-wrap items-center gap-1.5">
										{#each ENGINES as engine (engine.type)}
											{@const on = draft.engines[engine.type] ?? true}
											<button
												type="button"
												onclick={() => toggleToolEngine(tool.name, engine.type)}
												class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border transition-colors
													{on
														? 'bg-violet-500/10 border-violet-500/30 text-violet-600 dark:text-violet-400'
														: 'bg-transparent border-slate-200 dark:border-slate-700 text-slate-400 line-through'}"
												title={on ? `Exposed to ${engine.name}` : `Hidden from ${engine.name}`}
											>
												{#if on}<Icon name="lucide:check" class="w-3 h-3" />{/if}
												{engine.name}
											</button>
										{/each}
									</div>
								</div>
							{:else}
								<p class="mt-2.5 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
									<Icon name="lucide:ban" class="w-3 h-3" />
									Hidden from every engine
								</p>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeTools}>Cancel</Button>
		<Button variant="primary" loading={toolsSaving} disabled={toolsLoading || !!toolsError || toolsList.length === 0} onclick={saveTools}>Save</Button>
	{/snippet}
</Modal>

<!-- Inspector modal: fill JSON arguments, view the input schema, call the tool
     and see its raw result (including tool-reported errors). -->
<Modal isOpen={inspectTool !== null} onClose={closeInspector} title={`Inspect · ${inspectTool?.name ?? ''}`} size="lg">
	{#snippet children()}
		{#if inspectTool}
			<div class="space-y-4 text-sm">
				{#if inspectDescription}
					<div class="max-h-56 overflow-auto pr-1 border-b border-slate-100 dark:border-slate-800 pb-3">
						<Markdown content={inspectDescription} variant="compact" html="escape" class="text-xs" />
					</div>
				{/if}

				<button
					type="button"
					class="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
					onclick={() => (inspectShowSchema = !inspectShowSchema)}
				>
					<Icon name={inspectShowSchema ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5" />
					Input schema
				</button>
				{#if inspectShowSchema}
					<pre class="max-h-48 overflow-auto p-3 text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300">{schemaPreview}</pre>
				{/if}

				<div class="space-y-1">
					<p class="text-xs font-semibold text-slate-400 dark:text-slate-500">Arguments (JSON)</p>
					<textarea
						bind:value={inspectArgs}
						rows="6"
						spellcheck="false"
						class="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 resize-y"
					></textarea>
				</div>

				{#if inspectError}
					<p class="text-xs text-red-500 break-words">{inspectError}</p>
				{/if}

				{#if inspectResult !== null}
					<div class="space-y-1">
						<p class="text-xs font-semibold {inspectIsError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}">
							{inspectIsError ? 'Result (tool reported an error)' : 'Result'}
						</p>
						<pre class="max-h-64 overflow-auto p-3 text-[11px] font-mono border rounded-lg break-words whitespace-pre-wrap
							{inspectIsError
								? 'bg-red-500/5 border-red-500/20 text-red-600 dark:text-red-400'
								: 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'}">{inspectResult}</pre>
					</div>
				{/if}
			</div>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="ghost" onclick={closeInspector}>Close</Button>
		<Button variant="primary" loading={inspectRunning} onclick={runInspect}>Run</Button>
	{/snippet}
</Modal>

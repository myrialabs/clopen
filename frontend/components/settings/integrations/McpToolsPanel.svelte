<script lang="ts">
	/**
	 * Per-tool + per-engine exposure, with the inspector inline.
	 *
	 * A panel rather than a modal. It used to be a dialog opened from another
	 * dialog, with the inspector a third on top — three stacked overlays to answer
	 * "what does this tool do". Inline, the tool you are inspecting stays in the
	 * list you are editing, which is the thing you actually need to see.
	 *
	 * The filter is enforced in Clopen's proxy bridge, so hiding a tool from an
	 * engine takes effect on that engine's next stream regardless of its SDK.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import { ENGINES } from '$shared/constants/engines';
	import { mcpServersStore, type InstalledMcpServer, type McpToolInfo } from '$frontend/stores/features/mcp-servers.svelte';

	interface Props {
		server: InstalledMcpServer;
	}

	const { server }: Props = $props();

	/** The editable exposure for one tool: a master switch plus a per-engine map. */
	type ToolDraft = { enabled: boolean; engines: Record<string, boolean> };

	let loading = $state(false);
	let error = $state<string | null>(null);
	let tools = $state<McpToolInfo[]>([]);
	let draft = $state<Record<string, ToolDraft>>({});
	let saving = $state(false);
	let saved = $state(false);

	// Reload whenever a different server is shown.
	$effect(() => {
		const id = server.id;
		void load(id);
	});

	async function load(id: number) {
		tools = [];
		draft = {};
		error = null;
		expandedTool = null;
		loading = true;
		try {
			const list = await mcpServersStore.fetchTools(id);
			tools = list;
			draft = Object.fromEntries(list.map(t => [t.name, { enabled: t.enabled, engines: { ...t.engines } }]));
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load tools';
		} finally {
			loading = false;
		}
	}

	function toggleTool(name: string) {
		const current = draft[name];
		if (!current) return;
		draft = { ...draft, [name]: { ...current, enabled: !current.enabled } };
		saved = false;
	}

	function toggleEngine(name: string, engine: string) {
		const current = draft[name];
		if (!current || !current.enabled) return;
		draft = { ...draft, [name]: { ...current, engines: { ...current.engines, [engine]: !current.engines[engine] } } };
		saved = false;
	}

	const restrictedCount = $derived(
		Object.values(draft).filter(d => !d.enabled || Object.values(d.engines).some(on => !on)).length
	);

	/** True once the draft differs from what the server reported. */
	const dirty = $derived(
		tools.some(tool => {
			const entry = draft[tool.name];
			if (!entry) return false;
			if (entry.enabled !== tool.enabled) return true;
			return Object.keys(entry.engines).some(engine => entry.engines[engine] !== tool.engines[engine]);
		})
	);

	async function save() {
		saving = true;
		try {
			const overrides = Object.fromEntries(
				Object.entries(draft).map(([name, d]) => [name, { enabled: d.enabled, engines: d.engines }])
			);
			await mcpServersStore.setToolOverrides(server.id, overrides);
			// Re-read so `dirty` settles against the new baseline rather than the
			// one the user just changed away from.
			await load(server.id);
			saved = true;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to save';
		} finally {
			saving = false;
		}
	}

	// --- Inspector, inline under the tool it belongs to ---
	let expandedTool = $state<string | null>(null);
	let inspectArgs = $state('{}');
	let inspectShowSchema = $state(false);
	let inspectRunning = $state(false);
	let inspectError = $state<string | null>(null);
	let inspectResult = $state<string | null>(null);
	let inspectIsError = $state(false);

	/**
	 * Tool descriptions arrive as one blob with the source newlines stripped, so
	 * `##` headers and `<example>` blocks run together. Put the structure back
	 * before handing it to the shared Markdown surface.
	 */
	function formatToolDescription(raw: string): string {
		if (!raw) return '';
		return raw
			.replace(
				/<example(?:\s+description="([^"]*)")?\s*>([\s\S]*?)<\/example>/g,
				(_m, desc: string, body: string) => `\n\n**Example${desc ? ` — ${desc}` : ''}**\n\n\`\`\`\n${body.trim()}\n\`\`\`\n`
			)
			.replace(/\s*(#{2,6})\s+/g, '\n\n$1 ')
			.replace(/\s+-\s+/g, '\n- ')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	}

	/**
	 * An empty value of the right JSON type for one schema property.
	 *
	 * Seeding everything with `""` looks helpful and is actively harmful: a tool
	 * with twenty optional properties then rejects the call twenty times over
	 * ("expected boolean, received string") before the user has typed anything,
	 * and the real mistake is buried in the pile.
	 */
	function emptyForType(schema: unknown): unknown {
		const type = (schema as { type?: string | string[] } | null)?.type;
		const primary = Array.isArray(type) ? type[0] : type;
		switch (primary) {
			case 'boolean': return false;
			case 'number':
			case 'integer': return 0;
			case 'array': return [];
			case 'object': return {};
			default: return '';
		}
	}

	/**
	 * Seed the args editor with the REQUIRED properties only.
	 *
	 * Required is what the user has to supply; everything else is discoverable
	 * through the schema toggle right above, and starting from the minimum call
	 * that can actually succeed is a better place to edit from than a form of
	 * twenty blanks.
	 */
	function argsTemplate(schema: unknown): string {
		const shape = schema as { properties?: Record<string, unknown>; required?: string[] } | null;
		const props = shape?.properties;
		if (!props || typeof props !== 'object') return '{}';

		const required = Array.isArray(shape?.required) ? shape.required.filter(name => name in props) : [];
		const keys = required.length > 0 ? required : Object.keys(props);
		return JSON.stringify(Object.fromEntries(keys.map(k => [k, emptyForType(props[k])])), null, 2);
	}

	function toggleInspector(tool: McpToolInfo) {
		if (expandedTool === tool.name) {
			expandedTool = null;
			return;
		}
		expandedTool = tool.name;
		inspectArgs = argsTemplate(tool.inputSchema);
		inspectShowSchema = false;
		inspectError = null;
		inspectResult = null;
		inspectIsError = false;
	}

	async function runInspect(tool: McpToolInfo) {
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
		} catch (err) {
			inspectError = err instanceof Error ? err.message : 'Tool call failed';
		} finally {
			inspectRunning = false;
		}
	}
</script>

<div class="space-y-3">
	{#if loading}
		<div class="flex items-center justify-center gap-2 py-10 text-slate-400 text-sm">
			<span class="w-4 h-4 border-2 border-violet-600 border-t-transparent rounded-full animate-spin"></span>
			Connecting to server…
		</div>
	{:else if error}
		<div class="flex items-start gap-2 p-3 bg-red-500/5 border border-red-500/20 rounded-lg text-red-600 dark:text-red-400 text-sm">
			<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 shrink-0" />
			<div class="min-w-0 space-y-2">
				<p class="break-words">{error}</p>
				<Button variant="outline" size="sm" onclick={() => load(server.id)}>Try again</Button>
			</div>
		</div>
	{:else if tools.length === 0}
		<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-8">This server exposes no tools.</p>
	{:else}
		<div class="flex items-center justify-between gap-3">
			<p class="text-xs text-slate-500 dark:text-slate-400">
				{tools.length} tool{tools.length === 1 ? '' : 's'} ·
				{restrictedCount > 0 ? `${restrictedCount} restricted` : 'all exposed'}
			</p>
			{#if dirty}
				<Button variant="primary" size="sm" loading={saving} onclick={save}>Save changes</Button>
			{:else if saved}
				<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
					<Icon name="lucide:check" class="w-3.5 h-3.5" /> Saved
				</span>
			{/if}
		</div>

		<div class="space-y-2">
			{#each tools as tool (tool.name)}
				{@const entry = draft[tool.name]}
				{@const open = expandedTool === tool.name}
				<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden {entry?.enabled ? '' : 'opacity-70'}">
					<div class="flex items-start gap-3 p-3">
						<div class="flex-1 min-w-0">
							<span class="font-mono text-[13px] font-semibold text-slate-900 dark:text-slate-100 break-all">{tool.name}</span>
							{#if tool.description}
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{tool.description}</p>
							{/if}
						</div>
						<div class="flex items-center gap-2 shrink-0">
							<button
								type="button"
								onclick={() => toggleInspector(tool)}
								class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors
									{open
										? 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
										: 'text-slate-400 hover:text-violet-600 hover:bg-violet-500/10'}"
								title="Test this tool"
							>
								<Icon name={open ? 'lucide:chevron-down' : 'lucide:flask-conical'} class="w-3.5 h-3.5" />
								Inspect
							</button>
							<button
								type="button"
								role="switch"
								aria-checked={entry?.enabled ?? true}
								onclick={() => toggleTool(tool.name)}
								class="relative w-10 h-6 rounded-full transition-colors shrink-0 {entry?.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}"
								aria-label={entry?.enabled ? 'Disable tool' : 'Enable tool'}
							>
								<span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform {entry?.enabled ? 'translate-x-4' : ''}"></span>
							</button>
						</div>
					</div>

					<!-- Two distinct controls: the switch above is the whole-tool kill
					     switch; the chips below pick engines only while the tool is on.
					     A disabled tool is hidden from every engine, full stop. -->
					<div class="px-3 pb-3">
						{#if entry?.enabled}
							<div class="flex flex-wrap items-center gap-1.5">
								<span class="text-[11px] font-semibold text-slate-400 dark:text-slate-500 mr-1">Exposed to</span>
								{#each ENGINES as engine (engine.type)}
									{@const on = entry.engines[engine.type] ?? true}
									<button
										type="button"
										onclick={() => toggleEngine(tool.name, engine.type)}
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
						{:else}
							<p class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400">
								<Icon name="lucide:ban" class="w-3 h-3" />
								Hidden from every engine
							</p>
						{/if}
					</div>

					{#if open}
						<div class="border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 p-3 space-y-3">
							{#if tool.description}
								<div class="max-h-48 overflow-auto pr-1">
									<Markdown content={formatToolDescription(tool.description)} variant="compact" html="escape" class="text-xs" />
								</div>
							{/if}

							<button
								type="button"
								class="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
								onclick={() => (inspectShowSchema = !inspectShowSchema)}
							>
								<Icon name={inspectShowSchema ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5" />
								Input schema
							</button>
							{#if inspectShowSchema}
								<pre class="max-h-40 overflow-auto p-3 text-[11px] font-mono bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-700 dark:text-slate-300">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
							{/if}

							<div class="space-y-1">
								<p class="text-[11px] font-semibold text-slate-400 dark:text-slate-500">Arguments (JSON)</p>
								<textarea
									bind:value={inspectArgs}
									rows="5"
									spellcheck="false"
									class="w-full px-3 py-2 text-xs font-mono bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 resize-y"
								></textarea>
							</div>

							<div class="flex items-center gap-2">
								<Button variant="primary" size="sm" class="shrink-0" loading={inspectRunning} onclick={() => runInspect(tool)}>Run</Button>
							</div>

							<!-- The error gets its own block, not the space left over beside the
							     button. An MCP validation failure is one long line listing every
							     field it rejected, and sharing a flex row with it squeezed the
							     button down to a single character per line. -->
							{#if inspectError}
								<div class="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
									<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-500" />
									<p class="min-w-0 max-h-40 overflow-auto text-[11px] leading-relaxed text-red-600 dark:text-red-400 break-words whitespace-pre-wrap">{inspectError}</p>
								</div>
							{/if}

							{#if inspectResult !== null}
								<div class="space-y-1">
									<p class="text-[11px] font-semibold {inspectIsError ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}">
										{inspectIsError ? 'Result (tool reported an error)' : 'Result'}
									</p>
									<pre class="max-h-56 overflow-auto p-3 text-[11px] font-mono border rounded-lg break-words whitespace-pre-wrap
										{inspectIsError
											? 'bg-red-500/5 border-red-500/20 text-red-600 dark:text-red-400'
											: 'bg-white dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300'}">{inspectResult}</pre>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

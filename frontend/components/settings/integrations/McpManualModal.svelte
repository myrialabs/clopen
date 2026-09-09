<script lang="ts">
	/**
	 * Add a connector by hand: paste any host's MCP JSON (Claude / Cursor /
	 * VS Code / OpenCode / …) or fill a blank form. Both converge on the shared
	 * config form and install with `source: 'custom'`.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Input from '$frontend/components/common/form/Input.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import McpConfigForm from './McpConfigForm.svelte';
	import { McpConfigDraft, transportLabel } from './mcp-config-draft.svelte';
	import { mcpServersStore, type McpTransport, type ParsedMcpServer } from '$frontend/stores/features/mcp-servers.svelte';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	const { isOpen, onClose }: Props = $props();

	const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];
	const draft = new McpConfigDraft();

	let mode = $state<'paste' | 'form'>('paste');
	let pasteText = $state('');
	let parsing = $state(false);
	let parseError = $state<string | null>(null);
	let parsed = $state<ParsedMcpServer[]>([]);
	// True once Preview has parsed at least one server — switches the paste view
	// from the textarea to the detected list / review form.
	let previewed = $state(false);
	let editing = $state(false);
	let error = $state<string | null>(null);
	let saving = $state(false);

	function resetForm() {
		draft.reset();
		draft.transport = 'stdio';
		error = null;
	}

	function reset() {
		mode = 'paste';
		pasteText = '';
		parsed = [];
		parseError = null;
		previewed = false;
		editing = false;
		resetForm();
	}

	$effect(() => {
		if (isOpen) reset();
	});

	function switchMode(next: 'paste' | 'form') {
		mode = next;
		error = null;
		previewed = false;
		if (next === 'form') {
			resetForm();
			editing = true;
		} else {
			editing = false;
		}
	}

	/** Back to the JSON textarea from the detected list or the review form. */
	function backToTextarea() {
		previewed = false;
		editing = false;
		resetForm();
	}

	/** Back to the detected list from the review form (multi-server pastes only). */
	function backToList() {
		editing = false;
		resetForm();
	}

	/** One-line summary of a detected server for the preview list. */
	function parsedSummary(server: ParsedMcpServer): string {
		if (server.transport === 'stdio') return `${server.command ?? ''} ${server.args.join(' ')}`.trim() || '(no command)';
		return server.url ?? '(no url)';
	}

	/**
	 * Load a parsed (or blank) server into the shared form. A placeholder value
	 * becomes a required field, so the user must supply a real one before install.
	 */
	function editParsed(server: ParsedMcpServer) {
		error = null;
		draft.name = server.name;
		draft.transport = server.transport;
		draft.command = server.command ?? '';
		draft.argsText = server.args.join('\n');
		draft.url = server.url ?? '';
		draft.fields = server.fields.map(f => ({ name: f.name, kind: f.kind, isRequired: f.isPlaceholder, isSecret: true }));
		draft.values = Object.fromEntries(server.fields.map(f => [f.name, f.value]));
		draft.customEnv = [];
		draft.customHeader = [];
		editing = true;
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
			else editing = false;
		} catch (err) {
			parseError = err instanceof Error ? err.message : 'Failed to parse';
		} finally {
			parsing = false;
		}
	}

	async function commit() {
		error = null;
		const name = draft.name.trim();
		if (!name) { error = 'A name is required'; return; }
		const isStdio = draft.transport === 'stdio';
		if (isStdio && !draft.command.trim()) { error = 'A local (stdio) server requires a command'; return; }
		if (!isStdio && !draft.url.trim()) { error = 'A remote server requires a URL'; return; }
		if (draft.missingRequired.length > 0) {
			error = `Required: ${draft.missingRequired.map(f => f.name).join(', ')}`;
			return;
		}
		saving = true;
		try {
			const { env, headers } = draft.collect();
			await mcpServersStore.install({
				slug: name, // the backend slugifies and de-dupes
				name,
				transport: draft.transport,
				command: isStdio ? draft.command.trim() : undefined,
				args: isStdio ? draft.args() : undefined,
				url: isStdio ? undefined : draft.url.trim(),
				env,
				headers,
				configSchema: draft.fields,
				source: 'custom'
			});
			onClose();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Install failed';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {isOpen} onClose={onClose} title="Add connector" size="md">
	{#snippet children()}
		<div class="space-y-4 text-sm">
			<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg w-max">
				<button
					type="button"
					class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
						{mode === 'paste'
						? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
						: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => switchMode('paste')}
				>
					Paste JSON
				</button>
				<button
					type="button"
					class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
						{mode === 'form'
						? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
						: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => switchMode('form')}
				>
					Manual
				</button>
			</div>

			{#if mode === 'paste' && !previewed}
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
			{:else if mode === 'paste' && !editing}
				<button
					type="button"
					class="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
					onclick={backToTextarea}
				>
					<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
					Back
				</button>
				<div class="space-y-2">
					{#each parsed as server (server.name)}
						<div class="flex items-start gap-3 p-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
							<div class="flex-1 min-w-0">
								<span class="font-semibold text-slate-900 dark:text-slate-100">{server.name}</span>
								<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500">{transportLabel(server.transport)}</span>
								<p class="text-[11px] text-slate-400 mt-1 truncate font-mono">{parsedSummary(server)}</p>
								{#each server.warnings as warning (warning)}
									<p class="text-[11px] text-amber-600 dark:text-amber-400 mt-1">{warning}</p>
								{/each}
							</div>
							<Button variant="outline" size="sm" onclick={() => editParsed(server)}>Configure</Button>
						</div>
					{/each}
				</div>
			{:else}
				{#if mode === 'paste'}
					<button
						type="button"
						class="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
						onclick={() => (parsed.length > 1 ? backToList() : backToTextarea())}
					>
						<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
						Back
					</button>
				{/if}

				<div class="space-y-5">
					<Input label="Name" required type="text" placeholder="e.g. Notion" bind:value={draft.name} />
					<div class="space-y-1">
						<p class="block text-sm font-semibold text-slate-700 dark:text-slate-300">Transport</p>
						<div class="flex gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg w-max">
							{#each TRANSPORTS as transport (transport)}
								<button
									type="button"
									class="px-3.5 py-1.5 text-sm font-semibold rounded-md transition-colors
										{draft.transport === transport
										? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm'
										: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
									onclick={() => (draft.transport = transport)}
								>
									{transportLabel(transport)}
								</button>
							{/each}
						</div>
					</div>
					{#if draft.transport !== 'stdio'}
						<Input label="URL" required type="text" placeholder="https://example.com/mcp" bind:value={draft.url} />
					{/if}
					<McpConfigForm {draft} />
				</div>

				{#if error}
					<p class="text-xs text-red-500">{error}</p>
				{/if}
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		{#if mode === 'paste' && !previewed}
			<Button variant="ghost" onclick={onClose}>Cancel</Button>
			<Button variant="primary" loading={parsing} disabled={!pasteText.trim()} onclick={runParse}>Preview</Button>
		{:else if mode === 'paste' && !editing}
			<Button variant="ghost" onclick={onClose}>Cancel</Button>
		{:else}
			<Button variant="ghost" onclick={onClose}>Cancel</Button>
			<Button variant="primary" loading={saving} onclick={commit}>Install</Button>
		{/if}
	{/snippet}
</Modal>

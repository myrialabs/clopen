<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import type { DbDriver } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		connectionId: string;
		driver: DbDriver;
		database?: string;
		schema?: string;
		onClose: () => void;
		onImported?: () => void;
	}

	type ImportFormat = 'sql' | 'csv' | 'json' | 'jsonl' | 'redis';

	let {
		isOpen = $bindable(),
		connectionId,
		driver,
		database,
		schema,
		onClose,
		onImported
	}: Props = $props();

	let fileName = $state('');
	let content = $state('');
	let format = $state<ImportFormat>('sql');
	let targetTable = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);

	const formats = $derived<ImportFormat[]>(
		driver === 'mongodb' ? ['json', 'jsonl']
			: driver === 'redis' ? ['json', 'redis']
			: ['sql', 'csv', 'json']
	);

	const needsTarget = $derived(format === 'csv' || format === 'jsonl');
	const isMongo = $derived(driver === 'mongodb');
	const isRedis = $derived(driver === 'redis');
	const itemLabel = $derived(isMongo ? 'collection' : isRedis ? 'key' : 'table');

	$effect(() => {
		if (isOpen) {
			fileName = '';
			content = '';
			targetTable = '';
			error = null;
			success = null;
			format = formats[0];
		}
	});

	$effect(() => {
		if (!formats.includes(format)) format = formats[0];
	});

	function detectFormat(name: string): ImportFormat | null {
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		if (ext === 'sql' && formats.includes('sql')) return 'sql';
		if (ext === 'csv' && formats.includes('csv')) return 'csv';
		if (ext === 'json' && formats.includes('json')) return 'json';
		if (ext === 'jsonl' && formats.includes('jsonl')) return 'jsonl';
		if ((ext === 'redis' || ext === 'txt') && formats.includes('redis')) return 'redis';
		return null;
	}

	async function onFile(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		fileName = file.name;
		const detected = detectFormat(file.name);
		if (detected) format = detected;
		try {
			content = await file.text();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	async function submit(): Promise<void> {
		if (!content) { error = 'Choose a file first'; return; }
		if (needsTarget && !targetTable) { error = `Target ${itemLabel} is required for ${format.toUpperCase()}`; return; }
		busy = true;
		error = null;
		success = null;
		try {
			const result = await ws.http('db-client:data:import', {
				connectionId,
				database,
				schema,
				format,
				content,
				targetTable: targetTable || undefined
			}) as { ok: boolean; count: number; message: string };
			success = result.message;
			onImported?.();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'import failed:', e);
		} finally {
			busy = false;
		}
	}

	const accept = $derived(
		formats.map((f) => '.' + f).concat(formats.includes('redis') ? ['.txt'] : []).join(',')
	);
</script>

<Modal bind:isOpen {onClose} title="Import" size="md">
	{#snippet children()}
		<div class="space-y-3">
			<div>
				<label for="imp-file" class="text-xs font-medium text-slate-700 dark:text-slate-300">File</label>
				<input
					id="imp-file"
					type="file"
					{accept}
					class="block w-full mt-1 text-sm text-slate-700 dark:text-slate-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-slate-200 dark:file:border-slate-700 file:text-sm file:bg-white dark:file:bg-slate-800 file:text-slate-700 dark:file:text-slate-200"
					onchange={onFile}
				/>
				{#if fileName}
					<div class="text-[11px] text-slate-500 mt-1 truncate">Selected: {fileName}</div>
				{/if}
			</div>

			<div>
				<label for="imp-format" class="text-xs font-medium text-slate-700 dark:text-slate-300">Format</label>
				<select
					id="imp-format"
					class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
					bind:value={format}
				>
					{#each formats as f (f)}
						<option value={f}>{f.toUpperCase()}</option>
					{/each}
				</select>
			</div>

			{#if needsTarget}
				<div>
					<label for="imp-target" class="text-xs font-medium text-slate-700 dark:text-slate-300">Target {itemLabel}</label>
					<input
						id="imp-target"
						type="text"
						class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
						placeholder={`Existing ${itemLabel} name`}
						bind:value={targetTable}
					/>
				</div>
			{/if}

			{#if content}
				<div>
					<div class="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Preview</div>
					<pre class="max-h-32 overflow-auto text-[11px] p-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded whitespace-pre-wrap break-all">{content.slice(0, 800)}{content.length > 800 ? '\n…' : ''}</pre>
				</div>
			{/if}

			{#if error}
				<div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10 px-2 py-1.5 rounded">
					<Icon name="lucide:circle-alert" class="w-4 h-4 mt-0.5 shrink-0" />
					<span>{error}</span>
				</div>
			{/if}
			{#if success}
				<div class="flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-2 py-1.5 rounded">
					<Icon name="lucide:check" class="w-4 h-4 mt-0.5 shrink-0" />
					<span>{success}</span>
				</div>
			{/if}
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={onClose}>Close</Button>
		<Button variant="primary" size="sm" onclick={submit} loading={busy} disabled={busy || !content}>
			{busy ? 'Importing…' : 'Import'}
		</Button>
	{/snippet}
</Modal>

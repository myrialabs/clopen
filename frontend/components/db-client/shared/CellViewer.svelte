<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import FkPicker from './FkPicker.svelte';
	import { debug } from '$shared/utils/logger';
	import type { DbClientObjectForeignKey, DbDriver } from '$shared/types/db-client';

	interface Props {
		isOpen: boolean;
		column: string;
		value: unknown;
		onClose: () => void;
		/** Owning table/collection — shown in the title as `table.column`. */
		table?: string;
		// Optional editing support.
		editable?: boolean;
		nullable?: boolean;
		onSave?: (value: unknown) => void | Promise<void>;
		// Optional foreign-key lookup helper.
		fk?: DbClientObjectForeignKey | null;
		connectionId?: string;
		driver?: DbDriver;
		database?: string;
		schema?: string;
	}

	let {
		isOpen = $bindable(),
		column,
		value,
		onClose,
		table,
		editable = false,
		nullable = false,
		onSave,
		fk = null,
		connectionId,
		driver,
		database,
		schema
	}: Props = $props();

	let copied = $state(false);
	let editing = $state(false);
	let draft = $state('');
	let draftIsNull = $state(false);
	let saving = $state(false);
	let pickerOpen = $state(false);

	const isNull = $derived(value === null || value === undefined);
	const canEdit = $derived(editable && !!onSave);
	const modalTitle = $derived(table ? `${table}.${column}` : `Value — ${column}`);
	const canLookup = $derived(!!fk && !!connectionId && !!driver);

	const formatted = $derived(format(value));

	// Reset transient edit state whenever the viewed cell changes or it reopens.
	$effect(() => {
		void column;
		void isOpen;
		editing = false;
		saving = false;
	});

	function format(v: unknown): string {
		if (v === null || v === undefined) return 'NULL';
		if (typeof v === 'object') return JSON.stringify(v, null, 2);
		if (typeof v === 'string') {
			const t = v.trim();
			if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
				try {
					return JSON.stringify(JSON.parse(v), null, 2);
				} catch {
					// not JSON — fall through to raw
				}
			}
			return v;
		}
		return String(v);
	}

	function startEdit(): void {
		draft = isNull ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
		draftIsNull = isNull;
		editing = true;
	}

	function cancelEdit(): void {
		editing = false;
	}

	async function save(): Promise<void> {
		if (!onSave) return;
		saving = true;
		try {
			await onSave(draftIsNull ? null : draft);
			editing = false;
			onClose();
		} catch (e) {
			debug.error('db-client', 'cell save failed:', e);
		} finally {
			saving = false;
		}
	}

	function onPicked(v: unknown): void {
		draft = v === null || v === undefined ? '' : String(v);
		draftIsNull = false;
	}

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(formatted);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch (e) {
			debug.error('db-client', 'cell copy failed:', e);
		}
	}
</script>

<Modal bind:isOpen {onClose} title={modalTitle} size="lg">
	{#snippet children()}
		{#if editing}
			<div class="space-y-2">
				<div class="flex items-center gap-2">
					<textarea
						rows="10"
						class="flex-1 text-sm font-mono bg-slate-50 dark:bg-slate-950 border border-violet-500 rounded-lg p-3 text-slate-800 dark:text-slate-200 resize-y focus:outline-none disabled:opacity-50"
						bind:value={draft}
						disabled={draftIsNull}
					></textarea>
				</div>
				<div class="flex items-center gap-2 flex-wrap">
					{#if canLookup}
						<button
							type="button"
							class="flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 text-sky-600 dark:text-sky-400 hover:bg-sky-500/10 disabled:opacity-50"
							onclick={() => (pickerOpen = true)}
							disabled={draftIsNull}
						>
							<Icon name="lucide:search" class="w-3.5 h-3.5" /> Look up {fk?.refTable}
						</button>
					{/if}
					{#if nullable}
						<label class="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
							<input type="checkbox" bind:checked={draftIsNull} class="accent-violet-600" />
							<span class="italic">Set NULL</span>
						</label>
					{/if}
				</div>
			</div>
		{:else if isNull}
			<div class="text-sm italic text-slate-400 px-1 py-6 text-center">NULL</div>
		{:else}
			<pre class="text-sm whitespace-pre-wrap break-words max-h-[60vh] overflow-auto bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-slate-800 dark:text-slate-200">{formatted}</pre>
		{/if}
	{/snippet}
	{#snippet footer()}
		{#if editing}
			<Button variant="outline" size="sm" onclick={cancelEdit} disabled={saving}>Cancel</Button>
			<Button variant="primary" size="sm" onclick={save} loading={saving} disabled={saving}>
				{saving ? 'Saving…' : 'Save'}
			</Button>
		{:else}
			<Button variant="outline" size="sm" onclick={copy} disabled={isNull}>
				<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5 mr-1.5" />
				{copied ? 'Copied' : 'Copy'}
			</Button>
			{#if canEdit}
				<Button variant="outline" size="sm" onclick={startEdit}>
					<Icon name="lucide:pencil" class="w-3.5 h-3.5 mr-1.5" />
					Edit
				</Button>
			{/if}
			<Button variant="primary" size="sm" onclick={onClose}>Close</Button>
		{/if}
	{/snippet}
</Modal>

{#if fk && connectionId && driver}
	<FkPicker
		bind:isOpen={pickerOpen}
		{connectionId}
		{driver}
		refTable={fk.refTable}
		refColumn={fk.refColumn}
		{database}
		{schema}
		onPick={onPicked}
		onClose={() => (pickerOpen = false)}
	/>
{/if}

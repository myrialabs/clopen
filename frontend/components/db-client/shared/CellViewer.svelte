<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		isOpen: boolean;
		column: string;
		value: unknown;
		onClose: () => void;
	}

	let { isOpen = $bindable(), column, value, onClose }: Props = $props();

	let copied = $state(false);

	const isNull = $derived(value === null || value === undefined);

	const formatted = $derived(format(value));

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

<Modal bind:isOpen {onClose} title={`Value — ${column}`} size="lg">
	{#snippet children()}
		{#if isNull}
			<div class="text-sm italic text-slate-400 px-1 py-6 text-center">NULL</div>
		{:else}
			<pre class="text-sm whitespace-pre-wrap break-words max-h-[60vh] overflow-auto bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-slate-800 dark:text-slate-200">{formatted}</pre>
		{/if}
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={copy} disabled={isNull}>
			<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
			{copied ? 'Copied' : 'Copy'}
		</Button>
		<Button variant="primary" size="sm" onclick={onClose}>Close</Button>
	{/snippet}
</Modal>

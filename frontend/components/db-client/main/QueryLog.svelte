<script lang="ts">
	import { dbClientLog } from '$frontend/stores/features/db-client-log.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { tick, onMount } from 'svelte';

	interface Props {
		connectionId: string;
	}

	const { connectionId }: Props = $props();

	const logEntries = $derived(dbClientLog.getLog(connectionId));

	let scrollContainer = $state<HTMLDivElement | null>(null);
	let loading = $state(false);

	onMount(() => {
		const loadServerLogs = async () => {
			loading = true;
			try {
				const logs = await dbClientStore.getServerLogs(connectionId);
				if (logs && logs.length > 0) {
					dbClientLog.load(connectionId, logs);
				}
			} catch (e) {
				console.error('Failed to load server logs:', e);
			} finally {
				loading = false;
			}
		};
		loadServerLogs();
	});

	// Auto-scroll to the bottom of log when entries update
	$effect(() => {
		if (logEntries.length && scrollContainer) {
			void tick().then(() => {
				if (scrollContainer) {
					scrollContainer.scrollTop = scrollContainer.scrollHeight;
				}
			});
		}
	});

	function clearLog(): void {
		dbClientLog.clear(connectionId);
	}

	function formatTime(date: Date | string): string {
		const parsedDate = typeof date === 'string' ? new Date(date) : date;
		const pad = (n: number) => String(n).padStart(2, '0');
		const y = parsedDate.getFullYear();
		const m = pad(parsedDate.getMonth() + 1);
		const d = pad(parsedDate.getDate());
		const h = pad(parsedDate.getHours());
		const min = pad(parsedDate.getMinutes());
		const s = pad(parsedDate.getSeconds());
		return `${y}-${m}-${d} ${h}:${min}:${s}`;
	}
</script>

<div class="flex flex-col h-full min-h-0 bg-slate-50 dark:bg-slate-900">
	<!-- Log Header -->
	<div class="flex items-center justify-between gap-3 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-white dark:bg-slate-900">
		<div class="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
			<Icon name="lucide:terminal" class="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
			<span>Console Log</span>
		</div>
		<button
			type="button"
			class="flex items-center justify-center p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
			onclick={clearLog}
			title="Clear logs"
			aria-label="Clear logs"
		>
			<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
		</button>
	</div>

	<!-- Log Body -->
	<div
		bind:this={scrollContainer}
		class="flex-1 min-h-0 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed select-text bg-slate-950 text-slate-300"
	>
		{#each logEntries as entry, i (i)}
			<div class="mb-1.5 whitespace-pre-wrap break-all">
				<span class="text-slate-500 dark:text-slate-600 select-none mr-2">{formatTime(entry.at)}</span>
				{#if entry.type === 'executing'}
					<span class="text-slate-200">{entry.message}</span>
				{:else if entry.type === 'result'}
					<span class="text-emerald-400">{entry.message}</span>
				{:else if entry.type === 'error'}
					<span class="text-red-400">{entry.message}</span>
				{/if}
			</div>
		{:else}
			<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-500 dark:text-slate-600 py-10">
				{#if loading}
					<Icon name="lucide:loader" class="w-5 h-5 animate-spin opacity-45" />
					<span class="text-xs">Loading database logs...</span>
				{:else}
					<Icon name="lucide:scroll-text" class="w-8 h-8 opacity-30" />
					<span class="text-xs">No console logs yet</span>
				{/if}
			</div>
		{/each}
	</div>
</div>

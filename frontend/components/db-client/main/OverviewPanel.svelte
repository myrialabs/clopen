<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import DriverIcon from '../shared/DriverIcon.svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type { DbClientConnection, DbClientOverview } from '$shared/types/db-client';

	interface Props {
		connectionId: string;
		database?: string;
	}

	const { connectionId, database }: Props = $props();

	let overview = $state<DbClientOverview | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	const connection = $derived<DbClientConnection | null>(
		dbClientStore.connections.find((c) => c.id === connectionId) ?? null
	);

	// A signature that changes whenever the scope (connection or in-scope
	// database) changes — including database → undefined when stepping back up
	// to the connection. A derived string is unambiguously tracked.
	const scopeSig = $derived(`${connectionId}::${database ?? ''}`);

	$effect(() => {
		void scopeSig;
		if (connectionId) void load();
	});

	async function load(): Promise<void> {
		loading = true;
		error = null;
		try {
			overview = await dbClientStore.overview(connectionId, { database });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			debug.error('db-client', 'overview failed:', e);
		} finally {
			loading = false;
		}
	}

	function formatBytes(n: number | null): string {
		if (n === null || !Number.isFinite(n)) return '—';
		if (n === 0) return '0 B';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
		return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}

	function num(n: number | null): string {
		return n === null ? '—' : n.toLocaleString();
	}

	const cards = $derived<Array<{ label: string; value: string; icon: import('$shared/types/ui/icons').IconName }>>([
		{ label: 'Tables', value: num(overview?.tableCount ?? null), icon: 'lucide:table' },
		{ label: 'Views', value: num(overview?.viewCount ?? null), icon: 'lucide:eye' },
		{ label: 'Size', value: formatBytes(overview?.sizeBytes ?? null), icon: 'lucide:hard-drive' },
		{ label: 'Latency', value: overview?.latencyMs === null || overview?.latencyMs === undefined ? '—' : `${overview.latencyMs} ms`, icon: 'lucide:gauge' }
	]);
</script>

<div class="flex flex-col h-full min-h-0">
	<div class="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
		{#if connection}
			<DriverIcon driver={connection.driver} class="w-5 h-5 shrink-0" />
			<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{database ?? connection.name}</span>
			{#if database}
				<span class="text-xs text-slate-400 dark:text-slate-500 truncate">in {connection.name}</span>
			{/if}
		{/if}
		<div class="flex-1"></div>
		<button
			type="button"
			class="flex items-center gap-1.5 h-7 px-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors text-sm"
			onclick={load}
			disabled={loading}
			title="Refresh"
		>
			<Icon name={loading ? 'lucide:loader' : 'lucide:refresh-cw'} class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
			<span class="hidden sm:inline">Refresh</span>
		</button>
	</div>

	<div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
		{#if error}
			<div class="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">
				<Icon name="lucide:circle-alert" class="w-4 h-4 mt-0.5 shrink-0" />
				<span>{error}</span>
			</div>
		{/if}

		<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
			{#each cards as card (card.label)}
				<div class="flex flex-col gap-1 p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-xl">
					<div class="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
						<Icon name={card.icon} class="w-3.5 h-3.5" />
						{card.label}
					</div>
					<div class="text-lg font-semibold text-slate-900 dark:text-slate-100">{card.value}</div>
				</div>
			{/each}
		</div>

		<div class="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
			<dl class="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
				{#snippet row(label: string, value: string)}
					<div class="flex items-center justify-between gap-4 px-4 py-2.5">
						<dt class="text-slate-500 dark:text-slate-400">{label}</dt>
						<dd class="font-medium text-slate-800 dark:text-slate-200 truncate text-right">{value}</dd>
					</div>
				{/snippet}
				{#if connection}
					{@render row('Driver', connection.driver)}
					{#if connection.host}{@render row('Host', `${connection.host}${connection.port ? `:${connection.port}` : ''}`)}{/if}
				{/if}
				{@render row('Server version', overview?.serverVersion ?? '—')}
				{#each overview?.extra ?? [] as item (item.label)}
					{@render row(item.label, item.value)}
				{/each}
			</dl>
		</div>
	</div>
</div>

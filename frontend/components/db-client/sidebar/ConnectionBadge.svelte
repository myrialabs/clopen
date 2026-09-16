<script lang="ts">
	import DriverIcon from '../shared/DriverIcon.svelte';
	import ProviderMark from '$frontend/components/common/display/ProviderMark.svelte';
	import type { DbClientConnection, DbClientHealth } from '$shared/types/db-client';

	interface Props {
		connection: DbClientConnection;
		health?: DbClientHealth;
		active?: boolean;
		onClick?: () => void;
	}

	const { connection, health, active = false, onClick }: Props = $props();

	const dotClass = $derived.by(() => {
		if (!health) return 'bg-slate-400';
		if (health.ok) return 'bg-emerald-500';
		return 'bg-red-500';
	});

	const driverLabel = $derived({
		mysql: 'MySQL',
		postgres: 'PostgreSQL',
		sqlite: 'SQLite',
		mongodb: 'MongoDB',
		redis: 'Redis',
		mssql: 'SQL Server'
	}[connection.driver]);

	const subtitle = $derived.by(() => {
		if (connection.driver === 'sqlite') {
			return connection.database ?? '(file)';
		}
		const host = connection.host ?? '';
		const port = connection.port ?? '';
		const db = connection.database ? `/${connection.database}` : '';
		const sshTag = connection.ssh.enabled ? ' • ssh' : '';
		return `${host}${port ? `:${port}` : ''}${db}${sshTag}`;
	});
</script>

<button
	type="button"
	class="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left cursor-pointer transition-colors
		{active
			? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
			: 'hover:bg-slate-100 dark:hover:bg-slate-800/60 text-slate-700 dark:text-slate-300'}"
	onclick={onClick}
>
	<div class="relative shrink-0">
		<!-- A managed connection wears its PROVIDER's mark rather than the driver
		     glyph: "Supabase" is what the user chose, and "Postgres" is a detail
		     they can read on the row below. -->
		{#if connection.managedBy}
			<ProviderMark provider={connection.managedBy.provider} size="w-4 h-4" fallback="lucide:database" />
		{:else}
			<DriverIcon driver={connection.driver} class="w-4 h-4" />
		{/if}
		<span
			class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-white dark:border-slate-900 {dotClass}"
		></span>
	</div>
	<div class="flex-1 min-w-0">
		<div class="flex items-center gap-1.5">
			<span class="text-sm font-medium {active ? 'text-violet-700 dark:text-violet-300' : 'text-slate-900 dark:text-slate-100'} truncate">{connection.name}</span>
			<span class="text-3xs text-slate-500 dark:text-slate-400 uppercase tracking-wider shrink-0">{driverLabel}</span>
			<!-- The PROVIDER, named. A link glyph said only "this came from
			     somewhere", which is the one thing a user already knew — and with
			     two accounts on one install it left them guessing which. -->
			{#if connection.managedBy}
				<span
					class="shrink-0 flex items-center gap-1 pl-1 pr-1.5 py-px rounded border border-slate-200 dark:border-slate-700 text-3xs font-medium text-slate-500 dark:text-slate-400"
					title={`Managed by ${connection.managedBy.accountLabel}`}
				>
					<ProviderMark provider={connection.managedBy.provider} size="w-2.5 h-2.5" fallback="lucide:link" />
					{connection.managedBy.providerName}
				</span>
			{/if}
		</div>
		<div class="text-[11px] text-slate-500 dark:text-slate-400 truncate">{subtitle}</div>
	</div>
</button>

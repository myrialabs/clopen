<script lang="ts">
	import DriverIcon from '../shared/DriverIcon.svelte';
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
		redis: 'Redis'
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
	class="flex items-center gap-2.5 w-full py-2 px-3 bg-transparent border rounded-lg text-left cursor-pointer transition-all duration-150
		{active
			? 'border-violet-300 dark:border-violet-700 bg-violet-50 dark:bg-violet-900/20'
			: 'border-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
	onclick={onClick}
>
	<div class="relative shrink-0">
		<DriverIcon driver={connection.driver} class="w-4 h-4" />
		<span
			class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 {dotClass}"
		></span>
	</div>
	<div class="flex-1 min-w-0">
		<div class="flex items-center gap-1.5">
			<span class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{connection.name}</span>
			<span class="text-3xs text-slate-500 dark:text-slate-400 uppercase tracking-wider shrink-0">{driverLabel}</span>
		</div>
		<div class="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">{subtitle}</div>
	</div>
</button>

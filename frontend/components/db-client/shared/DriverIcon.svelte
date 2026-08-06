<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { DbDriver } from '$shared/types/db-client';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		driver: DbDriver;
		class?: string;
	}

	const { driver, class: className = 'w-4 h-4' }: Props = $props();

	const ICONS: Record<DbDriver, IconName> = {
		mysql: 'lucide:database',
		postgres: 'lucide:database',
		sqlite: 'lucide:database',
		mongodb: 'lucide:database',
		redis: 'lucide:server',
		mssql: 'lucide:database'
	};

	const COLORS: Record<DbDriver, string> = {
		mysql: 'text-slate-500 dark:text-slate-400',
		postgres: 'text-slate-500 dark:text-slate-400',
		sqlite: 'text-slate-500 dark:text-slate-400',
		mongodb: 'text-slate-500 dark:text-slate-400',
		redis: 'text-slate-500 dark:text-slate-400',
		mssql: 'text-slate-500 dark:text-slate-400'
	};
</script>

<span class={COLORS[driver]}>
	<Icon name={ICONS[driver]} class={className} />
</span>

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
		sqlite: 'lucide:database-zap',
		mongodb: 'lucide:database-backup',
		redis: 'lucide:server'
	};

	const COLORS: Record<DbDriver, string> = {
		mysql: 'text-sky-500',
		postgres: 'text-indigo-500',
		sqlite: 'text-emerald-500',
		mongodb: 'text-green-600',
		redis: 'text-red-500'
	};
</script>

<span class={COLORS[driver]}>
	<Icon name={ICONS[driver]} class={className} />
</span>

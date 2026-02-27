<script lang="ts">
	interface StatItem {
		label: string;
		value: string | number;
		color: string;
	}

	interface Props {
		stats: StatItem[];
		columns?: number;
	}

	const { stats, columns = 3 }: Props = $props();

	const gridClass = columns === 2 ? 'grid-cols-2' : columns === 4 ? 'grid-cols-4' : 'grid-cols-3';
</script>

<div class="grid {gridClass} gap-4 text-center text-sm">
	{#each stats as stat}
		<div>
			<div class="text-lg font-bold {stat.color}">
				{stat.value}
			</div>
			<div class="text-slate-500 dark:text-slate-400 text-xs">{stat.label}</div>
		</div>
	{/each}
</div>
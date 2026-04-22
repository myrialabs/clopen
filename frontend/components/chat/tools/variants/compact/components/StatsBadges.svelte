<script lang="ts">
	interface StatItem {
		label: string;
		value: string | number;
		color: string;
	}

	interface Props {
		stats: StatItem[];
	}

	const { stats }: Props = $props();
</script>

<div class="flex items-center gap-3 flex-wrap">
	{#each stats as stat}
		<div class="flex items-center gap-1 text-xs">
			<span class="font-bold {stat.color}">{stat.value}</span>
			<span class="text-slate-400 dark:text-slate-500">{stat.label}</span>
		</div>
	{/each}
</div>

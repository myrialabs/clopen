<script lang="ts">
	interface Props {
		command: string;
		description?: string;
		timeout?: number;
	}

	const { command, description, timeout }: Props = $props();

	function formatTimeout(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${ms / 1000}s`;
		if (ms < 3_600_000) return `${ms / 60_000}m`;
		return `${ms / 3_600_000}h`;
	}
</script>

{#if description}
	<p class="text-xs text-slate-500 dark:text-slate-400 mb-0.5">{description}</p>
{/if}
<code class="block text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 rounded px-2 py-1">
	<span class="text-slate-400 dark:text-slate-500 select-none">$ </span>{command}{#if timeout}<span class="ml-2 text-slate-400 dark:text-slate-500">[{formatTimeout(timeout)}]</span>{/if}
</code>

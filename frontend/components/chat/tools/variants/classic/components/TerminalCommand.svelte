<script lang="ts">
	interface Props {
		command: string;
		description?: string;
		timeout?: number;
	}

	const { command, description, timeout }: Props = $props();

	function parseCommandParts(cmd: string) {
		const parts = cmd.split(' ');
		const mainCommand = parts[0];
		const args = parts.slice(1);
		return { mainCommand, args };
	}

	const parsedCommand = $derived(parseCommandParts(command));

	function formatTimeout(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${ms / 1000}s`;
		if (ms < 3_600_000) return `${ms / 60_000}m`;
		return `${ms / 3_600_000}h`;
	}
</script>

{#if description}
	<p class="mb-2 text-slate-700 dark:text-slate-300">
		{description}
	</p>
{/if}

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="flex items-center justify-between gap-2 mb-2">
		<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Command:</span>
		{#if timeout}
			<div class="inline-block ml-auto text-3xs bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 px-2 py-0.5 rounded">
				Timeout: {formatTimeout(timeout)}
			</div>
		{/if}
	</div>

	<div class="max-h-64 overflow-y-auto bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800/60 rounded-md p-2.5 font-mono text-sm">
		<div class="flex items-start gap-2">
			<span class="text-slate-400 dark:text-slate-500 select-none">$</span>
			<div class="flex-1 text-slate-900 dark:text-slate-200 break-all">
				<span class="text-slate-700 dark:text-slate-200 font-medium">{parsedCommand.mainCommand}</span>
				{#if parsedCommand.args.length > 0}
					<span class="text-slate-600 dark:text-slate-300"> {parsedCommand.args.join(' ')}</span>
				{/if}
			</div>
		</div>
	</div>
</div>

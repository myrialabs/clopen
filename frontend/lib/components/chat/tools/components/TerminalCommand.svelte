<script lang="ts">
	interface Props {
		command: string;
		description?: string;
		timeout?: number;
	}

	const { command, description, timeout }: Props = $props();

	// Parse command parts for better display
	function parseCommandParts(cmd: string) {
		const parts = cmd.split(' ');
		const mainCommand = parts[0];
		const args = parts.slice(1);
		return { mainCommand, args };
	}

	const { mainCommand, args } = parseCommandParts(command);
</script>

<!-- Description (if provided) -->
{#if description}
	<p class="mb-2 text-slate-700 dark:text-slate-300">
		{description}
	</p>
{/if}

<!-- Command Display -->
<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="flex items-center justify-between gap-2 mb-2">
		<div class="flex items-center gap-2">
			<div class="w-2 h-2 bg-green-500 rounded-full"></div>
			<span class="text-xs font-medium text-slate-700 dark:text-slate-300">Command:</span>
		</div>
		{#if timeout}
			<div class="inline-block ml-auto text-xs bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded">
				Timeout: {timeout}ms
			</div>
		{/if}
	</div>
	
	<!-- Terminal-style command display -->
	<div class="bg-slate-50 dark:bg-slate-950 border border-slate-200/60 dark:border-slate-800/60 rounded-md p-2.5 font-mono text-sm">
		<div class="flex items-start gap-2">
			<span class="text-green-600 dark:text-green-400 select-none">$</span>
			<div class="flex-1 text-slate-900 dark:text-slate-200 break-all">
				<span class="text-violet-600 dark:text-violet-300 font-medium">{mainCommand}</span>
				{#if args.length > 0}
					<span class="text-slate-700 dark:text-slate-300"> {args.join(' ')}</span>
				{/if}
			</div>
		</div>
	</div>
</div>
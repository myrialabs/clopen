<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { AvailableCommand } from '$frontend/stores/features/commands.svelte';

	interface Props {
		commands: AvailableCommand[];
		activeIndex: number;
		onselect: (command: AvailableCommand) => void;
		onhover: (index: number) => void;
	}

	const { commands, activeIndex, onselect, onhover }: Props = $props();
</script>

<div
	class="absolute bottom-full left-0 mb-2 w-full max-w-xl z-50 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg"
	role="listbox"
	aria-label="Commands"
>
	<div class="max-h-64 overflow-y-auto py-1">
		{#each commands as command, i (command.slug)}
			<button
				type="button"
				role="option"
				aria-selected={i === activeIndex}
				class="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors
					{i === activeIndex ? 'bg-violet-500/10' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}"
				onmousedown={(e) => { e.preventDefault(); onselect(command); }}
				onmousemove={() => onhover(i)}
			>
				<Icon name="lucide:terminal" class="w-4 h-4 mt-0.5 shrink-0 text-violet-600" />
				<div class="min-w-0 flex-1">
					<div class="flex items-center gap-2 flex-wrap">
						<span class="font-semibold text-sm text-slate-900 dark:text-slate-100">/{command.slug}</span>
						{#if command.argumentHint}
							<span class="text-[11px] font-mono text-slate-400">{command.argumentHint}</span>
						{/if}
					</div>
					{#if command.description}
						<p class="text-xs text-slate-500 dark:text-slate-400 truncate">{command.description}</p>
					{/if}
				</div>
			</button>
		{/each}
	</div>
</div>

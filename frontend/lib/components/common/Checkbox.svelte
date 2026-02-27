<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		id: string;
		checked: boolean;
		label?: string;
		disabled?: boolean;
		children?: Snippet;
	}

	let { id, checked = $bindable(false), label, disabled = false, children }: Props = $props();
</script>

<label for={id} class="flex items-start gap-3 cursor-pointer group {disabled ? 'opacity-50 cursor-not-allowed' : ''}">
	<div class="relative flex items-center">
		<input
			type="checkbox"
			{id}
			bind:checked
			{disabled}
			class="sr-only peer"
		/>
		<div
			class="w-5 h-5 border-2 rounded transition-all duration-200
				border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800
				peer-checked:border-violet-600 peer-checked:bg-violet-600
				peer-focus:ring-2 peer-focus:ring-violet-200 dark:peer-focus:ring-violet-900/30
				group-hover:border-violet-500
				peer-disabled:opacity-50 peer-disabled:cursor-not-allowed
				flex items-center justify-center"
		>
			{#if checked}
				<Icon name="lucide:check" class="w-3.5 h-3.5 text-white" />
			{/if}
		</div>
	</div>
	{#if label}
		<div class="flex-1 text-sm text-slate-600 dark:text-slate-400 select-none">
			{label}
		</div>
	{:else if children}
		<div class="flex-1 text-sm text-slate-600 dark:text-slate-400 select-none">
			{@render children()}
		</div>
	{/if}
</label>

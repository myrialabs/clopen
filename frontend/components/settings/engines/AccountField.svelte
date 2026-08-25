<script lang="ts">
	// Labeled input for the shared account edit form. Always a plain text field
	// (API keys/tokens are kept visible, not masked) with a small label + optional hint
	// (e.g. "leave blank to keep").

	interface Props {
		label: string;
		value: string;
		secret?: boolean;
		placeholder?: string;
		hint?: string;
	}

	let { label, value = $bindable(), secret = false, placeholder = '', hint = '' }: Props = $props();

	const resolvedPlaceholder = $derived(placeholder || (hint ? 'Enter new value' : `Enter ${label}`));
</script>

<div class="space-y-1">
	<span class="block text-2xs font-medium text-slate-500 dark:text-slate-400">
		{label} {#if hint}<span class="text-slate-400">{hint}</span>{/if}
	</span>
	<input
		type="text"
		autocomplete={secret ? 'off' : undefined}
		spellcheck={secret ? 'false' : undefined}
		bind:value
		placeholder={resolvedPlaceholder}
		class="w-full px-2.5 py-1.5 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500"
	/>
</div>

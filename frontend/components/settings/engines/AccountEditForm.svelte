<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	// Shared in-card edit form for engine accounts (matches the Pi engine's form).
	// The consumer passes the field inputs as children; this renders the bordered
	// form area plus a consistent button row (Re-authenticate? · Save · Cancel).

	interface Props {
		onSave: () => void;
		onCancel: () => void;
		/** When provided, shows a Re-authenticate button inside the form. */
		onReauth?: () => void;
		reauthLabel?: string;
		saveLabel?: string;
		saveDisabled?: boolean;
		children: Snippet;
	}

	const {
		onSave,
		onCancel,
		onReauth = undefined,
		reauthLabel = 'Re-authenticate',
		saveLabel = 'Save',
		saveDisabled = false,
		children,
	}: Props = $props();
</script>

<div class="px-3.5 pb-3 pt-1 space-y-2 border-t border-slate-200 dark:border-slate-700/50">
	{@render children()}
	<div class="flex flex-wrap gap-2 pt-0.5">
		{#if onReauth}
			<button type="button" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors" onclick={onReauth}>
				<Icon name="lucide:key-round" class="w-3.5 h-3.5" />
				{reauthLabel}
			</button>
		{/if}
		<button type="button" class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" onclick={onSave} disabled={saveDisabled}>
			<Icon name="lucide:check" class="w-3.5 h-3.5" />
			{saveLabel}
		</button>
		<button type="button" class="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" onclick={onCancel}>Cancel</button>
	</div>
</div>

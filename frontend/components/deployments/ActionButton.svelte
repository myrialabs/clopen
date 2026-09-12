<script lang="ts">
	/**
	 * An action button whose spinner REPLACES its icon.
	 *
	 * A spinner beside the button says "something is loading" without saying
	 * which thing — and on a row of four actions that is exactly the question.
	 * Swapping the glyph in place answers it, keeps the row from reflowing while
	 * the work happens, and needs no extra element.
	 *
	 * Every action here is outward-facing, so the whole row disables while one
	 * is running: pressing Redeploy and then Promote a moment later is a
	 * sequence nobody means.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		label: string;
		icon: IconName;
		/** This button's own work is in flight — the icon becomes a spinner. */
		busy?: boolean;
		/** Something else is in flight, or the action is unavailable. */
		disabled?: boolean;
		danger?: boolean;
		onclick: () => void;
	}

	const { label, icon, busy = false, disabled = false, danger = false, onclick }: Props = $props();
</script>

<button
	type="button"
	class="inline-flex items-center gap-1.5 h-8 px-2.5 text-xs font-medium bg-transparent border border-slate-300 dark:border-slate-600 rounded-md text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed
		{danger ? 'hover:border-rose-500/50' : 'hover:border-violet-500/50'}"
	disabled={busy || disabled}
	{onclick}
>
	<Icon name={busy ? 'lucide:loader-circle' : icon} class="w-3.5 h-3.5 {busy ? 'animate-spin' : ''}" />
	{label}
</button>

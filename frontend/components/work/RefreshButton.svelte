<script lang="ts">
	/**
	 * One refresh button, everywhere.
	 *
	 * Three things it does that the hand-rolled ones did not: it spins while the
	 * request is in the air, it disables itself so a second click cannot fire a
	 * duplicate request, and it keeps spinning for a beat after a very fast
	 * response — a spinner that appears and vanishes inside 80ms reads as a
	 * button that did nothing, and the user clicks again.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		isLoading: boolean;
		onRefresh: () => void | Promise<void>;
		label?: string;
		/** Render the word next to the glyph. */
		showLabel?: boolean;
	}

	const { isLoading, onRefresh, label = 'Refresh', showLabel = false }: Props = $props();

	const MIN_SPIN_MS = 400;

	let spinningLocally = $state(false);
	const busy = $derived(isLoading || spinningLocally);

	async function run() {
		if (busy) return;
		spinningLocally = true;
		const started = Date.now();
		try {
			await onRefresh();
		} finally {
			const elapsed = Date.now() - started;
			setTimeout(() => {
				spinningLocally = false;
			}, Math.max(0, MIN_SPIN_MS - elapsed));
		}
	}
</script>

<button
	type="button"
	class="flex items-center justify-center gap-1 {showLabel ? 'px-2' : 'w-7'} h-7 shrink-0 bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-colors duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
	disabled={busy}
	onclick={run}
	aria-label={label}
	title={label}
>
	<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 {busy ? 'animate-spin' : ''}" />
	{#if showLabel}<span class="text-xs">{label}</span>{/if}
</button>

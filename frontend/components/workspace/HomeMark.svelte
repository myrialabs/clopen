<script lang="ts">
	/**
	 * Home's mark: the house icon on a violet tile, the same wherever Home is
	 * shown (sidebar, collapsed navigator, mobile header, welcome screen).
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface Props {
		/** Tailwind size + rounding of the tile, e.g. `w-7 h-7 rounded-lg`. */
		class?: string;
		/** A quieter tile for places that are not selected. */
		muted?: boolean;
	}

	const { class: className = 'w-7 h-7 rounded-lg', muted = false }: Props = $props();
</script>

<span
	class="inline-flex items-center justify-center shrink-0 {className} {muted
		? 'bg-violet-500/15 text-violet-600 dark:text-violet-300'
		: 'bg-gradient-to-br from-violet-500 to-violet-700 text-white shadow-sm shadow-violet-500/30'}"
	aria-hidden="true"
>
	<Icon name="lucide:house" class="w-[58%] h-[58%]" />
</span>

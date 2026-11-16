<script lang="ts">
	/**
	 * Clopen's mark — the app's own logo, the same wherever the assistant is
	 * shown (sidebar, collapsed navigator, mobile header, welcome screen). The
	 * assistant IS Clopen, so it wears Clopen's face rather than an icon.
	 */

	interface Props {
		/** Tailwind size + rounding of the tile, e.g. `w-7 h-7 rounded-lg`. */
		class?: string;
		/** A quieter tile for places that are not selected. */
		muted?: boolean;
	}

	const { class: className = 'w-7 h-7 rounded-lg', muted = false }: Props = $props();
</script>

<img
	src="/favicon.svg"
	alt=""
	aria-hidden="true"
	class="inline-block shrink-0 object-cover {className} {muted ? 'opacity-70 grayscale-[35%]' : 'shadow-sm shadow-violet-500/30'}"
/>

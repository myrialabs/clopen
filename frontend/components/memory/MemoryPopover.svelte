<script lang="ts">
	/**
	 * The panels that open over the graph — search results, projects, filters, the
	 * forgotten list.
	 *
	 * One wrapper rather than four, for two reasons that turned out to be the same
	 * reason. They appeared instantly, which on a dark canvas reads as a glitch
	 * rather than as something opening; and each carried its own surface colour, so
	 * a panel over the graph was the same slate as the graph and its edges were the
	 * only thing separating them.
	 *
	 * The surface is deliberately one step off the canvas — lighter in dark mode,
	 * whiter in light — with a blur behind it and a ring rather than a border. A
	 * panel floating over a field of nodes has to read as ABOVE, and a 1px border
	 * of the same family does not say that; a lift in luminance and a soft shadow
	 * do it without any extra chrome.
	 *
	 * The transition is short on purpose. This is a control surface, not a reveal:
	 * long enough to be seen arriving, short enough that opening it twice in a row
	 * never feels like waiting.
	 */
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import type { Snippet } from 'svelte';

	interface Props {
		/** Extra positioning/sizing classes — the caller owns where it sits. */
		class?: string;
		/** Where it grows from, so the motion points away from its trigger. */
		origin?: 'top' | 'bottom';
		children: Snippet;
	}

	const { class: className = '', origin = 'top', children }: Props = $props();
</script>

<div
	class="z-30 rounded-xl overflow-hidden bg-white/95 dark:bg-slate-800/95 backdrop-blur-md
	       ring-1 ring-slate-900/10 dark:ring-white/10
	       shadow-[0_16px_40px_-12px_rgba(15,23,42,0.35)] dark:shadow-[0_16px_40px_-12px_rgba(0,0,0,0.65)]
	       {className}"
	transition:fly={{ y: origin === 'top' ? -8 : 8, duration: 150, easing: cubicOut }}
>
	{@render children()}
</div>

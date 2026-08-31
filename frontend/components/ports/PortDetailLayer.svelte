<!--
	Ports — how the details for a row appear.

	Alongside the table on a wide screen, over it from below on a narrow one.
	Both entry points render this rather than deciding for themselves, so a row
	behaves the same wherever it was tapped.

	`|global` on the transitions is what makes them run: a transition is local by
	default and only plays when its own block is created, and these sit inside a
	block an ancestor creates.
-->
<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import PortDetail from './main/PortDetail.svelte';
	import type { PortEntry } from '$shared/types/ports';

	interface Props {
		entry: PortEntry;
		onClose: () => void;
	}

	const { entry, onClose }: Props = $props();

	/** Space left above the sheet so the table behind it stays visible. */
	const SHEET_TOP_GAP = 56;
	/** The side panel's own width, so it slides exactly its own length. */
	const PANEL_TRAVEL = 320;

	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	let windowHeight = $state(typeof window !== 'undefined' ? window.innerHeight : 768);

	const isMobile = $derived(windowWidth < 768);
	/**
	 * How far the sheet travels. Derived from the viewport rather than measured
	 * after mount, so the first open slides the same distance as every one after.
	 */
	const sheetTravel = $derived(Math.max(240, Math.round(windowHeight * 0.85) - SHEET_TOP_GAP));
</script>

<svelte:window bind:innerWidth={windowWidth} bind:innerHeight={windowHeight} />

{#if isMobile}
	<button
		type="button"
		class="absolute inset-0 z-20 bg-black/40 border-none p-0 cursor-default"
		transition:fade|global={{ duration: 200 }}
		onclick={onClose}
		aria-label="Close details"
	></button>
	<!-- Stops short of the top on purpose: the strip of table left showing is
	     what says this is a layer over the list, not a page you navigated to. -->
	<div
		class="absolute inset-x-0 bottom-0 z-30 flex shadow-[0_-8px_30px_rgba(0,0,0,0.25)]"
		style="top: {SHEET_TOP_GAP}px"
		transition:fly|global={{ y: sheetTravel, duration: 280, easing: cubicOut, opacity: 1 }}
	>
		<PortDetail sheet {entry} {onClose} />
	</div>
{:else}
	<div
		class="absolute top-0 right-0 bottom-0 flex w-[320px] z-10 will-change-transform"
		style="backface-visibility: hidden; transform: translateZ(0);"
		transition:fly|global={{ x: PANEL_TRAVEL, duration: 320, easing: cubicOut, opacity: 1 }}
	>
		<PortDetail {entry} {onClose} />
	</div>
{/if}

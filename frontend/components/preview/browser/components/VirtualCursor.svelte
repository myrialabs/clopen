<script lang="ts">
	/**
	 * Overlay pointer.
	 *
	 * `variant` is what tells the two apart on screen: the agent's cursor stays
	 * amber, the local one is sky blue. Drawn in the same colour, there was no
	 * way to tell whether the browser was moving on its own.
	 *
	 * `pressed` renders the button as held — the only visible difference
	 * between the agent moving and the agent dragging.
	 */
	let {
		cursor = $bindable<{ x: number; y: number; visible: boolean; clicking?: boolean; pressed?: boolean }>({
			x: 0,
			y: 0,
			visible: false,
			clicking: false
		}),
		variant = 'user' as 'user' | 'mcp'
	} = $props();

	const palette = $derived(
		variant === 'mcp'
			? { idle: '#FFD700', active: '#FFA500', highlight: '#FFF59D', activeHighlight: '#FFE5B4', ring: 'border-orange-500' }
			: { idle: '#38BDF8', active: '#0284C7', highlight: '#BAE6FD', activeHighlight: '#E0F2FE', ring: 'border-sky-500' }
	);

	const engaged = $derived(!!cursor.clicking || !!cursor.pressed);
</script>

{#if cursor.visible}
	<div
		class="fixed pointer-events-none z-50 transition-all duration-100 ease-out"
		style="left: {cursor.x}px; top: {cursor.y}px; margin-left: -4.167px; margin-top: -2.5px;"
	>
		<!-- Cursor body with fixed size -->
		<svg
			width="20"
			height="20"
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			class="drop-shadow-lg transition-transform duration-150 {engaged ? 'scale-90' : ''}"
		>
			<!-- Cursor arrow -->
			<path
				d="M5 3L19 12L12 13L8 21L5 3Z"
				fill={engaged ? palette.active : palette.idle}
				stroke="#333"
				stroke-width="1.5"
				stroke-linejoin="round"
			/>
			<!-- Inner highlight -->
			<path
				d="M7 6L15 11.5L11 12.5L8.5 17L7 6Z"
				fill={engaged ? palette.activeHighlight : palette.highlight}
				opacity="0.7"
			/>
		</svg>

		<!-- Click ripple effect - only show when clicking -->
		{#if cursor.clicking}
			<div class="absolute -z-20">
				<div
					class="absolute w-6 h-6 border-2 {palette.ring} rounded-full animate-ping opacity-75"
					style="left: -8px; top: -28px; animation-duration: 0.5s;"
				></div>
			</div>
		{/if}

		<!-- Button held: a steady ring, so a drag reads as one sustained gesture
		     rather than a burst of clicks. -->
		{#if cursor.pressed && !cursor.clicking}
			<div class="absolute -z-20">
				<div
					class="absolute w-5 h-5 border-2 {palette.ring} rounded-full opacity-90"
					style="left: -7px; top: -27px;"
				></div>
			</div>
		{/if}
	</div>
{/if}

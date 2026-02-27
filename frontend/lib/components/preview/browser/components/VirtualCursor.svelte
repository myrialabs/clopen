<script lang="ts">
	let {
		cursor = $bindable<{x: number, y: number, visible: boolean, clicking?: boolean}>({x: 0, y: 0, visible: false, clicking: false})
	} = $props();
</script>

<!-- Virtual Cursor for Autonomous Testing -->
{#if cursor.visible}
	<div 
		class="fixed pointer-events-none z-50 transition-all duration-100"
		style="left: {cursor.x - 4}px; top: {cursor.y - 2}px;"
	>
		<!-- Cursor body with fixed size -->
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" 
			class="drop-shadow-lg transition-transform duration-150 {cursor.clicking ? 'scale-90' : ''}">
			<!-- Cursor arrow -->
			<path d="M5 3L19 12L12 13L8 21L5 3Z" 
				fill={cursor.clicking ? "#FFA500" : "#FFD700"} 
				stroke="#333" 
				stroke-width="1.5" 
				stroke-linejoin="round"/>
			<!-- Inner highlight -->
			<path d="M7 6L15 11.5L11 12.5L8.5 17L7 6Z" 
				fill={cursor.clicking ? "#FFE5B4" : "#FFF59D"} 
				opacity="0.7"/>
		</svg>
		
		<!-- Click ripple effect - only show when clicking -->
		{#if cursor.clicking}
			<div class="absolute -z-20">
				<div class="absolute w-6 h-6 border-2 border-orange-500 rounded-full animate-ping opacity-75" 
					style="left: -8px; top: -28px; animation-duration: 0.5s;"></div>
			</div>
		{/if}
	</div>
{/if}
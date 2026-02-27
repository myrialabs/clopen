<script lang="ts">
	import type { SplitDirection } from '$frontend/lib/stores/ui/workspace.svelte';
	import { setSplitRatio, workspaceState } from '$frontend/lib/stores/ui/workspace.svelte';

	interface Props {
		direction: SplitDirection;
		path: number[];
		currentRatio: number; // Get from parent
		onResize?: (newRatio: number) => void;
	}

	const { direction, path, currentRatio, onResize }: Props = $props();

	// Drag state
	let isDragging = $state(false);
	let dragStartPos = $state(0);
	let dragStartRatio = $state(0);
	let containerRect = $state<DOMRect | null>(null);

	function handleResizeStart(event: MouseEvent) {
		event.preventDefault();

		isDragging = true;
		dragStartPos = direction === 'horizontal' ? event.clientY : event.clientX;
		dragStartRatio = currentRatio; // Save current ratio at drag start

		// Get container dimensions
		const container = (event.target as HTMLElement).closest('.split-pane-container');
		if (container) {
			containerRect = container.getBoundingClientRect();
		}

		document.addEventListener('mousemove', handleDragMove);
		document.addEventListener('mouseup', handleDragEnd);
		document.body.style.cursor = direction === 'horizontal' ? 'row-resize' : 'col-resize';
		document.body.style.userSelect = 'none';
	}

	function handleDragMove(event: MouseEvent) {
		if (!isDragging || !containerRect) return;

		const currentPos = direction === 'horizontal' ? event.clientY : event.clientX;
		const delta = currentPos - dragStartPos;

		// Calculate delta as percentage of container size
		const containerSize =
			direction === 'horizontal' ? containerRect.height : containerRect.width;
		const deltaPercent = (delta / containerSize) * 100;

		// Calculate new ratio (clamped between 10% and 90%)
		const newRatio = Math.max(10, Math.min(90, dragStartRatio + deltaPercent));

		// Update ratio via store
		setSplitRatio(path, newRatio);

		// Call optional callback
		if (onResize) {
			onResize(newRatio);
		}
	}

	function handleDragEnd() {
		isDragging = false;
		containerRect = null;
		document.removeEventListener('mousemove', handleDragMove);
		document.removeEventListener('mouseup', handleDragEnd);
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	}
</script>

<button
	type="button"
	class="shrink-0 relative z-10 transition-colors duration-150
		{direction === 'horizontal' ? 'h-3 w-full cursor-row-resize' : 'w-3 h-full cursor-col-resize'}
		{isDragging ? 'bg-violet-500/10' : 'hover:bg-violet-500/5'}"
	aria-label="Resize panels"
	onmousedown={handleResizeStart}
>
	<div
		class="transition-all duration-150 bg-violet-500/20 rounded
			{direction === 'horizontal' ? 'h-0.5 w-12 mx-auto' : 'w-0.5 h-12 my-auto mx-auto'}
			{isDragging ? 'bg-violet-600 scale-110' : ''}"
	></div>
</button>
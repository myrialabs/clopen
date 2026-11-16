<script lang="ts">
	/**
	 * Keeps the camera on what matters, from inside the canvas: the selected
	 * step when one is open (so the details panel never covers it), the whole
	 * plan otherwise — again whenever the canvas changes size, as it does when
	 * the panel slides up or is enlarged.
	 */
	import { useSvelteFlow } from '@xyflow/svelte';

	interface Props {
		focus: string | null;
		/** The canvas height; a change refits. */
		height: number;
	}

	const { focus, height }: Props = $props();
	const flow = useSvelteFlow();

	$effect(() => {
		const id = focus;
		void height;
		const timer = setTimeout(() => {
			if (id) void flow.fitView({ nodes: [{ id }], padding: 0.8, duration: 250, maxZoom: 1 });
			else void flow.fitView({ padding: 0.15, duration: 250, maxZoom: 1 });
		}, 60);
		return () => clearTimeout(timer);
	});
</script>

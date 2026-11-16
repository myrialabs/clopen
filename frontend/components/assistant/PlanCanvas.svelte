<script lang="ts">
	/**
	 * The plan of a task or a repeating task, drawn with Svelte Flow: one card
	 * per step, branches and loops as labelled edges, each card marked with how
	 * it went. Laid out as a snake (four columns, one on a phone) from the
	 * plan's structure alone, so it looks the same every time. A tap on a card
	 * selects it; the details are shown by the caller.
	 */
	import { SvelteFlow, Background, BackgroundVariant, Controls, MarkerType, type Node, type Edge } from '@xyflow/svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import PlanNode from './PlanNode.svelte';
	import PlanFocus from './PlanFocus.svelte';
	import { buildPlanGraph, layoutPlan, type PlanNodeData } from './plan-graph';
	import type { Recipe, RecipeTraceEntry } from '$shared/types/recipe';

	interface Props {
		recipe: Recipe;
		trace: RecipeTraceEntry[];
		/** The steps under way now. */
		runningSteps?: string[];
		trigger?: string | null;
		running?: boolean;
		/** The run is over: steps it never reached say so. */
		ended?: boolean;
		vertical?: boolean;
		selected?: string | null;
		onSelect?: (path: string | null) => void;
		/** Services the plan uses that are not connected yet. */
		notConnected?: string[];
	}

	const { recipe, trace, runningSteps = [], trigger = null, running = false, ended = false, vertical = false, selected = null, onSelect, notConnected = [] }: Props = $props();

	const nodeTypes = { step: PlanNode };
	const colorMode = $derived(themeStore.isDark ? 'dark' : 'light');

	let nodes = $state.raw<Node[]>([]);
	let canvasHeight = $state(0);
	let edges = $state.raw<Edge[]>([]);

	$effect(() => {
		const graph = buildPlanGraph({ recipe, trace, runningSteps, trigger, running, ended, vertical, selected });
		const layout = layoutPlan(graph, vertical ? 1 : 4);

		const muted = themeStore.isDark ? '#475569' : '#cbd5e1';
		const accent = themeStore.isDark ? '#a78bfa' : '#7c3aed';
		nodes = graph.nodes.map((entry) => {
			const at = layout.positions.get(entry.id) ?? { x: 0, y: 0 };
			const missing = entry.data.kind === 'use' && notConnected.some((service) => service.toLowerCase() === entry.data.who.toLowerCase());
			return { id: entry.id, type: 'step', position: at, data: { ...entry.data, notConnected: missing } as PlanNodeData, draggable: false } satisfies Node;
		});
		const statusOf = new Map(graph.nodes.map((entry) => [entry.id, entry.data.status]));
		edges = graph.edges.map((link) => {
			const from = statusOf.get(link.source) ?? 'waiting';
			const to = statusOf.get(link.target) ?? 'waiting';
			// Only the hop that is happening now moves: from what just finished to what is running.
			const active = to === 'running' && (from === 'done' || link.source === 'trigger');
			const travelled = from === 'done' && to !== 'waiting' && to !== 'unreached' && to !== 'running';
			const color = active || travelled ? accent : muted;
			const sides = layout.handles.get(link.id) ?? { source: 'right', target: 'left' };
			return {
				id: link.id,
				source: link.source,
				target: link.target,
				sourceHandle: `${sides.source}-s`,
				targetHandle: `${sides.target}-t`,
				type: 'smoothstep',
				label: link.label,
				animated: active,
				// Solid everywhere — loops too; only the moving hop is dashed.
				style: `stroke:${color};stroke-width:${active ? 2 : 1.5};${active ? 'stroke-dasharray:6 5;' : 'stroke-dasharray:none;'}`,
				labelStyle: 'font-size:11px;',
				markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color }
			} satisfies Edge;
		});
	});
</script>

<div class="plan-flow h-full w-full min-h-64" bind:clientHeight={canvasHeight}>
	<SvelteFlow
		bind:nodes
		bind:edges
		{nodeTypes}
		{colorMode}
		fitView
		fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
		minZoom={0.2}
		maxZoom={1.6}
		nodesConnectable={false}
		nodesDraggable={false}
		elementsSelectable={false}
		deleteKey={null}
		proOptions={{ hideAttribution: true }}
		onnodeclick={({ node }) => onSelect?.(node.id === 'trigger' || node.id === selected ? null : node.id)}
		onpaneclick={() => onSelect?.(null)}
	>
		<!-- The same dots as an empty canvas and the Preview Browser: slate-400 at a quarter. -->
		<PlanFocus focus={selected} height={canvasHeight} />
		<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} bgColor="transparent" patternColor="rgb(148 163 184 / 0.35)" />
		<Controls showLock={false} />
	</SvelteFlow>
</div>

<style>
	.plan-flow :global(.svelte-flow) {
		background: transparent;
		--xy-controls-button-background-color: #ffffff;
		--xy-controls-button-background-color-hover: #f1f5f9;
		--xy-controls-button-color: #475569;
		--xy-controls-button-border-color: #e2e8f0;
		--xy-edge-label-background-color: #ffffff;
		--xy-edge-label-color: #64748b;
	}
	.plan-flow :global(.svelte-flow.dark) {
		--xy-controls-button-background-color: #1e293b;
		--xy-controls-button-background-color-hover: #334155;
		--xy-controls-button-color: #cbd5e1;
		--xy-controls-button-border-color: #334155;
		--xy-edge-label-background-color: #0f172a;
		--xy-edge-label-color: #94a3b8;
	}
</style>

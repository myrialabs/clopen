<script lang="ts">
	import { SvelteFlow, Background, Controls, MarkerType, type Node, type Edge } from '@xyflow/svelte';
	import dagre from '@dagrejs/dagre';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import PanelLoader from '../shared/PanelLoader.svelte';
	import TableNode from './TableNode.svelte';

	interface Props {
		connectionId: string;
		database?: string;
		schema?: string;
		tableName: string;
	}

	const { connectionId, database, schema, tableName }: Props = $props();

	interface ErColumn {
		name: string;
		type: string;
		isPrimary: boolean;
		isUnique: boolean;
	}

	interface ErForeignKey {
		column: string;
		refTable: string;
		refColumn: string;
	}

	interface ErTable {
		name: string;
		columns: ErColumn[];
		foreignKeys: ErForeignKey[];
	}

	// Card geometry — kept in sync with TableNode.svelte so dagre reserves
	// roughly the right amount of space per node.
	const NODE_W = 240;
	const HEADER_H = 33;
	const ROW_H = 22;
	const BODY_PAD_Y = 8;
	const nodeHeight = (cols: number) => HEADER_H + BODY_PAD_Y + cols * ROW_H;

	const nodeTypes = { table: TableNode };

	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const colorMode = $derived(themeStore.isDark ? 'dark' : 'light');

	// Reload whenever the selected object (or connection scope) changes — e.g.
	// switching tables from the sidebar or tabs. A sequence guard drops stale
	// responses if the user switches again before the previous load resolves.
	let loadSeq = 0;
	$effect(() => {
		// Touch the reactive inputs so the effect re-runs when they change.
		void connectionId;
		void database;
		void schema;
		void tableName;
		void load(++loadSeq);
	});

	async function load(seq: number): Promise<void> {
		loading = true;
		error = null;
		try {
			const res = await dbClientStore.getErSchema(connectionId, { database, schema });
			if (seq !== loadSeq) return;
			const allTables: ErTable[] = res.tables;

			// Keep the active table and its direct relations (both directions).
			const related = new Set<string>([tableName]);
			const active = allTables.find((t) => t.name === tableName);
			active?.foreignKeys.forEach((fk) => related.add(fk.refTable));
			allTables.forEach((t) => {
				if (t.foreignKeys.some((fk) => fk.refTable === tableName)) related.add(t.name);
			});

			const tables = allTables.filter((t) => related.has(t.name));

			// Every column is always rendered, so height follows the full count.
			const heights: Record<string, number> = {};
			tables.forEach((t) => {
				heights[t.name] = nodeHeight(t.columns.length);
			});

			// ── Auto-layout: run dagre both ways, keep the most balanced one ──
			const runLayout = (rankdir: 'LR' | 'TB') => {
				const g = new dagre.graphlib.Graph();
				g.setGraph({ rankdir, nodesep: 36, ranksep: 130, marginx: 24, marginy: 24 });
				g.setDefaultEdgeLabel(() => ({}));
				tables.forEach((t) => g.setNode(t.name, { width: NODE_W, height: heights[t.name] }));
				tables.forEach((t) => {
					t.foreignKeys.forEach((fk) => {
						if (related.has(fk.refTable) && fk.refTable !== t.name) g.setEdge(t.name, fk.refTable);
					});
				});
				dagre.layout(g);
				const pos: Record<string, { x: number; y: number }> = {};
				tables.forEach((t) => {
					const gn = g.node(t.name);
					pos[t.name] = { x: gn.x - NODE_W / 2, y: gn.y - heights[t.name] / 2 };
				});
				const graph = g.graph();
				const w = graph.width ?? 1;
				const h = graph.height ?? 1;
				// Distance (in log space) from a comfortable landscape aspect ratio.
				const score = Math.abs(Math.log(w / h) - Math.log(1.6));
				return { pos, score };
			};

			const lr = runLayout('LR');
			const tb = runLayout('TB');
			const posMap = (tb.score < lr.score ? tb : lr).pos;

			// Svelte Flow positions by top-left (dagre already offset above).
			nodes = tables.map((t) => {
				const fkCols = new Set(t.foreignKeys.map((fk) => fk.column));
				return {
					id: t.name,
					type: 'table',
					position: { ...posMap[t.name] },
					dragHandle: '.er-drag-handle',
					data: {
						label: t.name,
						isActive: t.name === tableName,
						columns: t.columns.map((c) => ({
							name: c.name,
							type: c.type,
							isPrimary: c.isPrimary,
							isFk: fkCols.has(c.name)
						}))
					}
				} satisfies Node;
			});

			// ── Edges: attach to the specific FK → PK column rows ────────────
			const strokeActive = themeStore.isDark ? '#7c6df2' : '#8b5cf6';
			const strokeIdle = themeStore.isDark ? '#475569' : '#94a3b8';
			const built: Edge[] = [];
			tables.forEach((t) => {
				t.foreignKeys.forEach((fk, i) => {
					if (!posMap[t.name] || !posMap[fk.refTable]) return;
					// Choose which side each handle sits on based on the laid-out
					// positions, so lines leave/enter the nearest card edge.
					const rightward = posMap[t.name].x <= posMap[fk.refTable].x;
					const touchesActive = t.name === tableName || fk.refTable === tableName;
					const color = touchesActive ? strokeActive : strokeIdle;
					built.push({
						id: `${t.name}.${fk.column}->${fk.refTable}.${fk.refColumn}#${i}`,
						source: t.name,
						target: fk.refTable,
						sourceHandle: `${fk.column}__source-${rightward ? 'right' : 'left'}`,
						targetHandle: `${fk.refColumn}__target-${rightward ? 'left' : 'right'}`,
						type: 'default',
						animated: false,
						style: `stroke:${color};stroke-width:1.5;`,
						markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color }
					});
				});
			});
			edges = built;
		} catch (e) {
			if (seq !== loadSeq) return;
			error = e instanceof Error ? e.message : String(e);
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}
</script>

<div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-white dark:bg-slate-900">
	{#if loading}
		<PanelLoader />
	{:else if error}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-red-500 p-6">
			<Icon name="lucide:circle-alert" class="w-10 h-10" />
			<span class="text-sm font-semibold">{error}</span>
		</div>
	{:else if nodes.length === 0}
		<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-400 py-10">
			<Icon name="lucide:network" class="w-12 h-12 opacity-30" />
			<span class="text-sm">No tables found to display</span>
		</div>
	{:else}
		<div class="er-flow flex-1 min-h-0">
			<SvelteFlow
				bind:nodes
				bind:edges
				{nodeTypes}
				{colorMode}
				fitView
				minZoom={0.15}
				maxZoom={2.5}
				nodesConnectable={false}
				elementsSelectable={false}
				deleteKey={null}
				proOptions={{ hideAttribution: true }}
			>
				<Background
					gap={20}
					bgColor={themeStore.isDark ? '#0f172a' : '#ffffff'}
					patternColor={themeStore.isDark ? '#334155' : '#cbd5e1'}
				/>
				<Controls showLock={false} />
			</SvelteFlow>
		</div>
	{/if}
</div>

<style>
	.er-flow {
		position: relative;
	}
	.er-flow :global(.svelte-flow) {
		background: transparent;
		/* Zoom / fit control buttons — light theme. */
		--xy-controls-button-background-color: #ffffff;
		--xy-controls-button-background-color-hover: #f1f5f9;
		--xy-controls-button-color: #475569;
		--xy-controls-button-color-hover: #0f172a;
		--xy-controls-button-border-color: #e2e8f0;
	}
	.er-flow :global(.svelte-flow.dark) {
		/* Zoom / fit control buttons — dark theme (matches slate panels). */
		--xy-controls-button-background-color: #1e293b;
		--xy-controls-button-background-color-hover: #334155;
		--xy-controls-button-color: #cbd5e1;
		--xy-controls-button-color-hover: #f1f5f9;
		--xy-controls-button-border-color: #334155;
	}
</style>

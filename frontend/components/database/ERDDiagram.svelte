<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { ERDMetadata, ERDNode, ERDEdge } from '$shared/types/erd';

	interface Props {
		metadata: ERDMetadata;
		onTableClick: (tableName: string, schema?: string) => void;
	}

	let { metadata, onTableClick }: Props = $props();

	// ─── Layout Constants ──────────────────────────────────────────────────────
	const NODE_W = 210;
	const HEADER_H = 34;
	const COL_ROW_H = 22;
	const COL_PADDING_BOTTOM = 6;
	const H_GAP = 70;
	const V_GAP = 80;
	const LAYOUT_OFFSET = 24;

	function nodeHeight(colCount: number): number {
		return HEADER_H + colCount * COL_ROW_H + COL_PADDING_BOTTOM;
	}

	// ─── Auto-Layout Algorithm ─────────────────────────────────────────────────
	// Layered (Sugiyama-inspired) layout:
	//   Layer 0 = pure parent tables (no FK columns → not a child of any table)
	//   Layer N = tables that FK-reference layer N-1 tables
	//
	// Graph edge direction: fromTable ──FK──▶ toTable
	//   fromTable = child (has the FK column)
	//   toTable   = parent (referenced table)

	function computeLayout(meta: ERDMetadata): { nodes: ERDNode[]; edges: ERDEdge[] } {
		const { tables, relationships: rels } = meta;
		if (tables.length === 0) return { nodes: [], edges: [] };

		// ── 1. Assign layers ──────────────────────────────────────────────────
		const layer = new Map<string, number>();

		// childrenOf[parent] = tables that have FK pointing TO parent
		const childrenOf = new Map<string, string[]>();
		const isChild = new Set<string>(); // tables that are fromTable in any FK

		for (const rel of rels) {
			isChild.add(rel.fromTable);
			if (!childrenOf.has(rel.toTable)) childrenOf.set(rel.toTable, []);
			childrenOf.get(rel.toTable)!.push(rel.fromTable);
		}

		// Seed: pure parents = tables that are never a child (never appear as fromTable)
		const queue: string[] = [];
		for (const t of tables) {
			if (!isChild.has(t.name)) {
				layer.set(t.name, 0);
				queue.push(t.name);
			}
		}

		// If every table has FKs (circular or all-FK schema) → seed all at layer 0
		if (queue.length === 0) {
			for (const t of tables) {
				layer.set(t.name, 0);
				queue.push(t.name);
			}
		}

		// BFS: propagate layers downward (parents → children)
		const processed = new Set<string>();
		let qi = 0;
		while (qi < queue.length) {
			const curr = queue[qi++];
			if (processed.has(curr)) continue;
			processed.add(curr);
			const currLayer = layer.get(curr) ?? 0;
			for (const child of childrenOf.get(curr) ?? []) {
				const newLayer = currLayer + 1;
				if ((layer.get(child) ?? -1) < newLayer) {
					layer.set(child, newLayer);
				}
				if (!processed.has(child)) queue.push(child);
			}
		}

		// Fallback: isolated tables with no FK at all
		for (const t of tables) {
			if (!layer.has(t.name)) layer.set(t.name, 0);
		}

		// ── 2. Group by layer & position ──────────────────────────────────────
		const maxLayer = Math.max(...[...layer.values()]);
		const layerGroups: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
		for (const t of tables) {
			layerGroups[layer.get(t.name) ?? 0].push(t.name);
		}

		const tableMap = new Map(tables.map((t) => [t.name, t]));
		const nodeMap = new Map<string, ERDNode>();

		let y = LAYOUT_OFFSET;
		for (let lyr = 0; lyr <= maxLayer; lyr++) {
			const names = layerGroups[lyr];
			let x = LAYOUT_OFFSET;
			let maxH = 0;
			for (const name of names) {
				const table = tableMap.get(name)!;
				const h = nodeHeight(table.columns.length);
				nodeMap.set(name, { id: name, table, x, y, width: NODE_W, height: h });
				x += NODE_W + H_GAP;
				maxH = Math.max(maxH, h);
			}
			y += maxH + V_GAP;
		}

		// ── 3. Build edges ────────────────────────────────────────────────────
		const edges: ERDEdge[] = rels.map((rel, i) => ({
			id: `e${i}`,
			fromTable: rel.fromTable,
			fromColumn: rel.fromColumn,
			toTable: rel.toTable,
			toColumn: rel.toColumn,
			constraintName: rel.constraintName
		}));

		return { nodes: [...nodeMap.values()], edges };
	}

	const layout = $derived(computeLayout(metadata));

	// ─── Edge Path ─────────────────────────────────────────────────────────────

	function getEdgePath(edge: ERDEdge, nodeMap: Map<string, ERDNode>): string {
		const fromNode = nodeMap.get(edge.fromTable);
		const toNode = nodeMap.get(edge.toTable);
		if (!fromNode || !toNode) return '';

		const fromColIdx = Math.max(
			0,
			fromNode.table.columns.findIndex((c) => c.name === edge.fromColumn)
		);
		const toColIdx = Math.max(
			0,
			toNode.table.columns.findIndex((c) => c.name === edge.toColumn)
		);

		const fromY = fromNode.y + HEADER_H + fromColIdx * COL_ROW_H + COL_ROW_H / 2;
		const toY = toNode.y + HEADER_H + toColIdx * COL_ROW_H + COL_ROW_H / 2;

		const fromCenterX = fromNode.x + NODE_W / 2;
		const toCenterX = toNode.x + NODE_W / 2;

		let fromX: number, toX: number, cp1x: number, cp2x: number;

		if (fromCenterX <= toCenterX) {
			fromX = fromNode.x + NODE_W;
			toX = toNode.x;
			const dx = Math.max(40, Math.abs(toX - fromX) * 0.4);
			cp1x = fromX + dx;
			cp2x = toX - dx;
		} else {
			fromX = fromNode.x;
			toX = toNode.x + NODE_W;
			const dx = Math.max(40, Math.abs(fromX - toX) * 0.4);
			cp1x = fromX - dx;
			cp2x = toX + dx;
		}

		return `M ${fromX} ${fromY} C ${cp1x} ${fromY} ${cp2x} ${toY} ${toX} ${toY}`;
	}

	// ─── Pan & Zoom ────────────────────────────────────────────────────────────

	let viewX = $state(0);
	let viewY = $state(0);
	let scale = $state(1);
	let isDragging = $state(false);
	let dragStartX = $state(0);
	let dragStartY = $state(0);
	let hoveredTable = $state<string | null>(null);
	let svgEl = $state<SVGSVGElement | null>(null);

	function handleWheel(e: WheelEvent) {
		e.preventDefault();
		const factor = e.deltaY > 0 ? 0.9 : 1.1;
		const newScale = Math.max(0.12, Math.min(3, scale * factor));
		const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		viewX = mx - (mx - viewX) * (newScale / scale);
		viewY = my - (my - viewY) * (newScale / scale);
		scale = newScale;
	}

	function handleMousedown(e: MouseEvent) {
		if ((e.target as Element).closest('.erd-node')) return;
		isDragging = true;
		dragStartX = e.clientX - viewX;
		dragStartY = e.clientY - viewY;
		e.preventDefault();
	}

	function handleMousemove(e: MouseEvent) {
		if (!isDragging) return;
		viewX = e.clientX - dragStartX;
		viewY = e.clientY - dragStartY;
	}

	function handleMouseup() {
		isDragging = false;
	}

	function zoomIn() {
		scale = Math.min(3, scale * 1.2);
	}

	function zoomOut() {
		scale = Math.max(0.12, scale / 1.2);
	}

	function fitView() {
		if (!layout.nodes.length || !svgEl) return;
		const minX = Math.min(...layout.nodes.map((n) => n.x));
		const minY = Math.min(...layout.nodes.map((n) => n.y));
		const maxX = Math.max(...layout.nodes.map((n) => n.x + n.width));
		const maxY = Math.max(...layout.nodes.map((n) => n.y + n.height));
		const contentW = maxX - minX + 48;
		const contentH = maxY - minY + 48;
		const rect = svgEl.getBoundingClientRect();
		const newScale = Math.min(rect.width / contentW, rect.height / contentH, 1.5);
		scale = newScale;
		viewX = (rect.width - contentW * newScale) / 2 - minX * newScale + 24 * newScale;
		viewY = (rect.height - contentH * newScale) / 2 - minY * newScale + 24 * newScale;
	}

	// Fit view when layout data arrives
	$effect(() => {
		if (svgEl && layout.nodes.length) {
			setTimeout(fitView, 60);
		}
	});

	// ─── Helpers ──────────────────────────────────────────────────────────────

	function isRelated(edge: ERDEdge, name: string | null): boolean {
		return !!name && (edge.fromTable === name || edge.toTable === name);
	}

	function truncate(s: string, max: number): string {
		return s.length > max ? s.slice(0, max - 1) + '…' : s;
	}

	// Build node map for edge path computation (derived)
	const nodeById = $derived(new Map(layout.nodes.map((n) => [n.id, n])));
</script>

<div
	class="relative w-full h-full overflow-hidden"
	style="cursor: {isDragging ? 'grabbing' : 'grab'}; background-color: var(--erd-bg);"
>
	<!-- SVG canvas -->
	<svg
		bind:this={svgEl}
		class="w-full h-full"
		onwheel={handleWheel}
		onmousedown={handleMousedown}
		onmousemove={handleMousemove}
		onmouseup={handleMouseup}
		onmouseleave={handleMouseup}
	>
		<defs>
			<!-- Arrowhead for FK edges -->
			<marker
				id="erd-arr"
				viewBox="0 0 10 10"
				refX="9"
				refY="5"
				markerWidth="5"
				markerHeight="5"
				orient="auto-start-reverse"
			>
				<path d="M 0 1 L 9 5 L 0 9 z" style="fill: var(--erd-edge)" />
			</marker>
			<marker
				id="erd-arr-hi"
				viewBox="0 0 10 10"
				refX="9"
				refY="5"
				markerWidth="5"
				markerHeight="5"
				orient="auto-start-reverse"
			>
				<path d="M 0 1 L 9 5 L 0 9 z" style="fill: var(--erd-edge-hi)" />
			</marker>
			<!-- Dot at FK column origin -->
			<marker
				id="erd-dot"
				viewBox="0 0 10 10"
				refX="5"
				refY="5"
				markerWidth="5"
				markerHeight="5"
			>
				<circle cx="5" cy="5" r="3.5" style="fill: var(--erd-edge)" />
			</marker>
			<marker
				id="erd-dot-hi"
				viewBox="0 0 10 10"
				refX="5"
				refY="5"
				markerWidth="5"
				markerHeight="5"
			>
				<circle cx="5" cy="5" r="3.5" style="fill: var(--erd-edge-hi)" />
			</marker>
		</defs>

		<g transform="translate({viewX},{viewY}) scale({scale})">
			<!-- ── Edges ─────────────────────────────────────────── -->
			{#each layout.edges as edge (edge.id)}
				{@const hi = isRelated(edge, hoveredTable)}
				<path
					d={getEdgePath(edge, nodeById)}
					fill="none"
					stroke={hi ? 'var(--erd-edge-hi)' : 'var(--erd-edge)'}
					stroke-width={hi ? 2 : 1.5}
					marker-end={hi ? 'url(#erd-arr-hi)' : 'url(#erd-arr)'}
					marker-start={hi ? 'url(#erd-dot-hi)' : 'url(#erd-dot)'}
					style="transition: stroke 0.15s"
				/>
			{/each}

			<!-- ── Nodes ─────────────────────────────────────────── -->
			{#each layout.nodes as node (node.id)}
				{@const hi = hoveredTable === node.id}
				<!-- svelte-ignore a11y_interactive_supports_focus -->
				<g
					class="erd-node"
					transform="translate({node.x},{node.y})"
					onmouseenter={() => (hoveredTable = node.id)}
					onmouseleave={() => (hoveredTable = null)}
					onclick={() => onTableClick(node.table.name, node.table.schema)}
					onkeydown={(e) => e.key === 'Enter' && onTableClick(node.table.name, node.table.schema)}
					style="cursor: pointer"
					role="button"
				>
					<!-- Outer glow on hover -->
					{#if hi}
						<rect
							x="-3"
							y="-3"
							width={node.width + 6}
							height={node.height + 6}
							rx="10"
							fill="none"
							stroke="var(--erd-border-hi)"
							stroke-width="2"
							opacity="0.5"
						/>
					{/if}

					<!-- Node body -->
					<rect
						width={node.width}
						height={node.height}
						rx="7"
						fill={hi ? 'var(--erd-node-bg-hi)' : 'var(--erd-node-bg)'}
						stroke={hi ? 'var(--erd-border-hi)' : 'var(--erd-border)'}
						stroke-width="1"
					/>

					<!-- Header background (top portion) -->
					<clipPath id="hdr-{node.id}">
						<rect width={node.width} height={HEADER_H + 7} rx="7" />
					</clipPath>
					<rect
						width={node.width}
						height={HEADER_H + 7}
						clip-path="url(#hdr-{node.id})"
						fill={hi ? 'var(--erd-header-bg-hi)' : 'var(--erd-header-bg)'}
					/>
					<!-- Square bottom of header block -->
					<rect
						y={HEADER_H - 7}
						width={node.width}
						height={14}
						fill={hi ? 'var(--erd-header-bg-hi)' : 'var(--erd-header-bg)'}
					/>

					<!-- Header text: table name -->
					<text
						x={node.width / 2}
						y={HEADER_H / 2 + 1}
						text-anchor="middle"
						dominant-baseline="middle"
						font-size="12"
						font-weight="600"
						font-family="system-ui, -apple-system, sans-serif"
						fill={hi ? 'var(--erd-header-text-hi)' : 'var(--erd-header-text)'}
					>
						{truncate(node.table.name, 22)}
					</text>

					<!-- Header bottom divider -->
					<line
						x1="0"
						y1={HEADER_H}
						x2={node.width}
						y2={HEADER_H}
						stroke="var(--erd-divider)"
						stroke-width="1"
					/>

					<!-- ── Columns ──────────────────────────────── -->
					{#each node.table.columns as col, i}
						{@const rowY = HEADER_H + i * COL_ROW_H}
						<!-- Hover row highlight -->
						{#if hi}
							<rect
								y={rowY}
								width={node.width}
								height={COL_ROW_H}
								fill="var(--erd-row-hover)"
								opacity="0"
							/>
						{/if}

						<!-- PK / FK badge -->
						{#if col.isPrimary}
							<text
								x="8"
								y={rowY + COL_ROW_H / 2 + 1}
								dominant-baseline="middle"
								font-size="8"
								font-weight="700"
								font-family="monospace"
								fill="var(--erd-pk)"
							>PK</text>
						{:else if col.isForeign}
							<text
								x="8"
								y={rowY + COL_ROW_H / 2 + 1}
								dominant-baseline="middle"
								font-size="8"
								font-weight="700"
								font-family="monospace"
								fill="var(--erd-fk)"
							>FK</text>
						{/if}

						<!-- Column name -->
						<text
							x="32"
							y={rowY + COL_ROW_H / 2 + 1}
							dominant-baseline="middle"
							font-size="11"
							font-family="system-ui, -apple-system, sans-serif"
							font-weight={col.isPrimary ? '600' : col.isForeign ? '500' : '400'}
							fill={col.isPrimary
								? 'var(--erd-pk)'
								: col.isForeign
									? 'var(--erd-fk)'
									: 'var(--erd-col-name)'}
						>
							{truncate(col.name, 18)}
						</text>

						<!-- Column type (right-aligned) -->
						<text
							x={node.width - 7}
							y={rowY + COL_ROW_H / 2 + 1}
							text-anchor="end"
							dominant-baseline="middle"
							font-size="9"
							font-family="monospace"
							fill="var(--erd-col-type)"
						>
							{truncate(col.type, 11)}
						</text>

						<!-- Row divider (except last column) -->
						{#if i < node.table.columns.length - 1}
							<line
								x1="0"
								y1={rowY + COL_ROW_H}
								x2={node.width}
								y2={rowY + COL_ROW_H}
								stroke="var(--erd-divider)"
								stroke-width="0.5"
								opacity="0.6"
							/>
						{/if}
					{/each}
				</g>
			{/each}
		</g>
	</svg>

	<!-- Zoom controls (bottom-right) -->
	<div class="absolute bottom-4 right-4 flex flex-col gap-1 z-10">
		<button
			type="button"
			onclick={zoomIn}
			class="w-7 h-7 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-violet-50 dark:hover:bg-slate-700 shadow-sm flex items-center justify-center text-sm font-medium transition-colors"
			title="Zoom in"
		>+</button>
		<button
			type="button"
			onclick={fitView}
			class="w-7 h-7 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-violet-50 dark:hover:bg-slate-700 shadow-sm flex items-center justify-center transition-colors"
			title="Fit to screen"
		>
			<Icon name="lucide:maximize-2" class="w-3.5 h-3.5" />
		</button>
		<button
			type="button"
			onclick={zoomOut}
			class="w-7 h-7 rounded-md bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-violet-50 dark:hover:bg-slate-700 shadow-sm flex items-center justify-center text-sm font-medium transition-colors"
			title="Zoom out"
		>−</button>
	</div>

	<!-- Scale indicator (bottom-left) -->
	<div class="absolute bottom-4 left-4 z-10 pointer-events-none">
		<span
			class="text-xs text-slate-400 dark:text-slate-500 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm px-2 py-1 rounded border border-slate-200/50 dark:border-slate-700/50"
		>
			{Math.round(scale * 100)}%
		</span>
	</div>

	<!-- Stats + Legend (top-right) -->
	<div class="absolute top-3 right-3 z-10 pointer-events-none">
		<div
			class="flex items-center gap-2.5 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm px-2.5 py-1.5 rounded-md border border-slate-200/60 dark:border-slate-700/60 shadow-sm text-3xs"
		>
			<span class="text-slate-400 dark:text-slate-500">
				{metadata.tables.length} tables · {metadata.relationships.length} FK relations
			</span>
			<span class="w-px h-3 bg-slate-200 dark:bg-slate-700"></span>
			<span class="font-mono font-bold text-amber-500">PK</span>
			<span class="text-slate-400 dark:text-slate-500">Primary</span>
			<span class="font-mono font-bold text-violet-500">FK</span>
			<span class="text-slate-400 dark:text-slate-500">Foreign</span>
			<span class="w-px h-3 bg-slate-200 dark:bg-slate-700"></span>
			<span class="text-slate-400 dark:text-slate-500">Click table → Browse Data</span>
		</div>
	</div>
</div>

<style>
	/* CSS custom properties for dark/light theming in SVG */
	:root {
		--erd-bg: #f8fafc;
		--erd-node-bg: #ffffff;
		--erd-node-bg-hi: #faf5ff;
		--erd-header-bg: #f1f5f9;
		--erd-header-bg-hi: #ede9fe;
		--erd-header-text: #1e293b;
		--erd-header-text-hi: #4c1d95;
		--erd-border: #e2e8f0;
		--erd-border-hi: #7c3aed;
		--erd-divider: #e2e8f0;
		--erd-col-name: #475569;
		--erd-col-type: #94a3b8;
		--erd-pk: #d97706;
		--erd-fk: #7c3aed;
		--erd-edge: #94a3b8;
		--erd-edge-hi: #7c3aed;
		--erd-row-hover: #f5f3ff;
	}

	:global(.dark) {
		--erd-bg: #020617;
		--erd-node-bg: #0f172a;
		--erd-node-bg-hi: #1a0a33;
		--erd-header-bg: #1e293b;
		--erd-header-bg-hi: #2e1065;
		--erd-header-text: #f1f5f9;
		--erd-header-text-hi: #ddd6fe;
		--erd-border: #1e293b;
		--erd-border-hi: #7c3aed;
		--erd-divider: #1e293b;
		--erd-col-name: #94a3b8;
		--erd-col-type: #475569;
		--erd-pk: #fbbf24;
		--erd-fk: #a78bfa;
		--erd-edge: #334155;
		--erd-edge-hi: #7c3aed;
		--erd-row-hover: #1e1033;
	}
</style>

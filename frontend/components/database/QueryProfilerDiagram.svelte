<script lang="ts">
	import type { DBQueryResult } from '$shared/types/db-manager';

	interface Props {
		result: DBQueryResult;
		dbType: 'postgresql' | 'sqlite' | 'mysql';
	}

	const { result, dbType }: Props = $props();

	// ── Node dimensions & layout constants ────────────────────────────────────────

	const NW = 168; // node width
	const NH = 64; // node height
	const HG = 28; // horizontal gap between subtrees
	const VG = 80; // vertical gap between levels
	const PAD = 48; // viewport padding

	// ── Types ─────────────────────────────────────────────────────────────────────

	interface PNode {
		id: string;
		type: string;
		table?: string;
		index?: string;
		startupCost: number;
		totalCost: number;
		estimatedRows: number;
		actualTimeMs?: number;
		actualRows?: number;
		loops?: number;
		needsIndex: boolean;
		children: PNode[];
		// layout (mutated by calcLayout)
		x: number;
		y: number;
		sw: number; // subtree width
	}

	// ── PostgreSQL parser ─────────────────────────────────────────────────────────

	function parsePostgres(rows: Record<string, unknown>[]): PNode | null {
		const lines = rows.map((r) => String(r['QUERY PLAN'] ?? ''));
		const stack: Array<{ ap: number; node: PNode }> = [];
		let root: PNode | null = null;

		for (const line of lines) {
			if (!line.includes('cost=')) continue;

			const arrowIdx = line.indexOf('->');
			const content = arrowIdx >= 0 ? line.slice(arrowIdx + 3).trim() : line.trim();

			// Match: NodeType (cost=s..t rows=r width=w) [(actual time=s..t rows=r loops=l)]
			const m = content.match(
				/^(.+?)\s+\(cost=([\d.]+)\.\.([\d.]+)\s+rows=(\d+)\s+width=\d+\)(?:\s+\(actual time=[\d.]+\.\.([\d.]+)\s+rows=(\d+)\s+loops=(\d+)\))?/
			);
			if (!m) continue;

			const { type, table, index } = extractNodeMeta(m[1].trim());
			const node: PNode = {
				id: Math.random().toString(36).slice(2),
				type,
				table,
				index,
				startupCost: parseFloat(m[2]),
				totalCost: parseFloat(m[3]),
				estimatedRows: parseInt(m[4]),
				actualTimeMs: m[5] ? parseFloat(m[5]) : undefined,
				actualRows: m[6] ? parseInt(m[6]) : undefined,
				loops: m[7] ? parseInt(m[7]) : undefined,
				needsIndex: false,
				children: [],
				x: 0,
				y: 0,
				sw: 0
			};
			node.needsIndex = needsIndexHint(node);

			// Arrow position determines depth: root=-1, children by col of '-'
			const ap = arrowIdx < 0 ? -1 : arrowIdx;
			while (stack.length > 0 && stack[stack.length - 1].ap >= ap) stack.pop();

			if (stack.length === 0) {
				root = node;
			} else {
				stack[stack.length - 1].node.children.push(node);
			}
			stack.push({ ap, node });
		}
		return root;
	}

	// ── SQLite parser ─────────────────────────────────────────────────────────────

	function parseSqlite(rows: Record<string, unknown>[]): PNode | null {
		const byId = new Map<number, PNode>();

		for (const row of rows) {
			const id = Number(row.id ?? 0);
			const detail = String(row.detail ?? '');
			const { type, table, index } = parseSqliteDetail(detail);
			const node: PNode = {
				id: String(id),
				type,
				table,
				index,
				startupCost: 0,
				totalCost: sqliteCost(type),
				estimatedRows: 0,
				needsIndex: false,
				children: [],
				x: 0,
				y: 0,
				sw: 0
			};
			node.needsIndex = needsIndexHint(node);
			byId.set(id, node);
		}

		let root: PNode | null = null;
		for (const row of rows) {
			const id = Number(row.id ?? 0);
			const parent = Number(row.parent ?? 0);
			const node = byId.get(id);
			if (!node) continue;
			if (parent === 0) root = node;
			else byId.get(parent)?.children.push(node);
		}
		return root;
	}

	// ── MySQL / MariaDB parser ────────────────────────────────────────────────────

	function parseMysql(rows: Record<string, unknown>[]): PNode | null {
		if (!rows.length) return null;

		const nodes: PNode[] = rows.map((row) => {
			const at = String(row.type ?? row.access_type ?? '');
			const table = String(row.table ?? row.TABLE_NAME ?? '');
			const key = row.key ? String(row.key) : undefined;
			const estRows = Number(row.rows ?? 0);
			const node: PNode = {
				id: Math.random().toString(36).slice(2),
				type: mysqlTypeLabel(at),
				table: table || undefined,
				index: key,
				startupCost: 0,
				totalCost: mysqlCost(at, estRows),
				estimatedRows: estRows,
				needsIndex: false,
				children: [],
				x: 0,
				y: 0,
				sw: 0
			};
			node.needsIndex = needsIndexHint(node);
			return node;
		});

		// Chain into a linear tree (execution order: first drives the last)
		for (let i = 0; i < nodes.length - 1; i++) {
			nodes[i].children = [nodes[i + 1]];
		}
		return nodes[0];
	}

	// ── Extraction helpers ────────────────────────────────────────────────────────

	function extractNodeMeta(text: string): { type: string; table?: string; index?: string } {
		let m: RegExpMatchArray | null;
		m = text.match(/^(Seq Scan)\s+on\s+(\S+)/i);
		if (m) return { type: m[1], table: m[2] };
		m = text.match(/^(Index(?:\s+Only)?\s+Scan)\s+using\s+(\S+)\s+on\s+(\S+)/i);
		if (m) return { type: m[1], index: m[2], table: m[3] };
		m = text.match(/^(Bitmap Heap Scan)\s+on\s+(\S+)/i);
		if (m) return { type: m[1], table: m[2] };
		m = text.match(/^(Bitmap Index Scan)\s+using\s+(\S+)/i);
		if (m) return { type: m[1], index: m[2] };
		m = text.match(/^(CTE Scan|Function Scan|Values Scan|Subquery Scan)\s+on\s+(\S+)/i);
		if (m) return { type: m[1], table: m[2] };
		m = text.match(/^(Parallel Seq Scan)\s+on\s+(\S+)/i);
		if (m) return { type: m[1], table: m[2] };
		// Generic: strip "on X" / "using Y" suffixes to get clean operation name
		const type = text.replace(/\s+on\s+\S+.*/i, '').replace(/\s+using\s+\S+.*/i, '').trim();
		return { type: type || text };
	}

	function parseSqliteDetail(detail: string): { type: string; table?: string; index?: string } {
		let m: RegExpMatchArray | null;
		m = detail.match(/^(SCAN TABLE|SCAN)\s+(\S+)/i);
		if (m) return { type: m[1], table: m[2] };
		m = detail.match(/^(SEARCH TABLE)\s+(\S+)\s+USING\s+(?:COVERING\s+)?INDEX\s+(\S+)/i);
		if (m) return { type: m[1], table: m[2], index: m[3] };
		m = detail.match(/^(SEARCH TABLE)\s+(\S+)/i);
		if (m) return { type: m[1], table: m[2] };
		m = detail.match(/^(USE TEMP B-TREE FOR [\w\s]+)/i);
		if (m) return { type: m[1].trim() };
		return { type: detail.length > 32 ? detail.slice(0, 30) + '…' : detail };
	}

	function mysqlTypeLabel(t: string): string {
		const MAP: Record<string, string> = {
			ALL: 'Full Scan',
			index: 'Index Scan',
			range: 'Range Scan',
			ref: 'Index Ref',
			eq_ref: 'Unique Ref',
			const: 'Const',
			system: 'System'
		};
		return MAP[t] ?? (t ? t.toUpperCase() : 'Unknown');
	}

	function sqliteCost(type: string): number {
		const u = type.toUpperCase();
		if (u.includes('SCAN TABLE') || u === 'SCAN') return 100;
		if (u.includes('SEARCH TABLE')) return 10;
		if (u.includes('B-TREE')) return 50;
		return 20;
	}

	function mysqlCost(at: string, rows: number): number {
		const W: Record<string, number> = {
			ALL: 1,
			index: 0.8,
			range: 0.3,
			ref: 0.1,
			eq_ref: 0.01,
			const: 0.001
		};
		return (W[at] ?? 0.5) * Math.max(rows, 1);
	}

	function needsIndexHint(node: PNode): boolean {
		const t = node.type.toLowerCase();
		const isFullScan =
			t.includes('seq scan') ||
			t.includes('full scan') ||
			t === 'scan' ||
			t.includes('scan table');
		if (!isFullScan) return false;
		// SQLite: estimatedRows is always 0 (no stats) — flag any full table scan
		if (node.estimatedRows === 0) return true;
		// PostgreSQL / MySQL: only flag when cost or row count is significant
		return node.totalCost > 100 || node.estimatedRows > 1000;
	}

	// ── Tree layout ───────────────────────────────────────────────────────────────

	function calcLayout(root: PNode): void {
		calcSW(root);
		place(root, root.sw / 2, 0);
	}

	function calcSW(n: PNode): number {
		if (!n.children.length) {
			n.sw = NW;
			return NW;
		}
		const sum =
			n.children.reduce((s, c) => s + calcSW(c), 0) + HG * (n.children.length - 1);
		n.sw = Math.max(NW, sum);
		return n.sw;
	}

	function place(n: PNode, cx: number, y: number): void {
		n.x = cx - NW / 2;
		n.y = y;
		if (!n.children.length) return;
		const total =
			n.children.reduce((s, c) => s + c.sw, 0) + HG * (n.children.length - 1);
		let lx = cx - total / 2;
		for (const c of n.children) {
			place(c, lx + c.sw / 2, y + NH + VG);
			lx += c.sw + HG;
		}
	}

	// ── Tree traversal ────────────────────────────────────────────────────────────

	function flatNodes(n: PNode, acc: PNode[] = []): PNode[] {
		acc.push(n);
		for (const c of n.children) flatNodes(c, acc);
		return acc;
	}

	function flatEdges(n: PNode, acc: [PNode, PNode][] = []): [PNode, PNode][] {
		for (const c of n.children) {
			acc.push([n, c]);
			flatEdges(c, acc);
		}
		return acc;
	}

	function maxCostOf(n: PNode): number {
		return Math.max(n.totalCost, ...n.children.map(maxCostOf));
	}

	// ── Colors ────────────────────────────────────────────────────────────────────

	/**
	 * Convert a PostgreSQL absolute cost value to a 0–1 color score.
	 * Uses meaningful thresholds so a cheap Seq Scan (cost 4) stays green
	 * rather than appearing red just because it's the only/max node.
	 *   < 50   → green   (tiny table, trivial scan)
	 *   50–500 → yellow  (moderate, worth watching)
	 *   500–5k → orange  (expensive, consider tuning)
	 *   > 5000 → red     (critical, needs index / rewrite)
	 */
	function pgAbsoluteCostScore(cost: number): number {
		if (cost < 50) return 0.10;
		if (cost < 500) return 0.38;
		if (cost < 5000) return 0.68;
		return 0.95;
	}

	// Returns [fill, border, textColor]
	function nodeColors(score: number): [string, string, string] {
		if (score < 0.25) return ['#dcfce7', '#22c55e', '#14532d'];
		if (score < 0.55) return ['#fef9c3', '#ca8a04', '#713f12'];
		if (score < 0.8) return ['#ffedd5', '#ea580c', '#7c2d12'];
		return ['#fee2e2', '#dc2626', '#7f1d1d'];
	}

	function nodeColorsDark(score: number): [string, string, string] {
		if (score < 0.25) return ['#14532d', '#22c55e', '#86efac'];
		if (score < 0.55) return ['#451a03', '#ca8a04', '#fde68a'];
		if (score < 0.8) return ['#431407', '#ea580c', '#fed7aa'];
		return ['#450a0a', '#dc2626', '#fca5a5'];
	}

	// ── SVG helpers ───────────────────────────────────────────────────────────────

	function edgePath(p: PNode, c: PNode): string {
		const px = p.x + NW / 2;
		const py = p.y + NH;
		const cx2 = c.x + NW / 2;
		const cy2 = c.y;
		const mid = (py + cy2) / 2;
		return `M${px},${py} C${px},${mid} ${cx2},${mid} ${cx2},${cy2}`;
	}

	function fmtCost(n: number): string {
		if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
		if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
		return n.toFixed(1);
	}

	function fmtTime(ms: number | undefined): string {
		if (ms === undefined) return '—';
		if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
		return `${ms.toFixed(3)}ms`;
	}

	function truncate(s: string, max: number): string {
		return s.length > max ? s.slice(0, max - 1) + '…' : s;
	}

	// ── Reactive state ────────────────────────────────────────────────────────────

	const tree = $derived.by((): PNode | null => {
		if (!result?.rows?.length || result.error) return null;
		const rows = result.rows as Record<string, unknown>[];
		let root: PNode | null = null;
		if (dbType === 'postgresql') root = parsePostgres(rows);
		else if (dbType === 'sqlite') root = parseSqlite(rows);
		else root = parseMysql(rows);
		if (!root) return null;
		calcLayout(root);
		return root;
	});

	const nodes = $derived(tree ? flatNodes(tree) : []);
	const edges = $derived(tree ? flatEdges(tree) : []);
	const maxC = $derived(tree ? maxCostOf(tree) : 0);
	const indexWarnings = $derived(nodes.filter((n) => n.needsIndex));

	// Compute the SVG viewBox string from node positions
	const vbStr = $derived.by(() => {
		if (!nodes.length) return '0 0 400 200';
		const xs = nodes.map((n) => n.x);
		const ys = nodes.map((n) => n.y);
		const x0 = Math.min(...xs) - PAD;
		const y0 = Math.min(...ys) - PAD;
		const w = Math.max(...xs) + NW + PAD - x0;
		const h = Math.max(...ys) + NH + PAD - y0;
		return `${x0} ${y0} ${w} ${h}`;
	});

	// ── Pan / Zoom ────────────────────────────────────────────────────────────────

	let svgEl: SVGSVGElement | undefined = $state();
	let vb = $state({ x: 0, y: 0, w: 800, h: 500 });
	let dragging = $state(false);
	let dragStart = { mx: 0, my: 0, vx: 0, vy: 0 };

	// Re-fit the view whenever the tree changes
	$effect(() => {
		const parts = vbStr.split(' ').map(Number);
		vb = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
	});

	// Attach non-passive wheel listener so we can call preventDefault()
	$effect(() => {
		const el = svgEl;
		if (!el) return;
		function onWheel(e: WheelEvent) {
			e.preventDefault();
			const rect = el!.getBoundingClientRect();
			const mx = (e.clientX - rect.left) / rect.width;
			const my = (e.clientY - rect.top) / rect.height;
			const factor = e.deltaY > 0 ? 1.12 : 0.89;
			const nw = vb.w * factor;
			const nh = vb.h * factor;
			vb = { x: vb.x + (vb.w - nw) * mx, y: vb.y + (vb.h - nh) * my, w: nw, h: nh };
		}
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	function onMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;
		dragging = true;
		dragStart = { mx: e.clientX, my: e.clientY, vx: vb.x, vy: vb.y };
	}

	function onMouseMove(e: MouseEvent) {
		if (!dragging || !svgEl) return;
		const rect = svgEl.getBoundingClientRect();
		const dx = ((e.clientX - dragStart.mx) / rect.width) * vb.w;
		const dy = ((e.clientY - dragStart.my) / rect.height) * vb.h;
		vb = { ...vb, x: dragStart.vx - dx, y: dragStart.vy - dy };
	}

	function onMouseUp() {
		dragging = false;
	}

	function resetView() {
		const parts = vbStr.split(' ').map(Number);
		vb = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
	}

	// ── Tooltip ───────────────────────────────────────────────────────────────────

	let hovered: PNode | null = $state(null);
	let tipX = $state(0);
	let tipY = $state(0);

	function onNodeEnter(e: MouseEvent, node: PNode) {
		hovered = node;
		tipX = e.clientX + 14;
		tipY = e.clientY - 10;
	}

	function onNodeMove(e: MouseEvent) {
		if (hovered) {
			tipX = e.clientX + 14;
			tipY = e.clientY - 10;
		}
	}

	function onNodeLeave() {
		hovered = null;
	}

	// ── Dark mode ─────────────────────────────────────────────────────────────────

	let dark = $state(false);
	$effect(() => {
		dark = document.documentElement.classList.contains('dark');
		const obs = new MutationObserver(() => {
			dark = document.documentElement.classList.contains('dark');
		});
		obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
		return () => obs.disconnect();
	});

	function getColors(ratio: number) {
		return dark ? nodeColorsDark(ratio) : nodeColors(ratio);
	}

	function borderColor(ratio: number): string {
		return getColors(ratio)[1];
	}

	// Operation type → short icon label
	function nodeEmoji(type: string): string {
		const t = type.toLowerCase();
		if (t.includes('seq scan') || t.includes('full scan') || t.includes('scan table')) return '⚠';
		if (t.includes('index') && t.includes('scan')) return '⌕';
		if (t.includes('hash join') || t.includes('merge join') || t.includes('nested loop')) return '⊕';
		if (t.includes('sort')) return '⇅';
		if (t.includes('aggregate') || t.includes('group')) return 'Σ';
		if (t.includes('gather')) return '⊞';
		if (t.includes('limit')) return '◫';
		if (t.includes('append') || t.includes('union')) return '⊌';
		return '▸';
	}
</script>

<div class="relative w-full h-full select-none overflow-hidden">
	{#if !tree}
		<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-400 text-xs">
			<svg class="w-5 h-5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M9 17v-2m3 2v-4m3 4v-6M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
				/>
			</svg>
			<span>Unable to parse execution plan for visual profiling</span>
		</div>
	{:else}
		<!-- Index warning banner -->
		{#if indexWarnings.length > 0}
			<div
				class="absolute top-2 left-2 right-10 z-10 flex items-start gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg text-xs text-amber-700 dark:text-amber-300 shadow-sm"
			>
				<svg
					class="w-3.5 h-3.5 shrink-0 mt-0.5"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.96-.833-2.732 0L3.072 16.5C2.302 18.333 3.263 20 4.802 20z"
					/>
				</svg>
				<span>
					<strong>{indexWarnings.length}</strong> full scan{indexWarnings.length > 1 ? 's' : ''} detected
					— consider adding indexes on:
					<strong>{indexWarnings.map((n) => n.table ?? n.type).join(', ')}</strong>
				</span>
			</div>
		{/if}

		<!-- Controls: reset view -->
		<button
			type="button"
			class="absolute top-2 right-2 z-10 px-2 py-1 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 shadow-sm transition-colors"
			onclick={resetView}
			title="Reset zoom and pan"
		>
			⊡ Fit
		</button>

		<!-- Legend -->
		<div
			class="absolute bottom-2 left-2 z-10 flex items-center gap-2 px-2.5 py-1 bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-700 rounded-lg text-xs text-slate-500 dark:text-slate-400 shadow-sm backdrop-blur-sm"
		>
			<span class="font-medium">Cost:</span>
			{#each [['#22c55e', 'Low'], ['#ca8a04', 'Med'], ['#ea580c', 'High'], ['#dc2626', 'Critical']] as [c, l]}
				<span class="flex items-center gap-1">
					<span class="w-2.5 h-2.5 rounded-sm border" style="background:{c};border-color:{c}"></span>
					{l}
				</span>
			{/each}
			<span class="text-slate-300 dark:text-slate-600">·</span>
			<span class="flex items-center gap-1">
				<span
					class="w-2.5 h-2.5 rounded-sm border border-amber-500 bg-amber-100 dark:bg-amber-900/50"
				></span>
				Needs Index
			</span>
		</div>

		<!-- Hint -->
		<div
			class="absolute bottom-2 right-2 z-10 text-xs text-slate-400 dark:text-slate-600 pointer-events-none"
		>
			Scroll to zoom · Drag to pan
		</div>

		<!-- SVG diagram -->
		<svg
			bind:this={svgEl}
			class="w-full h-full block"
			style="cursor: {dragging ? 'grabbing' : 'grab'}"
			viewBox="{vb.x} {vb.y} {vb.w} {vb.h}"
			onmousedown={onMouseDown}
			onmousemove={onMouseMove}
			onmouseup={onMouseUp}
			onmouseleave={onMouseUp}
		>
			<!-- Edges -->
			{#each edges as [p, c]}
				<path
					d={edgePath(p, c)}
					fill="none"
					stroke={dark ? '#334155' : '#cbd5e1'}
					stroke-width="1.5"
					stroke-linecap="round"
				/>
			{/each}

			<!-- Nodes -->
			{#each nodes as node}
				{@const barRatio = maxC > 0 ? Math.min(node.totalCost / maxC, 1) : 0}
				{@const colorScore = dbType === 'postgresql' ? pgAbsoluteCostScore(node.totalCost) : barRatio}
				{@const [fill, border, textCol] = getColors(colorScore)}
				{@const cx = node.x + NW / 2}
				{@const label = truncate(node.type, 22)}
				{@const sub =
					node.table || node.index
						? truncate((node.table ?? '') + (node.index ? ` [${node.index}]` : ''), 24)
						: null}

				<g
					onmouseenter={(e) => onNodeEnter(e, node)}
					onmousemove={onNodeMove}
					onmouseleave={onNodeLeave}
					style="cursor: default; pointer-events: all"
				>
					<!-- Drop shadow -->
					<rect
						x={node.x + 2}
						y={node.y + 3}
						width={NW}
						height={NH}
						rx="8"
						fill={dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.07)'}
					/>
					<!-- Node background -->
					<rect
						x={node.x}
						y={node.y}
						width={NW}
						height={NH}
						rx="8"
						fill={fill}
						stroke={border}
						stroke-width="1.5"
					/>

					<!-- "Needs Index" accent stripe on left edge -->
					{#if node.needsIndex}
						<rect
							x={node.x}
							y={node.y}
							width="4"
							height={NH}
							rx="2"
							fill="#f97316"
						/>
					{/if}

					<!-- Icon + type -->
					<text
						x={cx}
						y={node.y + 18}
						text-anchor="middle"
						font-size="10"
						font-weight="700"
						font-family="ui-monospace, SFMono-Regular, monospace"
						fill={textCol}
					>{nodeEmoji(node.type)} {label}</text>

					<!-- Table / index label -->
					{#if sub}
						<text
							x={cx}
							y={node.y + 32}
							text-anchor="middle"
							font-size="9"
							font-family="ui-monospace, SFMono-Regular, monospace"
							fill={textCol}
							opacity="0.75"
						>{sub}</text>
					{/if}

					<!-- Cost + time label at bottom -->
					<text
						x={cx}
						y={node.y + NH - 10}
						text-anchor="middle"
						font-size="9"
						font-family="ui-sans-serif, system-ui, sans-serif"
						fill={textCol}
						opacity="0.8"
					>
						cost {fmtCost(node.totalCost)}{node.actualTimeMs !== undefined
							? ` · ${fmtTime(node.actualTimeMs)}`
							: ''}{node.estimatedRows > 0
							? ` · ${node.estimatedRows >= 1000 ? fmtCost(node.estimatedRows) : node.estimatedRows} rows`
							: ''}
					</text>

					<!-- "INDEX?" badge -->
					{#if node.needsIndex}
						<rect
							x={node.x + NW - 44}
							y={node.y - 9}
							width={42}
							height={15}
							rx="7"
							fill="#f97316"
						/>
						<text
							x={node.x + NW - 23}
							y={node.y + 3}
							text-anchor="middle"
							font-size="8"
							font-weight="700"
							font-family="ui-sans-serif, system-ui, sans-serif"
							fill="white"
						>INDEX?</text>
					{/if}

					<!-- Cost bar at bottom of node -->
					<rect
						x={node.x + 8}
						y={node.y + NH - 5}
						width={NW - 16}
						height="3"
						rx="1.5"
						fill={dark ? '#1e293b' : '#e2e8f0'}
					/>
					<rect
						x={node.x + 8}
						y={node.y + NH - 5}
						width={(NW - 16) * barRatio}
						height="3"
						rx="1.5"
						fill={borderColor(colorScore)}
						opacity="0.7"
					/>
				</g>
			{/each}
		</svg>

		<!-- Tooltip -->
		{#if hovered}
			<div
				class="fixed z-50 min-w-44 max-w-64 p-2.5 bg-slate-900 dark:bg-slate-800 border border-slate-700 text-slate-100 text-xs rounded-xl shadow-2xl pointer-events-none"
				style="left: {tipX}px; top: {tipY}px"
			>
				<div class="font-bold text-slate-50 mb-1.5">
					{nodeEmoji(hovered.type)}
					{hovered.type}
				</div>
				{#if hovered.table}
					<div class="flex justify-between gap-3">
						<span class="text-slate-400">Table</span>
						<span class="font-mono text-emerald-300">{hovered.table}</span>
					</div>
				{/if}
				{#if hovered.index}
					<div class="flex justify-between gap-3">
						<span class="text-slate-400">Index</span>
						<span class="font-mono text-sky-300">{hovered.index}</span>
					</div>
				{/if}
				<div class="flex justify-between gap-3">
					<span class="text-slate-400">Startup cost</span>
					<span>{fmtCost(hovered.startupCost)}</span>
				</div>
				<div class="flex justify-between gap-3">
					<span class="text-slate-400">Total cost</span>
					<span class="text-amber-300 font-medium">{fmtCost(hovered.totalCost)}</span>
				</div>
				{#if hovered.estimatedRows > 0}
					<div class="flex justify-between gap-3">
						<span class="text-slate-400">Est. rows</span>
						<span>{hovered.estimatedRows.toLocaleString()}</span>
					</div>
				{/if}
				{#if hovered.actualTimeMs !== undefined}
					<div class="mt-1 pt-1 border-t border-slate-700">
						<div class="flex justify-between gap-3">
							<span class="text-slate-400">Actual time</span>
							<span class="text-emerald-400 font-medium">{fmtTime(hovered.actualTimeMs)}</span>
						</div>
						{#if hovered.actualRows !== undefined}
							<div class="flex justify-between gap-3">
								<span class="text-slate-400">Actual rows</span>
								<span>{hovered.actualRows.toLocaleString()}</span>
							</div>
						{/if}
						{#if hovered.loops && hovered.loops > 1}
							<div class="flex justify-between gap-3">
								<span class="text-slate-400">Loops</span>
								<span>{hovered.loops}×</span>
							</div>
						{/if}
					</div>
				{/if}
				{#if hovered.needsIndex}
					<div class="mt-1.5 pt-1.5 border-t border-slate-700 text-amber-400 font-medium">
						⚠ Consider adding an index on this table
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>

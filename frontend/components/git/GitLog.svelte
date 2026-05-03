<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { GitCommit } from '$shared/types/git';

	interface Props {
		commits: GitCommit[];
		isLoading: boolean;
		hasMore: boolean;
		activeHash?: string | null;
		onLoadMore: () => void;
		onViewCommit: (hash: string) => void;
	}

	const { commits, isLoading, hasMore, activeHash = null, onLoadMore, onViewCommit }: Props = $props();

	let selectedHash = $state('');
	const effectiveActiveHash = $derived(activeHash ?? selectedHash);
	let sentinelEl = $state<HTMLDivElement | null>(null);

	// Infinite scroll: auto load more when sentinel is visible
	$effect(() => {
		const el = sentinelEl;
		if (!el || !hasMore) return;

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && hasMore && !isLoading) {
					onLoadMore();
				}
			},
			{ rootMargin: '100px' }
		);

		observer.observe(el);
		return () => observer.disconnect();
	});

	// ========================
	// Git Graph Computation
	// ========================

	interface GraphRow {
		col: number;
		nodeColor: string;
		lanes: Array<{ col: number; color: string }>;
		mergeFrom: Array<{ col: number; color: string }>;
		branchTo: Array<{ col: number; color: string }>;
		branchToCols: Set<number>;
		prevLaneCols: Set<number>;
		nextLaneCols: Set<number>;
		nodeHasTop: boolean;
		nodeHasBottom: boolean;
		/** Max column index used in this row (for per-row graph width) */
		maxCol: number;
	}

	const LANE_COLORS = [
		'#8b5cf6', '#3b82f6', '#10b981', '#f59e0b',
		'#f43f5e', '#06b6d4', '#f97316', '#ec4899'
	];

	const graphRows = $derived(computeGraph(commits));

	function computeGraph(commits: GitCommit[]): GraphRow[] {
		if (commits.length === 0) return [];

		const lanes: (string | null)[] = [];
		const laneColorMap = new Map<number, string>();
		let colorIdx = 0;
		const rows: GraphRow[] = [];
		const processedSet = new Set<string>();

		function getColor(col: number): string {
			if (!laneColorMap.has(col)) {
				laneColorMap.set(col, LANE_COLORS[colorIdx % LANE_COLORS.length]);
				colorIdx++;
			}
			return laneColorMap.get(col)!;
		}

		function getActiveCols(): Set<number> {
			const s = new Set<number>();
			for (let i = 0; i < lanes.length; i++) {
				if (lanes[i] !== null) s.add(i);
			}
			return s;
		}

		let prevActiveCols = new Set<number>();

		for (const commit of commits) {
			const myLanes: number[] = [];
			for (let i = 0; i < lanes.length; i++) {
				if (lanes[i] === commit.hash) myLanes.push(i);
			}

			let col: number;
			const mergeFrom: Array<{ col: number; color: string }> = [];
			const mergeFromCols = new Set<number>();

			if (myLanes.length > 0) {
				col = myLanes[0];
				for (let i = 1; i < myLanes.length; i++) {
					mergeFrom.push({ col: myLanes[i], color: getColor(myLanes[i]) });
					mergeFromCols.add(myLanes[i]);
					lanes[myLanes[i]] = null;
				}
			} else {
				const empty = lanes.indexOf(null);
				col = empty >= 0 ? empty : lanes.length;
				if (col >= lanes.length) lanes.push(null);
			}

			getColor(col);
			const nodeHasTop = prevActiveCols.has(col);

			const currentPrevCols = new Set(prevActiveCols);

			const branchTo: Array<{ col: number; color: string }> = [];
			const branchToCols = new Set<number>();
			if (commit.parents.length > 0) {
				// First parent: skip if already processed (non-topo edge case)
				if (processedSet.has(commit.parents[0])) {
					lanes[col] = null;
				} else {
					lanes[col] = commit.parents[0];
				}

				for (let p = 1; p < commit.parents.length; p++) {
					// Skip parents that were already processed
					if (processedSet.has(commit.parents[p])) continue;

					const existingIdx = lanes.indexOf(commit.parents[p]);
					if (existingIdx >= 0 && existingIdx !== col) {
						branchTo.push({ col: existingIdx, color: getColor(existingIdx) });
						branchToCols.add(existingIdx);
					} else {
						let newCol = -1;
						for (let i = 0; i < lanes.length; i++) {
							if (lanes[i] === null && i !== col) { newCol = i; break; }
						}
						if (newCol < 0) {
							newCol = lanes.length;
							lanes.push(null);
						}
						lanes[newCol] = commit.parents[p];
						branchTo.push({ col: newCol, color: getColor(newCol) });
						branchToCols.add(newCol);
					}
				}
			} else {
				lanes[col] = null;
			}

			const activeLanes: Array<{ col: number; color: string }> = [];
			for (let i = 0; i < lanes.length; i++) {
				if (lanes[i] !== null) {
					activeLanes.push({ col: i, color: getColor(i) });
				}
			}

			const nextActiveCols = getActiveCols();

			// Calculate max column used in this row
			let rowMaxCol = col;
			for (const lane of activeLanes) rowMaxCol = Math.max(rowMaxCol, lane.col);
			for (const m of mergeFrom) rowMaxCol = Math.max(rowMaxCol, m.col);
			for (const b of branchTo) rowMaxCol = Math.max(rowMaxCol, b.col);

			rows.push({
				col,
				nodeColor: getColor(col),
				lanes: activeLanes,
				mergeFrom,
				branchTo,
				branchToCols,
				prevLaneCols: currentPrevCols,
				nextLaneCols: nextActiveCols,
				nodeHasTop,
				nodeHasBottom: nextActiveCols.has(col),
				maxCol: rowMaxCol
			});

			processedSet.add(commit.hash);
			prevActiveCols = nextActiveCols;

			while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
				lanes.pop();
			}
		}

		return rows;
	}

	// ========================
	// Helpers
	// ========================

	const LANE_WIDTH = 10;
	const ROW_HEIGHT = 48;
	const NODE_R = 3;
	const GRAPH_PAD = 3;
	const LINE_W = '1.5';
	const MAX_VISIBLE_REFS = 3;
	const MAX_REF_LENGTH = 22;

	function truncateRef(ref: string): string {
		if (ref.length <= MAX_REF_LENGTH) return ref;
		return ref.substring(0, MAX_REF_LENGTH - 1) + '\u2026';
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const hours = Math.floor(diff / (1000 * 60 * 60));
		const days = Math.floor(hours / 24);

		if (hours < 1) return 'just now';
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		if (days < 30) return `${Math.floor(days / 7)}w ago`;
		return date.toLocaleDateString();
	}

	function handleViewCommit(hash: string) {
		selectedHash = hash;
		onViewCommit(hash);
	}

	async function copyCommitHash(hash: string, e: MouseEvent) {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(hash);
			addNotification({ type: 'success', title: 'Copied', message: `Commit ${hash.substring(0, 7)} copied to clipboard`, duration: 2000 });
		} catch {
			addNotification({ type: 'error', title: 'Failed', message: 'Could not copy to clipboard', duration: 3000 });
		}
	}
</script>

<div class="flex-1 min-h-0 flex flex-col">
	{#if isLoading && commits.length === 0}
		<div class="flex-1 flex items-center justify-center">
			<div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
		</div>
	{:else if commits.length === 0}
		<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500 text-xs">
			<Icon name="lucide:git-commit-horizontal" class="w-8 h-8 opacity-30" />
			<span>No commits yet</span>
		</div>
	{:else}
		<div class="flex-1 overflow-y-auto overflow-x-hidden pt-2">
			{#each commits as commit, idx (commit.hash)}
				{@const graph = graphRows[idx]}
				{@const graphWidth = (graph ? graph.maxCol + 1 : 1) * LANE_WIDTH + GRAPH_PAD * 2}
				<div
					class="group flex items-stretch w-full text-left cursor-pointer transition-colors
						{effectiveActiveHash === commit.hash
							? 'bg-violet-500/10 dark:bg-violet-500/15 text-slate-900 dark:text-slate-100'
							: 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}"
					style="height: {ROW_HEIGHT}px;"
					role="button"
					tabindex="0"
					onclick={() => handleViewCommit(commit.hash)}
					onkeydown={(e) => e.key === 'Enter' && handleViewCommit(commit.hash)}
				>
					<!-- Git Graph Column -->
					{#if graph}
						<div class="shrink-0 relative" style="width: {graphWidth}px;">
							<svg class="absolute inset-0 w-full h-full">
								<!-- Vertical lines for pass-through lanes (skip node col and branchTo cols) -->
								{#each graph.lanes as lane}
									{#if lane.col !== graph.col && !graph.branchToCols.has(lane.col)}
										{@const lx = lane.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD}
										{@const hasTop = graph.prevLaneCols.has(lane.col)}
										<line
											x1={lx} y1={hasTop ? 0 : ROW_HEIGHT / 2}
											x2={lx} y2={ROW_HEIGHT}
											stroke={lane.color}
											stroke-width={LINE_W}
										/>
									{/if}
								{/each}

								<!-- Top-half lines for branchTo cols that existed in previous row (skip if also mergeFrom) -->
								{#each graph.branchTo as branch}
									{#if graph.prevLaneCols.has(branch.col) && !graph.mergeFrom.some(m => m.col === branch.col)}
										{@const bx = branch.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD}
										<line
											x1={bx} y1={0}
											x2={bx} y2={ROW_HEIGHT / 2}
											stroke={branch.color}
											stroke-width={LINE_W}
										/>
									{/if}
								{/each}

								<!-- Merge curves (from other lanes into this node) -->
								{#each graph.mergeFrom as merge}
									{@const mx = merge.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD}
									{@const nx = graph.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD}
									<path
										d="M {mx} 0 C {mx} {ROW_HEIGHT * 0.4}, {nx} {ROW_HEIGHT * 0.3}, {nx} {ROW_HEIGHT / 2}"
										fill="none"
										stroke={merge.color}
										stroke-width={LINE_W}
									/>
								{/each}

								<!-- Branch curves (from this node to new lanes) -->
								{#each graph.branchTo as branch}
									{@const bx = branch.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD}
									{@const nx = graph.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD}
									<path
										d="M {nx} {ROW_HEIGHT / 2} C {nx} {ROW_HEIGHT * 0.7}, {bx} {ROW_HEIGHT * 0.6}, {bx} {ROW_HEIGHT}"
										fill="none"
										stroke={branch.color}
										stroke-width={LINE_W}
									/>
								{/each}

								<!-- Main vertical line through this node's lane -->
								<line
									x1={graph.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD} y1={graph.nodeHasTop ? 0 : ROW_HEIGHT / 2}
									x2={graph.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD} y2={graph.nodeHasBottom ? ROW_HEIGHT : ROW_HEIGHT / 2}
									stroke={graph.nodeColor}
									stroke-width={LINE_W}
								/>

								<!-- Node circle -->
								<circle
									cx={graph.col * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD}
									cy={ROW_HEIGHT / 2}
									r={NODE_R}
									fill={graph.nodeColor}
									stroke="white"
									stroke-width="1.5"
								/>
							</svg>
						</div>
					{/if}

					<!-- Commit info (3-line layout) -->
					<div class="flex-1 min-w-0 px-1.5 py-0.5 flex flex-col justify-center overflow-hidden">
						<!-- Line 1: Message + Date -->
						<div class="flex items-center gap-2">
							<p class="flex-1 min-w-0 text-sm text-slate-900 dark:text-slate-100 leading-tight truncate" title={commit.message}>
								{commit.message}
							</p>
							<span class="text-3xs text-slate-400 shrink-0">{formatDate(commit.date)}</span>
						</div>

						<!-- Line 2: Hash + Author -->
						<div class="flex items-center gap-1.5 mt-px">
							<button
								type="button"
								class="text-xs font-mono text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 bg-transparent border-none cursor-pointer p-0 shrink-0 transition-colors"
								onclick={(e) => copyCommitHash(commit.hash, e)}
								title="Copy commit hash"
							>
								{commit.hashShort}
							</button>
							<span class="text-xs text-slate-500 truncate">{commit.author}</span>
						</div>

						<!-- Line 3: Refs -->
						{#if commit.refs && commit.refs.length > 0}
							<div class="flex items-center gap-1 mt-px overflow-hidden">
								{#each commit.refs.slice(0, MAX_VISIBLE_REFS) as ref}
									<span
										class="text-3xs px-1 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 shrink-0 truncate max-w-28"
										title={ref}
									>
										{truncateRef(ref)}
									</span>
								{/each}
								{#if commit.refs.length > MAX_VISIBLE_REFS}
									<span
										class="text-3xs px-1 py-px rounded bg-slate-500/10 text-slate-500 shrink-0 cursor-default"
										title={commit.refs.slice(MAX_VISIBLE_REFS).join(', ')}
									>
										+{commit.refs.length - MAX_VISIBLE_REFS}
									</span>
								{/if}
							</div>
						{/if}
					</div>
				</div>
			{/each}

			<!-- Infinite scroll sentinel -->
			{#if hasMore}
				<div bind:this={sentinelEl} class="flex justify-center py-3">
					{#if isLoading}
						<div class="w-4 h-4 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

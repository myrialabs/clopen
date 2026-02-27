<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import type { GitCommit } from '$shared/types/git';

	interface Props {
		commits: GitCommit[];
		isLoading: boolean;
		hasMore: boolean;
		onLoadMore: () => void;
		onViewCommit: (hash: string) => void;
	}

	const { commits, isLoading, hasMore, onLoadMore, onViewCommit }: Props = $props();

	let selectedHash = $state('');

	// ========================
	// Git Graph Computation
	// ========================

	interface GraphRow {
		col: number;
		nodeColor: string;
		lanes: Array<{ col: number; color: string }>;
		mergeFrom: Array<{ col: number; color: string }>;
		branchTo: Array<{ col: number; color: string }>;
		/** Which lane columns existed in the previous row (for drawing top half of lines) */
		prevLaneCols: Set<number>;
		/** Which lane columns will exist in the next row (for drawing bottom half of lines) */
		nextLaneCols: Set<number>;
		/** Whether this node's lane existed in the previous row */
		nodeHasTop: boolean;
		/** Whether this node's lane continues to the next row */
		nodeHasBottom: boolean;
	}

	const LANE_COLORS = [
		'#8b5cf6', '#3b82f6', '#10b981', '#f59e0b',
		'#f43f5e', '#06b6d4', '#f97316', '#ec4899'
	];

	const graphRows = $derived(computeGraph(commits));
	const maxCols = $derived(graphRows.reduce((max, row) => {
		const cols = [row.col, ...row.lanes.map(l => l.col), ...row.mergeFrom.map(m => m.col), ...row.branchTo.map(b => b.col)];
		return Math.max(max, ...cols);
	}, 0) + 1);

	function computeGraph(commits: GitCommit[]): GraphRow[] {
		if (commits.length === 0) return [];

		const lanes: (string | null)[] = [];
		const laneColorMap = new Map<number, string>();
		let colorIdx = 0;
		const rows: GraphRow[] = [];

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

		// Track previous row's active lane columns
		let prevActiveCols = new Set<number>();

		for (const commit of commits) {
			const myLanes: number[] = [];
			for (let i = 0; i < lanes.length; i++) {
				if (lanes[i] === commit.hash) myLanes.push(i);
			}

			let col: number;
			const mergeFrom: Array<{ col: number; color: string }> = [];

			if (myLanes.length > 0) {
				col = myLanes[0];
				for (let i = 1; i < myLanes.length; i++) {
					mergeFrom.push({ col: myLanes[i], color: getColor(myLanes[i]) });
					lanes[myLanes[i]] = null;
				}
			} else {
				const empty = lanes.indexOf(null);
				col = empty >= 0 ? empty : lanes.length;
				if (col >= lanes.length) lanes.push(null);
			}

			getColor(col);
			const nodeHasTop = prevActiveCols.has(col);

			// Snapshot current active lanes (before parent assignment)
			const currentPrevCols = new Set(prevActiveCols);

			const branchTo: Array<{ col: number; color: string }> = [];
			if (commit.parents.length > 0) {
				lanes[col] = commit.parents[0];

				for (let p = 1; p < commit.parents.length; p++) {
					const existingIdx = lanes.indexOf(commit.parents[p]);
					if (existingIdx >= 0 && existingIdx !== col) {
						branchTo.push({ col: existingIdx, color: getColor(existingIdx) });
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

			rows.push({
				col,
				nodeColor: getColor(col),
				lanes: activeLanes,
				mergeFrom,
				branchTo,
				prevLaneCols: currentPrevCols,
				nextLaneCols: nextActiveCols,
				nodeHasTop,
				nodeHasBottom: nextActiveCols.has(col)
			});

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

	const LANE_WIDTH = 16;
	const ROW_HEIGHT = 40;
	const NODE_R = 4;

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

<div class="h-full flex flex-col">
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
		<div class="flex-1 overflow-y-auto">
			{#each commits as commit, idx (commit.hash)}
				{@const graph = graphRows[idx]}
				{@const graphWidth = Math.max(maxCols, 1) * LANE_WIDTH + 8}
				<div
					class="group flex items-stretch w-full text-left cursor-pointer transition-colors
						{selectedHash === commit.hash
							? 'bg-violet-50 dark:bg-violet-900/10'
							: 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}"
					role="button"
					tabindex="0"
					onclick={() => handleViewCommit(commit.hash)}
					onkeydown={(e) => e.key === 'Enter' && handleViewCommit(commit.hash)}
				>
					<!-- Git Graph Column -->
					{#if graph}
						<div class="shrink-0 relative" style="width: {graphWidth}px; min-height: {ROW_HEIGHT}px;">
							<svg class="absolute inset-0 w-full h-full" style="overflow: visible;">
								<!-- Vertical lines for active lanes (pass-through) -->
								{#each graph.lanes as lane}
									{@const lx = lane.col * LANE_WIDTH + LANE_WIDTH / 2 + 4}
									{@const hasTop = graph.prevLaneCols.has(lane.col)}
									{@const hasBottom = true}
									<line
										x1={lx} y1={hasTop ? 0 : ROW_HEIGHT / 2}
										x2={lx} y2={hasBottom ? ROW_HEIGHT : ROW_HEIGHT / 2}
										stroke={lane.color}
										stroke-width="2"
										opacity="0.4"
									/>
								{/each}

								<!-- Merge lines (from other lanes into this commit's node) -->
								{#each graph.mergeFrom as merge}
									{@const mx = merge.col * LANE_WIDTH + LANE_WIDTH / 2 + 4}
									{@const nx = graph.col * LANE_WIDTH + LANE_WIDTH / 2 + 4}
									<path
										d="M {mx} 0 C {mx} {ROW_HEIGHT * 0.4}, {nx} {ROW_HEIGHT * 0.3}, {nx} {ROW_HEIGHT / 2}"
										fill="none"
										stroke={merge.color}
										stroke-width="2"
										opacity="0.5"
									/>
								{/each}

								<!-- Branch lines (from this node to new lanes) -->
								{#each graph.branchTo as branch}
									{@const bx = branch.col * LANE_WIDTH + LANE_WIDTH / 2 + 4}
									{@const nx = graph.col * LANE_WIDTH + LANE_WIDTH / 2 + 4}
									<path
										d="M {nx} {ROW_HEIGHT / 2} C {nx} {ROW_HEIGHT * 0.7}, {bx} {ROW_HEIGHT * 0.6}, {bx} {ROW_HEIGHT}"
										fill="none"
										stroke={branch.color}
										stroke-width="2"
										opacity="0.5"
									/>
								{/each}

								<!-- Main vertical line through this node's lane -->
								<line
									x1={graph.col * LANE_WIDTH + LANE_WIDTH / 2 + 4} y1={graph.nodeHasTop ? 0 : ROW_HEIGHT / 2}
									x2={graph.col * LANE_WIDTH + LANE_WIDTH / 2 + 4} y2={graph.nodeHasBottom ? ROW_HEIGHT : ROW_HEIGHT / 2}
									stroke={graph.nodeColor}
									stroke-width="2"
									opacity="0.4"
								/>

								<!-- Node circle -->
								<circle
									cx={graph.col * LANE_WIDTH + LANE_WIDTH / 2 + 4}
									cy={ROW_HEIGHT / 2}
									r={commit.parents.length > 1 ? NODE_R + 1 : NODE_R}
									fill={graph.nodeColor}
									stroke="white"
									stroke-width="2"
								/>
								{#if commit.parents.length > 1}
									<circle
										cx={graph.col * LANE_WIDTH + LANE_WIDTH / 2 + 4}
										cy={ROW_HEIGHT / 2}
										r={NODE_R + 3}
										fill="none"
										stroke={graph.nodeColor}
										stroke-width="1.5"
										opacity="0.5"
									/>
								{/if}
							</svg>
						</div>
					{/if}

					<!-- Commit info -->
					<div class="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5">
						<div class="flex-1 min-w-0">
							<p class="text-sm text-slate-900 dark:text-slate-100 leading-snug truncate">
								{commit.message}
							</p>
							<div class="flex items-center gap-2 mt-0.5">
								<span class="text-xs font-mono text-violet-600 dark:text-violet-400">
									{commit.hashShort}
								</span>
								<span class="text-xs text-slate-500 truncate">{commit.author}</span>
								{#if commit.refs && commit.refs.length > 0}
									{#each commit.refs as ref}
										<span class="text-3xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 truncate shrink-0">
											{ref}
										</span>
									{/each}
								{/if}
							</div>
						</div>

						<!-- Actions -->
						<div class="items-center gap-0.5 shrink-0 hidden group-hover:flex">
							<button
								type="button"
								class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-600 transition-colors bg-transparent border-none cursor-pointer"
								onclick={(e) => copyCommitHash(commit.hash, e)}
								title="Copy full commit hash"
							>
								<Icon name="lucide:copy" class="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-violet-500/10 hover:text-violet-600 transition-colors bg-transparent border-none cursor-pointer"
								onclick={(e) => { e.stopPropagation(); copyCommitHash(commit.hashShort, e); }}
								title="Copy short hash"
							>
								<Icon name="lucide:hash" class="w-3.5 h-3.5" />
							</button>
						</div>

						<!-- Date -->
						<span class="text-xs text-slate-400 shrink-0">{formatDate(commit.date)}</span>
					</div>
				</div>
			{/each}

			<!-- Load more -->
			{#if hasMore}
				<div class="flex justify-center py-3">
					<button
						type="button"
						class="px-4 py-1.5 text-xs font-medium text-violet-600 bg-violet-500/10 rounded-md hover:bg-violet-500/20 transition-colors cursor-pointer border-none"
						onclick={onLoadMore}
						disabled={isLoading}
					>
						{isLoading ? 'Loading...' : 'Load More'}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { dbClientStore } from '$frontend/stores/features/db-client.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';

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

	let tables = $state<ErTable[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Table coordinates in world space: tableName -> { x, y }
	let positions = $state<Record<string, { x: number; y: number }>>({});

	const CARD_W = 220;
	const CARD_H = 180;
	const COL_GAP = 140;
	const ROW_GAP = 210;
	const MIN_ZOOM = 0.2;
	const MAX_ZOOM = 2.5;

	// Viewport transform.
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let viewportEl = $state<HTMLDivElement | null>(null);

	// Card drag vs. canvas pan — only one is active at a time.
	let activeDragTable: string | null = null;
	let dragStart = { x: 0, y: 0 };
	let tableStart = { x: 0, y: 0 };
	let isPanning = $state(false);
	let panStart = { x: 0, y: 0 };

	onMount(() => {
		const loadSchema = async () => {
			loading = true;
			error = null;
			try {
				const res = await dbClientStore.getErSchema(connectionId, { database, schema });
				const allTables = res.tables;

				// Keep the active table and its direct relations (both directions).
				const relatedTableNames = new Set<string>([tableName]);
				const activeTableData = allTables.find((t) => t.name === tableName);
				activeTableData?.foreignKeys.forEach((fk) => relatedTableNames.add(fk.refTable));
				allTables.forEach((t) => {
					t.foreignKeys.forEach((fk) => {
						if (fk.refTable === tableName) relatedTableNames.add(t.name);
					});
				});

				tables = allTables.filter((t) => relatedTableNames.has(t.name));

				// Layout: tables that reference the active one on the left, the active
				// one in the center, tables the active one references on the right.
				const leftTables: string[] = [];
				const rightTables: string[] = [];
				tables.forEach((t) => {
					if (t.name === tableName) return;
					const referencedByActive = activeTableData?.foreignKeys.some((fk) => fk.refTable === t.name);
					(referencedByActive ? rightTables : leftTables).push(t.name);
				});

				const colX = (col: number) => 40 + col * (CARD_W + COL_GAP);
				const stackTop = (count: number) => Math.max(40, ((Math.max(leftTables.length, rightTables.length) - count) * ROW_GAP) / 2 + 40);

				const posMap: Record<string, { x: number; y: number }> = {};
				leftTables.forEach((name, idx) => {
					posMap[name] = { x: colX(0), y: stackTop(leftTables.length) + idx * ROW_GAP };
				});
				const centerY = ((Math.max(leftTables.length, rightTables.length, 1) - 1) * ROW_GAP) / 2 + 40;
				posMap[tableName] = { x: colX(1), y: centerY };
				rightTables.forEach((name, idx) => {
					posMap[name] = { x: colX(2), y: stackTop(rightTables.length) + idx * ROW_GAP };
				});

				positions = posMap;
				await tick();
				fitView();
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			} finally {
				loading = false;
			}
		};
		loadSchema();
	});

	const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

	/** Frame all cards within the viewport. */
	function fitView(): void {
		if (!viewportEl || tables.length === 0) return;
		const pts = tables.map((t) => positions[t.name]).filter(Boolean);
		if (pts.length === 0) return;
		const minX = Math.min(...pts.map((p) => p.x));
		const minY = Math.min(...pts.map((p) => p.y));
		const maxX = Math.max(...pts.map((p) => p.x + CARD_W));
		const maxY = Math.max(...pts.map((p) => p.y + CARD_H));
		const contentW = Math.max(1, maxX - minX);
		const contentH = Math.max(1, maxY - minY);
		const vw = viewportEl.clientWidth;
		const vh = viewportEl.clientHeight;
		const pad = 48;
		const z = clampZoom(Math.min((vw - pad * 2) / contentW, (vh - pad * 2) / contentH, 1.5));
		zoom = z;
		panX = (vw - contentW * z) / 2 - minX * z;
		panY = (vh - contentH * z) / 2 - minY * z;
	}

	/** Zoom around the viewport center by a multiplicative factor. */
	function zoomByCenter(factor: number): void {
		if (!viewportEl) return;
		zoomAt(viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, factor);
	}

	/** Zoom by `factor` keeping the world point under (sx, sy) fixed on screen. */
	function zoomAt(sx: number, sy: number, factor: number): void {
		const newZoom = clampZoom(zoom * factor);
		if (newZoom === zoom) return;
		const wx = (sx - panX) / zoom;
		const wy = (sy - panY) / zoom;
		panX = sx - wx * newZoom;
		panY = sy - wy * newZoom;
		zoom = newZoom;
	}

	function onWheel(e: WheelEvent): void {
		if (!viewportEl) return;
		e.preventDefault();
		const rect = viewportEl.getBoundingClientRect();
		zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
	}

	function onCardMouseDown(name: string, e: MouseEvent): void {
		if (!(e.target as HTMLElement).closest('.card-header')) return;
		activeDragTable = name;
		dragStart = { x: e.clientX, y: e.clientY };
		tableStart = { ...positions[name] };
		e.preventDefault();
		e.stopPropagation();
	}

	function onCanvasMouseDown(e: MouseEvent): void {
		// Empty-canvas drag pans the board (card headers stopPropagation above).
		isPanning = true;
		panStart = { x: e.clientX - panX, y: e.clientY - panY };
	}

	function onMouseMove(e: MouseEvent): void {
		if (activeDragTable && positions[activeDragTable]) {
			// Deltas are in screen pixels; divide by zoom to move in world space.
			const dx = (e.clientX - dragStart.x) / zoom;
			const dy = (e.clientY - dragStart.y) / zoom;
			positions[activeDragTable] = { x: tableStart.x + dx, y: tableStart.y + dy };
		} else if (isPanning) {
			panX = e.clientX - panStart.x;
			panY = e.clientY - panStart.y;
		}
	}

	function onMouseUp(): void {
		activeDragTable = null;
		isPanning = false;
	}

	function getConnectionPath(fromName: string, fk: ErForeignKey): string {
		const posA = positions[fromName];
		const posB = positions[fk.refTable];
		if (!posA || !posB) return '';

		let x1 = posA.x + CARD_W / 2;
		let x2 = posB.x + CARD_W / 2;
		const y1 = posA.y + CARD_H / 2;
		const y2 = posB.y + CARD_H / 2;

		if (posA.x + CARD_W < posB.x) {
			x1 = posA.x + CARD_W;
			x2 = posB.x;
		} else if (posB.x + CARD_W < posA.x) {
			x1 = posA.x;
			x2 = posB.x + CARD_W;
		}

		const dx = Math.abs(x2 - x1) * 0.5;
		const cx1 = x1 + (x2 > x1 ? dx : -dx);
		const cx2 = x2 + (x2 > x1 ? -dx : dx);
		return `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
	}
</script>

<svelte:window onmousemove={onMouseMove} onmouseup={onMouseUp} />

<div class="flex-1 min-h-0 flex flex-col bg-slate-50 dark:bg-slate-900 overflow-hidden relative">
	{#if loading}
		<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-400">
			<Icon name="lucide:loader" class="w-8 h-8 animate-spin text-violet-600" />
			<span class="text-sm font-medium">Generating ER Diagram...</span>
		</div>
	{:else if error}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-red-500 p-6">
			<Icon name="lucide:circle-alert" class="w-10 h-10" />
			<span class="text-sm font-semibold">{error}</span>
		</div>
	{:else if tables.length === 0}
		<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-400 py-10">
			<Icon name="lucide:network" class="w-12 h-12 opacity-30" />
			<span class="text-sm">No tables found to display</span>
		</div>
	{:else}
		<!-- Viewport: fixed frame; the world inside is panned/zoomed. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			bind:this={viewportEl}
			class="flex-1 relative overflow-hidden {isPanning ? 'cursor-grabbing' : 'cursor-grab'}"
			onwheel={onWheel}
			onmousedown={onCanvasMouseDown}
		>
			<!-- Dotted background stays fixed to the frame. -->
			<div
				class="absolute inset-0 select-none pointer-events-none opacity-[0.4] dark:opacity-[0.15]"
				style="background-size: 20px 20px; background-image: radial-gradient(circle, #475569 1px, transparent 1px);"
			></div>

			<!-- World: everything positioned in world coordinates. -->
			<div
				class="absolute top-0 left-0 origin-top-left"
				style="transform: translate({panX}px, {panY}px) scale({zoom});"
			>
				<svg class="absolute top-0 left-0 pointer-events-none overflow-visible w-px h-px">
					<defs>
						<marker id="er-arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
							<path d="M 0 1 L 10 5 L 0 9 z" class="fill-slate-400 dark:fill-slate-600" />
						</marker>
					</defs>
					{#each tables as table (table.name)}
						{#each table.foreignKeys as fk, i (fk.column + fk.refTable + i)}
							{#if positions[table.name] && positions[fk.refTable]}
								<path
									d={getConnectionPath(table.name, fk)}
									fill="none"
									stroke-width="1.5"
									class="stroke-slate-400 dark:stroke-slate-600"
									marker-end="url(#er-arrow)"
								/>
							{/if}
						{/each}
					{/each}
				</svg>

				{#each tables as table (table.name)}
					{#if positions[table.name]}
						<div
							class="absolute bg-white dark:bg-slate-950 border rounded-lg shadow-sm overflow-hidden select-none flex flex-col {table.name === tableName ? 'border-violet-400 dark:border-violet-600 ring-1 ring-violet-400/40' : 'border-slate-200 dark:border-slate-800'}"
							style="left: {positions[table.name].x}px; top: {positions[table.name].y}px; width: {CARD_W}px; max-height: {CARD_H}px;"
						>
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="card-header px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center gap-1.5 cursor-grab active:cursor-grabbing shrink-0"
								onmousedown={(e) => onCardMouseDown(table.name, e)}
							>
								<Icon name="lucide:table" class="w-3.5 h-3.5 text-slate-500 shrink-0" />
								<span class="font-bold text-xs text-slate-800 dark:text-slate-200 truncate" title={table.name}>
									{table.name}
								</span>
							</div>

							<div class="flex-1 overflow-y-auto px-3 py-1.5 space-y-1 font-mono text-[10px] bg-slate-50/30 dark:bg-slate-950">
								{#each table.columns as col (col.name)}
									<div class="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
										<div class="flex items-center gap-1 truncate">
											{#if col.isPrimary}
												<Icon name="lucide:key" class="w-3 h-3 text-amber-500 shrink-0" />
											{:else if table.foreignKeys.some((fk) => fk.column === col.name)}
												<Icon name="lucide:link" class="w-3 h-3 text-violet-500 shrink-0" />
											{:else}
												<div class="w-3 h-3 shrink-0"></div>
											{/if}
											<span class="truncate font-semibold text-slate-700 dark:text-slate-300">{col.name}</span>
										</div>
										<span class="text-slate-400 text-[9px] shrink-0">{col.type}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/each}
			</div>

			<!-- Zoom / fit controls -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-950/90 backdrop-blur px-1 py-1 shadow-sm"
				onmousedown={(e) => e.stopPropagation()}
			>
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 dark:text-slate-400"
					onclick={() => zoomByCenter(1 / 1.2)}
					title="Zoom out"
					aria-label="Zoom out"
				>
					<Icon name="lucide:minus" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="min-w-[3rem] text-center text-xs font-medium text-slate-500 dark:text-slate-400 tabular-nums hover:text-slate-700 dark:hover:text-slate-200"
					onclick={fitView}
					title="Fit to view"
				>
					{Math.round(zoom * 100)}%
				</button>
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 dark:text-slate-400"
					onclick={() => zoomByCenter(1.2)}
					title="Zoom in"
					aria-label="Zoom in"
				>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</button>
				<div class="w-px h-5 bg-slate-200 dark:bg-slate-800 mx-0.5"></div>
				<button
					type="button"
					class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 dark:text-slate-400"
					onclick={fitView}
					title="Fit to view"
					aria-label="Fit to view"
				>
					<Icon name="lucide:maximize" class="w-4 h-4" />
				</button>
			</div>
		</div>
	{/if}
</div>

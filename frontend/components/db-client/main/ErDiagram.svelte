<script lang="ts">
	import { onMount } from 'svelte';
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

	// Table coordinates: tableName -> { x, y }
	let positions = $state<Record<string, { x: number; y: number }>>({});

	// Drag state
	let activeDragTable = $state<string | null>(null);
	let dragStart = { x: 0, y: 0 };
	let tableStart = { x: 0, y: 0 };

	const cardWidth = 200;
	const cardHeight = 160;

	onMount(() => {
		const loadSchema = async () => {
			loading = true;
			error = null;
			try {
				const res = await dbClientStore.getErSchema(connectionId, { database, schema });
				const allTables = res.tables;

				// Filter to only include active table and its direct relations
				const relatedTableNames = new Set<string>();
				relatedTableNames.add(tableName);

				const activeTableData = allTables.find(t => t.name === tableName);
				if (activeTableData) {
					activeTableData.foreignKeys.forEach(fk => {
						relatedTableNames.add(fk.refTable);
					});
				}

				allTables.forEach(t => {
					t.foreignKeys.forEach(fk => {
						if (fk.refTable === tableName) {
							relatedTableNames.add(t.name);
						}
					});
				});

				tables = allTables.filter(t => relatedTableNames.has(t.name));

				// Layout tables: Left (references us) -> Center (us) -> Right (we reference)
				const leftTables: string[] = [];
				const rightTables: string[] = [];

				tables.forEach(t => {
					if (t.name === tableName) return;
					const isReferencedByActive = activeTableData?.foreignKeys.some(fk => fk.refTable === t.name);
					if (isReferencedByActive) {
						rightTables.push(t.name);
					} else {
						leftTables.push(t.name);
					}
				});

				const posMap: Record<string, { x: number; y: number }> = {};
				
				// Center table
				posMap[tableName] = { x: 320, y: 120 };

				// Left columns
				leftTables.forEach((name, idx) => {
					const total = leftTables.length;
					const spacing = 180;
					const startY = 120 - ((total - 1) * spacing) / 2;
					posMap[name] = { x: 60, y: Math.max(20, startY + idx * spacing) };
				});

				// Right columns
				rightTables.forEach((name, idx) => {
					const total = rightTables.length;
					const spacing = 180;
					const startY = 120 - ((total - 1) * spacing) / 2;
					posMap[name] = { x: 580, y: Math.max(20, startY + idx * spacing) };
				});

				positions = posMap;
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			} finally {
				loading = false;
			}
		};
		loadSchema();
	});

	function onMouseDown(tableName: string, e: MouseEvent) {
		const target = e.target as HTMLElement;
		// Only drag if clicking on the card header
		if (!target.closest('.card-header')) return;

		activeDragTable = tableName;
		dragStart = { x: e.clientX, y: e.clientY };
		tableStart = { ...positions[tableName] };
		e.preventDefault();
	}

	function onMouseMove(e: MouseEvent) {
		if (activeDragTable && positions[activeDragTable]) {
			const dx = e.clientX - dragStart.x;
			const dy = e.clientY - dragStart.y;
			positions[activeDragTable] = {
				x: Math.max(10, tableStart.x + dx),
				y: Math.max(10, tableStart.y + dy)
			};
		}
	}

	function onMouseUp() {
		activeDragTable = null;
	}

	function getConnectionPath(tableAName: string, fk: ErForeignKey) {
		const posA = positions[tableAName];
		const posB = positions[fk.refTable];
		if (!posA || !posB) return '';

		let x1 = posA.x + cardWidth / 2;
		let y1 = posA.y + cardHeight / 2;
		let x2 = posB.x + cardWidth / 2;
		let y2 = posB.y + cardHeight / 2;

		if (posA.x + cardWidth < posB.x) {
			x1 = posA.x + cardWidth;
			x2 = posB.x;
		} else if (posB.x + cardWidth < posA.x) {
			x1 = posA.x;
			x2 = posB.x + cardWidth;
		}

		const dx = Math.abs(x2 - x1) * 0.5;
		const cx1 = x1 + (x2 > x1 ? dx : -dx);
		const cy1 = y1;
		const cx2 = x2 + (x2 > x1 ? -dx : dx);
		const cy2 = y2;

		return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
	}
</script>

<svelte:window onmousemove={onMouseMove} onmouseup={onMouseUp} />

<div class="flex-1 min-h-0 flex flex-col bg-slate-50 dark:bg-slate-900 overflow-hidden relative">
	<!-- Canvas Background -->
	<div 
		class="absolute inset-0 select-none pointer-events-none opacity-[0.4] dark:opacity-[0.15]" 
		style="background-size: 20px 20px; background-image: radial-gradient(circle, #475569 1px, transparent 1px);"
	></div>

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
		<!-- Board Canvas -->
		<div class="flex-1 relative overflow-auto p-10 min-w-full min-h-full">
			<!-- SVG Relation Lines -->
			<svg class="absolute inset-0 pointer-events-none w-[3000px] h-[3000px]">
				<defs>
					<marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
						<path d="M 0 1 L 10 5 L 0 9 z" class="fill-slate-400 dark:fill-slate-600" />
					</marker>
				</defs>
				{#each tables as table}
					{#each table.foreignKeys as fk}
						{#if positions[table.name] && positions[fk.refTable]}
							<path
								d={getConnectionPath(table.name, fk)}
								fill="none"
								stroke-width="1.5"
								class="stroke-slate-400 dark:stroke-slate-600"
								marker-end="url(#arrow)"
							/>
						{/if}
					{/each}
				{/each}
			</svg>

			<!-- Table Cards -->
			{#each tables as table}
				{#if positions[table.name]}
					<div
						class="absolute bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm overflow-hidden select-none flex flex-col"
						style="left: {positions[table.name].x}px; top: {positions[table.name].y}px; width: {cardWidth}px; max-height: {cardHeight}px;"
					>
						<!-- Card Header (Draggable) -->
						<div
							class="card-header px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center gap-1.5 cursor-grab active:cursor-grabbing shrink-0"
							onmousedown={(e) => onMouseDown(table.name, e)}
						>
							<Icon name="lucide:table" class="w-3.5 h-3.5 text-slate-500 shrink-0" />
							<span class="font-bold text-xs text-slate-800 dark:text-slate-200 truncate" title={table.name}>
								{table.name}
							</span>
						</div>

						<!-- Card Body (Columns list) -->
						<div class="flex-1 overflow-y-auto px-3 py-1.5 space-y-1 font-mono text-[10px] bg-slate-50/30 dark:bg-slate-950">
							{#each table.columns as col}
								<div class="flex items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
									<div class="flex items-center gap-1 truncate">
										{#if col.isPrimary}
											<Icon name="lucide:key" class="w-3 h-3 text-amber-500 shrink-0" />
										{:else if table.foreignKeys.some(fk => fk.column === col.name)}
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
	{/if}
</div>

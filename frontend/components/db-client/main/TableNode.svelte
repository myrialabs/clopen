<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	interface ErColumn {
		name: string;
		type: string;
		isPrimary: boolean;
		isFk: boolean;
	}

	interface TableNodeData {
		label: string;
		isActive: boolean;
		columns: ErColumn[];
	}

	const { data }: { data: TableNodeData } = $props();
</script>

<div
	class="er-table rounded-lg border bg-white shadow-md dark:bg-slate-800 {data.isActive
		? 'border-violet-400 ring-1 ring-violet-400/40 dark:border-violet-500'
		: 'border-slate-200 dark:border-slate-700'}"
>
	<div
		class="er-drag-handle flex items-center gap-1.5 rounded-t-lg border-b border-slate-200 bg-slate-100 px-3 py-1.5 dark:border-slate-600 dark:bg-slate-700"
	>
		<Icon name="lucide:table" class="w-3.5 h-3.5 text-slate-500 shrink-0" />
		<span class="truncate text-xs font-bold text-slate-800 dark:text-slate-200" title={data.label}>
			{data.label}
		</span>
	</div>

	<div class="py-1">
		{#each data.columns as col (col.name)}
			<div
				class="relative flex items-center justify-between gap-3 px-3 font-mono text-slate-600 dark:text-slate-400"
				style="height: 22px;"
			>
				<!-- Column-level connection anchors (invisible; edges attach to these). -->
				<Handle
					id="{col.name}__target-left"
					type="target"
					position={Position.Left}
					isConnectable={false}
					class="er-handle"
				/>
				<Handle
					id="{col.name}__source-left"
					type="source"
					position={Position.Left}
					isConnectable={false}
					class="er-handle"
				/>
				<Handle
					id="{col.name}__target-right"
					type="target"
					position={Position.Right}
					isConnectable={false}
					class="er-handle"
				/>
				<Handle
					id="{col.name}__source-right"
					type="source"
					position={Position.Right}
					isConnectable={false}
					class="er-handle"
				/>

				<div class="flex min-w-0 items-center gap-1">
					{#if col.isPrimary}
						<Icon name="lucide:key" class="w-3 h-3 text-amber-500 shrink-0" />
					{:else if col.isFk}
						<Icon name="lucide:link" class="w-3 h-3 text-violet-500 shrink-0" />
					{:else}
						<div class="w-3 h-3 shrink-0"></div>
					{/if}
					<span class="truncate text-[10px] font-semibold text-slate-700 dark:text-slate-300">
						{col.name}
					</span>
				</div>
				<span class="shrink-0 text-[9px] text-slate-400">{col.type}</span>
			</div>
		{/each}
	</div>
</div>

<style>
	.er-table {
		width: 240px;
		overflow: hidden;
	}

	/* Anchors are functional but invisible; edges snap to their center. */
	:global(.svelte-flow__handle.er-handle) {
		width: 1px;
		height: 1px;
		min-width: 0;
		min-height: 0;
		border: 0;
		background: transparent;
		opacity: 0;
	}
</style>

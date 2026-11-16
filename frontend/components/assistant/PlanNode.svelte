<script lang="ts">
	/** One step on the plan canvas: who does it, what, and how it went. */
	import { Handle, Position } from '@xyflow/svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { PlanNodeData } from './plan-graph';
	import { money } from './recipe-format';

	const { data }: { data: PlanNodeData } = $props();

	const STATUS: Record<PlanNodeData['status'], { label: string; tone: string; icon: 'lucide:circle-check' | 'lucide:circle-x' | 'lucide:circle-minus' | 'lucide:wrench' | 'lucide:circle' | 'lucide:loader' }> = {
		done: { label: 'Done', tone: 'text-emerald-600 dark:text-emerald-400', icon: 'lucide:circle-check' },
		running: { label: 'Working', tone: 'text-violet-600 dark:text-violet-400', icon: 'lucide:loader' },
		failed: { label: 'Failed', tone: 'text-red-600 dark:text-red-400', icon: 'lucide:circle-x' },
		skipped: { label: 'Skipped', tone: 'text-slate-400', icon: 'lucide:circle-minus' },
		repaired: { label: 'Repaired', tone: 'text-amber-600 dark:text-amber-400', icon: 'lucide:wrench' },
		waiting: { label: 'Waiting', tone: 'text-slate-400', icon: 'lucide:circle' },
		stopped: { label: 'Stopped', tone: 'text-slate-500', icon: 'lucide:circle-minus' },
		unreached: { label: 'Not reached', tone: 'text-slate-400', icon: 'lucide:circle-minus' }
	};
	const status = $derived(STATUS[data.status]);
	// Every side can take an edge: the snake layout decides which one a link uses.
	const SIDES = ['left', 'right', 'top', 'bottom'] as const;
	const POSITION = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom };
	const trigger = $derived(data.kind === 'trigger');
</script>

{#each SIDES as side (side)}
	<Handle type="target" id="{side}-t" position={POSITION[side]} class="!opacity-0 !pointer-events-none" />
	<Handle type="source" id="{side}-s" position={POSITION[side]} class="!opacity-0 !pointer-events-none" />
{/each}
<div
	class="w-56 rounded-xl border bg-white dark:bg-slate-800 shadow-sm px-3 py-2.5 cursor-pointer transition-colors
		{data.selected ? 'border-violet-500 ring-2 ring-violet-500/25' : data.status === 'running' ? 'border-violet-400/70' : data.status === 'failed' ? 'border-red-300 dark:border-red-500/50' : 'border-slate-200 dark:border-slate-700'}
		{trigger ? 'bg-violet-50 dark:bg-violet-500/10' : ''}"
>
	<div class="flex items-center gap-1.5 min-w-0">
		<Icon name={data.icon} class="w-3.5 h-3.5 shrink-0 text-violet-500" />
		<span class="text-2xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 truncate">{data.who}</span>
		{#if data.notConnected}
			<span class="ml-auto flex items-center gap-1 text-2xs shrink-0 text-amber-600 dark:text-amber-400">
				<Icon name="lucide:plug" class="w-3 h-3" />Not connected
			</span>
		{:else if !trigger}
			<span class="ml-auto flex items-center gap-1 text-2xs shrink-0 {status.tone}">
				<Icon name={status.icon} class="w-3 h-3 {data.status === 'running' ? 'animate-spin' : ''}" />{status.label}
			</span>
		{/if}
	</div>
	<p class="mt-1 text-sm leading-snug line-clamp-2 {data.status === 'unreached' ? 'text-slate-400' : 'text-slate-900 dark:text-slate-100'}">{data.title}</p>
	{#if data.round}<span class="mt-1 inline-block px-1.5 py-0.5 rounded bg-violet-500/10 text-2xs text-violet-600 dark:text-violet-300">Round {data.round}</span>{/if}
	{#if data.costUsd}<p class="mt-0.5 text-2xs text-slate-400">{money(data.costUsd)}</p>{/if}
</div>

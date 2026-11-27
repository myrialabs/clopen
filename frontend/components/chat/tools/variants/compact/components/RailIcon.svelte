<!--
	A tool's node on the timeline rail: its icon, coloured by how the call went.
	Running replaces the icon with a spinner; the background masks the rail.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import { useCompactTool } from './context';

	const { icon }: { icon: IconName } = $props();

	const tool = useCompactTool();
	const status = $derived(tool?.status ?? null);

	const tone = $derived.by(() => {
		switch (status) {
			case 'processing': return 'text-violet-500 dark:text-violet-400';
			case 'waiting': return 'text-amber-500 dark:text-amber-400';
			case 'success': return 'text-emerald-600 dark:text-emerald-400';
			case 'error': return 'text-red-500 dark:text-red-400';
			case 'interrupted': return 'text-slate-400 dark:text-slate-500';
			default: return 'text-slate-500 dark:text-slate-400';
		}
	});

	const title = $derived.by(() => {
		switch (status) {
			case 'processing': return 'Running';
			case 'waiting': return 'Waiting for your input';
			case 'success': return 'Done';
			case 'error': return 'Failed';
			case 'interrupted': return 'Stopped before it finished';
			default: return undefined;
		}
	});
</script>

<span class="relative shrink-0 w-[14px] mt-[1px] flex items-center justify-center z-10 {tone}" {title}>
	<span class="absolute inset-0 -m-[3px] rounded bg-slate-50 dark:bg-slate-900"></span>
	{#if status === 'processing'}
		<Icon name="lucide:loader-circle" class="relative w-[13px] h-[13px] animate-spin" />
	{:else}
		<Icon name={icon} class="relative w-[13px] h-[13px]" />
	{/if}
</span>

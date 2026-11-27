<!--
	Sits right after a tool row's label: how long the call took.
-->
<script lang="ts">
	import { formatDuration } from '$frontend/utils/format';
	import { useCompactTool } from './context';

	const tool = useCompactTool();
	const duration = $derived(tool?.durationMs !== undefined ? formatDuration(tool.durationMs) : '');
</script>

{#if duration}
	<span class="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums shrink-0">{duration}</span>
{/if}

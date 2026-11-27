<!--
	Why a tool call failed, shown the same way for every tool.
-->
<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { processAnsiCodes } from '$frontend/utils/terminal-formatter';

	const { text, compact = false }: { text: string; compact?: boolean } = $props();
</script>

<div class="rounded border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 overflow-hidden {compact ? '' : 'mt-4'}">
	<div class="flex items-center gap-1.5 px-2.5 pt-1.5 font-medium text-red-700 dark:text-red-300 {compact ? 'text-[10px]' : 'text-xs'}">
		<Icon name="lucide:circle-x" class={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
		Failed
	</div>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -->
	<pre class="font-mono text-red-800 dark:text-red-200 px-2.5 py-1.5 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed {compact ? 'text-[10px]' : 'text-xs'}">{@html processAnsiCodes(text)}</pre>
</div>

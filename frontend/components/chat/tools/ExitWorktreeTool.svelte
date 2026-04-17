<script lang="ts">
	import type { ToolUseBlock, ExitWorktreeInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ExitWorktreeInput);
	const result = $derived(toolInput.result);

	const keep = $derived(input.keep === true);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<InfoLine icon="lucide:log-out" text={keep ? 'Exit worktree (keep changes)' : 'Exit worktree'} />
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}

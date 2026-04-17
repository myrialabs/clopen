<script lang="ts">
	import type { ToolUseBlock, EnterWorktreeInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EnterWorktreeInput);
	const result = $derived(toolInput.result);

	const name = $derived(input.name);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<InfoLine icon="lucide:git-branch-plus" text={name ? `Enter worktree: ${name}` : 'Enter worktree'} />
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}

<script lang="ts">
	import type { ToolUseBlock, ExitPlanModeInput } from '$shared/types/unified';
	import CodeBlock from './components/CodeBlock.svelte';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ExitPlanModeInput);
	const result = $derived(toolInput.result);

	const plan = $derived((input as Record<string, unknown>).plan as string || '');
</script>

<div class="space-y-1.5">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span>plan ready</span>
	</div>
	{#if plan}
		<CodeBlock code={plan} type="neutral" />
	{/if}
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>

<script lang="ts">
	import type { ToolUseBlock, SkillInput } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as SkillInput);

	const skillName = $derived(input.skill || '');
	const skillArgs = $derived(input.args || '');
	const skillPrompt = $derived(toolInput.skillPrompt);
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<code class="font-mono">/{skillName}{skillArgs ? ` ${skillArgs}` : ''}</code>
	</div>
	{#if skillPrompt}
		<TextMessage content={skillPrompt} />
	{/if}
</div>

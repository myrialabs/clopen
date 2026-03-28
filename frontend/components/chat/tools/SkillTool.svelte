<script lang="ts">
	import type { SkillToolInput } from '$shared/types/messaging';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: SkillToolInput } = $props();

	const skillName = $derived(toolInput.input.skill || '');
	const skillArgs = $derived(toolInput.input.args || '');
	const skillPrompt = $derived(toolInput.$skillPrompt);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:zap" text="/{skillName}{skillArgs ? ` ${skillArgs}` : ''}" />
	</div>
</div>

{#if skillPrompt}
	<TextMessage content={skillPrompt} />
{/if}

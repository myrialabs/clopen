<script lang="ts">
	import type { ToolUseBlock, SkillInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as SkillInput);

	const skillName = $derived(input.skill || '');
	const skillArgs = $derived(input.args || '');
	const inlineCode = $derived(`/${skillName}${skillArgs ? ` ${skillArgs}` : ''}`);
</script>

<ToolRow icon="lucide:wand-sparkles" label="Skill" {inlineCode} />

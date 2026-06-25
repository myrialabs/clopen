<script lang="ts">
	import type { ToolUseBlock, EnterWorktreeInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EnterWorktreeInput);
</script>

<ToolRow icon="lucide:git-branch" label="Worktree enter" detail={input.name || 'default'} />

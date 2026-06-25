<script lang="ts">
	import type { ToolUseBlock, ExitWorktreeInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ExitWorktreeInput);

	const keep = $derived(input.keep === true);
</script>

<ToolRow icon="lucide:git-branch" label="Worktree exit" detail={keep ? 'keep changes' : 'discard changes'} />

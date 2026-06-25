<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput: _toolInput }: { toolInput: ToolUseBlock } = $props();
</script>

<ToolRow icon="lucide:clipboard-list" label="Plan" detail="entering plan mode" />

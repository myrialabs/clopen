<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import type { LineChangeCount } from '$shared/utils/diff-calculator';
	import { runDiff, isDiffAbort } from '$frontend/services/diff/diff-pool';
	import { debug } from '$shared/utils/logger';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');

	// Count only lines that actually changed, so identical context lines inside
	// the edited region aren't miscounted as +/-. Counted in the diff worker: an
	// edit can replace a whole file, and this row must not be what stalls the
	// chat. The badge simply appears once the count is in.
	let diff = $state<LineChangeCount | undefined>(undefined);
	$effect(() => {
		const counts = { oldContent: input.oldString || '', newContent: input.newString || '' };
		const controller = new AbortController();
		runDiff('count', counts, controller.signal)
			.then((result) => {
				diff = result;
			})
			.catch((error) => {
				if (!isDiffAbort(error, controller.signal)) debug.warn('chat', 'Edit line count failed:', error);
			});
		return () => controller.abort();
	});
</script>

<ToolRow icon="lucide:pencil" label="Edited" {filePath} {fileName} {diff} />

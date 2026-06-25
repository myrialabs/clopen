<script lang="ts">
	import type { ToolUseBlock, LspInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as LspInput);

	const label = $derived(`LSP ${input.operation || 'lsp'}`);
	const location = $derived([
		input.filePath,
		input.line != null ? `L${input.line}` : '',
		input.column != null ? `C${input.column}` : '',
	].filter(Boolean).join(':'));
</script>

<ToolRow icon="lucide:code" {label} inlineCode={input.symbol || ''} meta={location} />

<script lang="ts">
	import type { ToolUseBlock, KnownToolName } from '$shared/types/unified';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { debug } from '$shared/utils/logger';
	import { CustomMcpTool, UnknownTool, CustomMcpToolCompact, UnknownToolCompact } from '../tools';
	import { TOOL_COMPONENTS_CLASSIC, TOOL_COMPONENTS_COMPACT } from '../tools/registry';
	import ToolRenderError from '../tools/ToolRenderError.svelte';
	import ToolFailure from '../tools/ToolFailure.svelte';
	import { failureText, withoutFailure } from '../tools/tool-result';
	import { ToolDetails, detailViews, setCompactToolContext } from '../tools/variants/compact/components';
	import { getToolStatus } from '$frontend/utils/chat/tool-status';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { sessionState } from '$frontend/stores/core/sessions.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();

	const isCompact = $derived(settings.chatAppearance === 'compact');

	const Component = $derived.by(() => {
		const name = toolInput.name;
		if (isCompact) {
			if (name.startsWith('mcp__')) return CustomMcpToolCompact;
			if (name.startsWith('Unknown:')) return UnknownToolCompact;
			return TOOL_COMPONENTS_COMPACT[name as KnownToolName] ?? UnknownToolCompact;
		}
		if (name.startsWith('mcp__')) return CustomMcpTool;
		if (name.startsWith('Unknown:')) return UnknownTool;
		return TOOL_COMPONENTS_CLASSIC[name as KnownToolName] ?? UnknownTool;
	});

	// Failure is drawn here the same way for every tool; status and duration go
	// to the compact row below, and to the message header in classic.
	const status = $derived(getToolStatus(toolInput, {
		isLoading: appState.isLoading,
		isWaitingInput: appState.isWaitingInput,
		messages: sessionState.messages
	}));
	const failure = $derived(failureText(toolInput));
	const rendered = $derived(withoutFailure(toolInput));

	// Compact: the row opens to what it leaves out.
	const views = $derived(isCompact ? detailViews(rendered) : []);
	const hasDetails = $derived(views.length > 0 || failure !== null);
	let expanded = $state(false);

	setCompactToolContext({
		get status() { return status; },
		get durationMs() { return toolInput.durationMs; },
		get hasDetails() { return hasDetails; },
		get expanded() { return expanded; },
		toggle() { expanded = !expanded; }
	});
</script>

<!--
	Every tool renderer is isolated. Tool inputs originate from the engine and are
	not guaranteed to match their declared schema, so a single bad block must not
	be able to tear down the surrounding chat — or the app.
-->
<svelte:boundary onerror={(error) => debug.error('chat', `Tool renderer failed for ${toolInput.name}:`, error)}>
	<Component toolInput={rendered} />

	{#if isCompact}
		{#if expanded && hasDetails}
			<ToolDetails {views} {failure} />
		{/if}
	{:else if failure}
		<!-- Classic: the outcome and duration live in the message header -->
		<ToolFailure text={failure} />
	{/if}

	{#snippet failed(error, reset)}
		<ToolRenderError {toolInput} {error} {reset} />
	{/snippet}
</svelte:boundary>

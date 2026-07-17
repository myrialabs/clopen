<!--
  Debug Modal Component

  Features:
  - Display raw message data
  - JSON formatting
  - Copy to clipboard

  The normal chat payload trims sub-agent (Task) tool noise for bandwidth
  (see shared/utils/subagent-wire-trim.ts), so the in-memory message can carry
  slimmed sub-agent activity. On open we fetch the full untrimmed sub-agent
  messages straight from the DB and rebuild the complete subActivities so the
  debug view always shows the real, complete data.
-->

<script lang="ts">
	import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { processSubAgentMessages } from '$frontend/utils/chat/tool-handler';
	import { debug } from '$shared/utils/logger';

	let {
		isOpen = $bindable(),
		message,
		onClose
	}: {
		isOpen: boolean;
		message: FrontendMessage;
		onClose: () => void;
	} = $props();

	// The message actually rendered — set to the in-memory copy when the modal
	// opens, then replaced with a full-data clone once sub-agent messages load.
	let displayMessage = $state<unknown>(undefined);

	// Fetch full sub-agent data and graft complete subActivities when the modal
	// opens on a message that has (possibly trimmed) sub-agent activity.
	$effect(() => {
		if (!isOpen) return;

		const msg = message as any;
		displayMessage = message;

		const messageId: string | undefined = msg?.messageId;
		const toolBlocks: any[] =
			msg?.type === 'assistant' && Array.isArray(msg.content)
				? msg.content.filter((b: any) => b?.type === 'tool_use')
				: [];
		const hasSubAgentActivity = toolBlocks.some(
			(b: any) => Array.isArray(b.subActivities) && b.subActivities.length > 0
		);

		if (!messageId || !hasSubAgentActivity) return;

		ws.http('messages:get-subagents', { messageId })
			.then((subMessages: any) => {
				if (!Array.isArray(subMessages) || subMessages.length === 0) return;

				// Group full sub-agent messages by the tool_use they belong to.
				const byToolUseId = new Map<string, any[]>();
				for (const sub of subMessages) {
					const parentToolUseId: string | undefined = sub?.parent?.toolUseId;
					if (!parentToolUseId) continue;
					if (!byToolUseId.has(parentToolUseId)) byToolUseId.set(parentToolUseId, []);
					byToolUseId.get(parentToolUseId)!.push(sub);
				}
				if (byToolUseId.size === 0) return;

				// Deep clone (also strips Svelte proxies) and graft full subActivities.
				const clone = JSON.parse(JSON.stringify(message));
				for (const block of clone.content ?? []) {
					if (block?.type === 'tool_use' && byToolUseId.has(block.id)) {
						block.subActivities = processSubAgentMessages(byToolUseId.get(block.id)!);
					}
				}
				displayMessage = clone;
			})
			.catch((err) => {
				debug.warn('chat', 'Failed to load full sub-agent data for debug:', err);
			});
	});

	function copyToClipboard() {
		navigator.clipboard.writeText(JSON.stringify(displayMessage, null, 2));
	}
</script>

<Modal
	bind:isOpen
	title="Debug Information"
	size="lg"
	{onClose}
>
	{#snippet children()}
		<div class="space-y-6">
			<!-- Raw Message Data -->
			<div>
				<h4 class="font-medium text-slate-900 dark:text-slate-100 mb-2 flex items-center gap-2">
					<Icon name="lucide:code" class="w-4 h-4" />
					Raw Message
				</h4>
				<div class="bg-slate-100 dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
					<pre class="text-xs font-mono text-slate-700 dark:text-slate-300 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-words">{JSON.stringify(displayMessage, null, 2)}</pre>
				</div>
				<div class="mt-3 flex justify-end">
					<button
						onclick={copyToClipboard}
						class="px-3 py-1.5 bg-violet-500 hover:bg-violet-600 text-white rounded-md text-xs font-medium transition-colors flex items-center gap-1"
					>
						<Icon name="lucide:copy" class="w-3 h-3" />
						Copy JSON
					</button>
				</div>
			</div>
		</div>
	{/snippet}
</Modal>

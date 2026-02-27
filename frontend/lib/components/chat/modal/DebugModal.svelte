<!--
  Debug Modal Component

  Features:
  - Display raw message data
  - JSON formatting
  - Copy to clipboard
-->

<script lang="ts">
	import type { SDKMessageFormatter } from '$shared/types/database/schema';
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	let {
		isOpen = $bindable(),
		message,
		onClose
	}: {
		isOpen: boolean;
		message: SDKMessageFormatter;
		onClose: () => void;
	} = $props();

	function copyToClipboard() {
		navigator.clipboard.writeText(JSON.stringify(message, null, 2));
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
					<pre class="text-xs font-mono text-slate-700 dark:text-slate-300 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-words">{JSON.stringify(message, null, 2)}</pre>
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

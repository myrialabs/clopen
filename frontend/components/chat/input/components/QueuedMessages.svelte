<script lang="ts">
	/**
	 * Messages waiting for the current response, as rows at the top of the
	 * composer (same placement as the changes summary, for the same reason:
	 * nothing floats over the conversation).
	 *
	 * The server starts the next one when a response completes. A stopped or
	 * failed response pauses the queue — what was queued behind it may no longer
	 * make sense — and each row can then be sent on purpose.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { messageQueueState, removeQueued, sendQueuedNow, type QueuedMessage } from '$frontend/stores/ui/message-queue.svelte';
	import { userStore } from '$frontend/stores/features/user.svelte';

	interface Props {
		isLoading: boolean;
		onEdit: (item: QueuedMessage) => void;
	}

	const { isLoading, onEdit }: Props = $props();

	const items = $derived(messageQueueState.items);
	const currentUserId = $derived(userStore.currentUser?.id);

	function preview(item: QueuedMessage): string {
		const text = item.text.trim();
		if (text) return text;
		return item.attachmentCount === 1 ? '1 attachment' : `${item.attachmentCount} attachments`;
	}
</script>

{#if items.length > 0}
	<div class="border-b border-slate-200 dark:border-slate-700">
		<div class="flex items-center gap-2 px-4 pt-2 pb-1 text-xs text-slate-500 dark:text-slate-400">
			<Icon name={isLoading ? 'lucide:list-ordered' : 'lucide:hourglass'} class="w-3.5 h-3.5 shrink-0" />
			{#if isLoading}
				<span>{items.length === 1 ? '1 message' : `${items.length} messages`} queued · sends when the response finishes</span>
			{:else}
				<span>Queue paused · continues after your next message</span>
			{/if}
		</div>
		<ul class="max-h-40 overflow-y-auto px-2 pb-1.5">
			{#each items as item, i (item.id)}
				{@const isMine = item.userId === currentUserId}
				<li class="group flex items-center gap-1 rounded-lg pl-2 pr-1 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800/60">
					<span class="text-xs text-slate-400 tabular-nums shrink-0 w-4">{i + 1}.</span>
					<span class="flex-1 min-w-0 truncate text-sm text-slate-700 dark:text-slate-300" title={item.text}>
						{preview(item)}
					</span>
					{#if item.attachmentCount > 0 && item.text.trim()}
						<Icon name="lucide:paperclip" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
					{/if}
					{#if !isMine}
						<span class="text-xs text-slate-400 shrink-0">{item.userName}</span>
					{:else}
						{#if !isLoading}
							<button
								type="button"
								class="flex items-center justify-center w-8 h-8 shrink-0 rounded-md text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 transition-colors"
								onclick={() => sendQueuedNow(item.id)}
								title="Send now"
								aria-label="Send now"
							>
								<Icon name="lucide:send-horizontal" class="w-4 h-4" />
							</button>
						{/if}
						<button
							type="button"
							class="flex items-center justify-center w-8 h-8 shrink-0 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
							onclick={() => onEdit(item)}
							title="Edit"
							aria-label="Edit queued message"
						>
							<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class="flex items-center justify-center w-8 h-8 shrink-0 rounded-md text-slate-500 hover:text-red-500 hover:bg-red-500/10 transition-colors"
							onclick={() => removeQueued(item.id)}
							title="Remove"
							aria-label="Remove queued message"
						>
							<Icon name="lucide:x" class="w-4 h-4" />
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	</div>
{/if}

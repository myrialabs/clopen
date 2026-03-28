<!--
  Message Bubble for SDK Messages

  Features:
  - Modern AI design with solid backgrounds
  - Message formatting
  - SDK-specific message types
  - Better accessibility
  - Responsive design
-->

<script lang="ts">
	import type { SDKMessage } from '$shared/types/messaging';
	import type { SDKMessageFormatter } from '$shared/types/database/schema';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { sessionState, loadMessagesForSession } from '$frontend/stores/core/sessions.svelte';
	import { setInputText } from '$frontend/stores/ui/chat-input.svelte';
	import { startEdit, shouldDimMessage } from '$frontend/stores/ui/edit-mode.svelte';
	import { debug } from '$shared/utils/logger';
	import MessageBubble from './MessageBubble.svelte';
	import DebugModal from '../modal/DebugModal.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ConflictResolutionModal from '$frontend/components/checkpoint/ConflictResolutionModal.svelte';
	import { snapshotService } from '$frontend/services/snapshot/snapshot.service';
	import type { RestoreConflict, ConflictResolution } from '$frontend/services/snapshot/snapshot.service';

	const {
		message,
		isLastUserMessage = false
	}: {
		message: SDKMessageFormatter;
		isLastUserMessage?: boolean;
	} = $props();

	// Modal states
	let showDebugPopup = $state(false);
	let showRestoreConfirm = $state(false);

	// Conflict resolution state
	let showConflictModal = $state(false);
	let conflictList = $state<RestoreConflict[]>([]);
	let processingRestore = $state(false);

	// Format timestamp
	const formatTime = (timestamp?: string) => {
		if (!timestamp) return 'Unknown';
		const date = new Date(timestamp);
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	};

	// Get timestamp from metadata
	const messageTimestamp = $derived.by(() => {
		if (message.metadata?.created_at) {
			return message.metadata.created_at;
		}
		return new Date().toISOString();
	});

	// Get message ID from metadata
	const messageId = $derived(message.metadata?.message_id);

	// Check if this message should be dimmed in edit mode
	const shouldBeDimmed = $derived(shouldDimMessage(messageId));

	const roleCategory = $derived.by(() => {
		// Compact boundary messages (conversation compaction indicator)
		if (message.type === 'system' && (message as any).subtype === 'compact_boundary') {
			return 'compact';
		}
		// Reasoning messages (from both engines)
		if (message.metadata?.reasoning) {
			return 'reasoning';
		}
		if (message.type === 'stream_event') {
			return 'assistant';
		}
		if (message.type === 'assistant' && 'message' in message && Array.isArray(message.message.content)) {
			const hasToolUse = message.message.content.some((c) =>
				typeof c === 'object' && c !== null && 'type' in c && c.type === 'tool_use');
			if (hasToolUse) return 'agent';
		}
		if (message.type === 'user' && 'message' in message && Array.isArray(message.message.content)) {
			const hasToolResult = message.message.content.some((c) =>
				typeof c === 'object' && c !== null && 'type' in c && c.type === 'tool_result');
			if (hasToolResult) return 'agent';
		}
		return message.type;
	});

	// Get sender info from metadata
	const senderName = $derived(message.metadata?.sender_name ?? null);

	// Copy message content to clipboard (content text only, not full JSON)
	function copyToClipboard() {
		let content = '';

		if (roleCategory === 'user' && 'message' in message && message.message?.content) {
			// Extract text from user message
			const messageContent = message.message.content;
			if (typeof messageContent === 'string') {
				content = messageContent;
			} else if (Array.isArray(messageContent)) {
				// Extract text from array content
				const textParts: string[] = [];
				for (const item of messageContent) {
					if (typeof item === 'object' && 'text' in item) {
						textParts.push(item.text);
					} else if (typeof item === 'string') {
						textParts.push(item);
					}
				}
				content = textParts.join('\n\n');
			}
		} else if (roleCategory === 'assistant' && 'message' in message && message.message?.content) {
			// Extract text from assistant message (text only, not tool_use)
			const messageContent = message.message.content;
			if (Array.isArray(messageContent)) {
				const textParts: string[] = [];
				for (const item of messageContent) {
					if (typeof item === 'object' && item.type === 'text' && 'text' in item) {
						textParts.push(item.text);
					}
				}
				content = textParts.join('\n\n');
			}
		} else if (message.type === 'stream_event' && 'partialText' in message) {
			// Copy partial text from streaming message
			content = message.partialText || '';
		}

		// Fallback to empty string if no content found
		if (!content) {
			content = '';
		}

		navigator.clipboard.writeText(content);
	}

	// Handle copy file content button clicks
	function handleCopyFileContent(event: Event) {
		const button = event.target as HTMLButtonElement;
		const content = button.getAttribute('data-content');
		if (content) {
			const decodedContent = content
				.replace(/\\n/g, '\n')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'");

			navigator.clipboard.writeText(decodedContent);
			button.textContent = 'Copied!';

			setTimeout(() => {
				button.textContent = 'Copy';
			}, 2000);
		}
	}

	// Detect agent processing status
	// When stream is no longer active (not loading) and tools don't have results,
	// mark them as failed (cancelled/interrupted) instead of perpetually "processing"
	const agentStatus = $derived.by((): 'processing' | 'waiting' | 'success' | 'error' | null => {
		if (roleCategory !== 'agent') return null;

		if (message.type === 'assistant' && 'message' in message && Array.isArray(message.message.content)) {
			const toolUses = message.message.content.filter((c: any) =>
				typeof c === 'object' && c !== null && 'type' in c && c.type === 'tool_use');

			if (toolUses.length === 0) return null;

			const allHaveResults = toolUses.every((tool: any) => '$result' in tool && tool.$result);

			if (!allHaveResults) {
				// If stream is active and waiting for user input → show as waiting
				if (appState.isWaitingInput) return 'waiting';
				// If stream is still active, tools are processing
				// If stream ended (not loading), tools were interrupted/cancelled → show as error
				return appState.isLoading ? 'processing' : 'error';
			}

			const hasError = toolUses.some((tool: any) => tool.$result?.is_error === true);

			return hasError ? 'error' : 'success';
		}

		return null;
	});

	const roleConfig = $derived.by((): { gradient: string; icon: IconName; name: string } => {
		switch (roleCategory) {
			case 'compact':
				return {
					gradient: 'from-amber-500 to-orange-600',
					icon: 'lucide:layers',
					name: 'System'
				};
			case 'reasoning':
				return {
					gradient: 'from-emerald-500 to-green-600',
					icon: 'lucide:lightbulb',
					name: 'Reasoning'
				};
			case 'agent':
				return {
					gradient: 'from-sky-500 to-blue-600',
					icon: 'lucide:wrench',
					name: 'Tool'
				};
			case 'assistant':
				return {
					gradient: 'from-violet-500 to-violet-600',
					icon: 'lucide:brain-circuit',
					name: 'Assistant'
				}
			case 'user':
				return {
					gradient: 'from-slate-500 to-slate-600',
					icon: 'lucide:user',
					name: 'User'
				}
			default:
				return {
					gradient: 'from-gray-500 to-gray-600',
					icon: 'lucide:circle-question-mark',
					name: 'Unknown'
				};
		}
	});

	// Handle click events for dynamically created copy buttons
	function handleMessageClick(event: MouseEvent) {
		const target = event.target as HTMLElement;
		if (target.classList.contains('copy-file-btn')) {
			handleCopyFileContent(event);
		}
	}

	// Handle keyboard events for message bubble
	function handleBubbleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			handleMessageClick(event as unknown as MouseEvent);
		}
	}

	// Modal handlers
	function openDebugInfoModal() {
		showDebugPopup = true;
	}

	function closeDebugInfoModal() {
		showDebugPopup = false;
	}

	// Handle restore button click - check conflicts first
	async function handleRestore() {
		if (!messageId) {
			addNotification({
				type: 'error',
				title: 'Restore Failed',
				message: 'Message ID not found',
				duration: 3000
			});
			return;
		}

		const currentSessionId = sessionState.currentSession?.id;
		if (!currentSessionId) return;

		try {
			const conflictCheck = await snapshotService.checkConflicts(messageId, currentSessionId);

			if (conflictCheck.hasConflicts) {
				// Show conflict resolution modal
				conflictList = conflictCheck.conflicts;
				showConflictModal = true;
			} else {
				// No conflicts - show simple confirmation
				showRestoreConfirm = true;
			}
		} catch (error) {
			debug.error('chat', 'Error checking conflicts:', error);
			// Fallback to simple confirmation
			showRestoreConfirm = true;
		}
	}

	// Execute restore with optional conflict resolutions
	async function executeRestore(resolutions?: ConflictResolution) {
		if (!messageId || !sessionState.currentSession?.id) return;

		processingRestore = true;

		try {
			await snapshotService.restore(
				messageId,
				sessionState.currentSession.id,
				resolutions
			);

			await loadMessagesForSession(sessionState.currentSession.id);
		} catch (error) {
			debug.error('chat', 'Restore error:', error);
			addNotification({
				type: 'error',
				title: 'Restore Failed',
				message: error instanceof Error ? error.message : 'Unknown error',
				duration: 5000
			});
		} finally {
			processingRestore = false;
		}
	}

	// Confirm simple restore (no conflicts)
	async function confirmRestore() {
		showRestoreConfirm = false;
		await executeRestore();
	}

	// Confirm restore with conflict resolutions
	async function confirmConflictRestore(resolutions: ConflictResolution) {
		await executeRestore(resolutions);
	}

	// Handle edit button click
	async function handleEdit() {
		if (!messageId) {
			addNotification({
				type: 'error',
				title: 'Edit Failed',
				message: 'Message ID not found',
				duration: 3000
			});
			return;
		}

		// Get parent_message_id from metadata (already available)
		const parentMessageId = message.metadata?.parent_message_id || null;

		// Extract message text and attachments
		let messageText = '';
		const messageAttachments: Array<{
			type: 'image' | 'document';
			data: string;
			mediaType: string;
			fileName: string;
		}> = [];

		if (roleCategory === 'user' && 'message' in message && message.message?.content) {
			const content = message.message.content;
			const attachmentFilenames = (message as any).attachmentFilenames || [];

			if (typeof content === 'string') {
				messageText = content;
			} else if (Array.isArray(content)) {
				let attachmentIndex = 0;

				for (const item of content) {
					if (typeof item === 'object' && 'text' in item) {
						messageText = item.text;
					} else if (typeof item === 'object' && 'type' in item) {
						if (item.type === 'image' && item.source?.type === 'base64') {
							messageAttachments.push({
								type: 'image',
								data: item.source.data,
								mediaType: item.source.media_type,
								fileName: attachmentFilenames[attachmentIndex] || 'image.png'
							});
							attachmentIndex++;
						} else if (item.type === 'document' && item.source?.type === 'base64') {
							messageAttachments.push({
								type: 'document',
								data: item.source.data,
								mediaType: item.source.media_type,
								fileName: attachmentFilenames[attachmentIndex] || 'document.pdf'
							});
							attachmentIndex++;
						}
					}
				}
			}
		}

		// Enter edit mode with attachments and parent message ID
		startEdit(messageId!, messageText, messageTimestamp, messageAttachments, parentMessageId);

		// Populate input with message text
		setInputText(messageText, true);
	}

	// Get message text preview for dialog
	function getMessagePreview(): string {
		if (roleCategory === 'user' && 'message' in message && message.message?.content) {
			const content = message.message.content;
			if (typeof content === 'string') {
				return content.length > 85 ? content.substring(0, 85) + '...' : content;
			} else if (Array.isArray(content)) {
				const textParts: string[] = [];
				for (const item of content) {
					if (typeof item === 'object' && 'text' in item) {
						textParts.push(item.text);
					}
				}
				const fullText = textParts.join(' ');
				return fullText.length > 85 ? fullText.substring(0, 85) + '...' : fullText;
			}
		}
		return 'this checkpoint';
	}
</script>

<div
	class="flex {roleCategory === 'user' ? 'justify-end my-6 md:my-8' : 'justify-start mb-2 md:mb-4'} group transition-opacity {shouldBeDimmed ? 'opacity-40 cursor-not-allowed' : ''}"
	onclick={handleMessageClick}
	role="button"
	tabindex="0"
	onkeydown={handleBubbleKeydown}
>
	<div class="flex items-start space-x-2 md:space-x-3 max-w-[95%] md:max-w-[85%] lg:max-w-[75%] {shouldBeDimmed ? 'pointer-events-none' : ''}"
>
		{#if roleCategory !== 'user'}
			<!-- Avatar for assistant/system -->
			<div class="flex-shrink-0 w-7 h-7 relative top-1.5 md:w-8 md:h-8 bg-gradient-to-br {roleConfig.gradient} rounded-full flex items-center justify-center">
				<Icon name={roleConfig.icon} class="text-white w-3.5 h-3.5 md:w-4 md:h-4" />
			</div>
		{/if}

		<!-- Message content -->
		<div class="grid space-y-1 md:space-y-2 min-w-44">
			<!-- Message bubble -->
			<MessageBubble
				{message}
				{messageTimestamp}
				{isLastUserMessage}
				{roleConfig}
				{roleCategory}
				{agentStatus}
				{senderName}
				{formatTime}
				onCopy={copyToClipboard}
				onRestore={handleRestore}
				onEdit={handleEdit}
				onShowDebug={openDebugInfoModal}
			/>
		</div>

		{#if roleCategory === 'user'}
			<!-- User avatar -->
			<div class="flex-shrink-0 w-7 h-7 relative top-1.5 md:w-8 md:h-8 bg-gradient-to-br {roleConfig.gradient} rounded-full flex items-center justify-center">
				<Icon name={roleConfig.icon} class="text-white w-4 h-4" />
			</div>
		{/if}
	</div>
</div>

<!-- Debug Info Popup -->
<DebugModal
	bind:isOpen={showDebugPopup}
	{message}
	onClose={closeDebugInfoModal}
/>

<!-- Undo Confirmation Dialog -->
<Dialog
	bind:isOpen={showRestoreConfirm}
	type="warning"
	title="Undo to Checkpoint"
	message={`Are you sure you want to undo to this checkpoint?
"${getMessagePreview()}"
This will restore your conversation to this point.`}
	confirmText="Undo"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={confirmRestore}
	onClose={() => {
		showRestoreConfirm = false;
	}}
/>

<!-- Conflict Resolution Modal -->
<ConflictResolutionModal
	bind:isOpen={showConflictModal}
	conflicts={conflictList}
	onConfirm={confirmConflictRestore}
	onClose={() => {
		conflictList = [];
	}}
/>

<style>
	/* Animate chevron icon when details are opened */
	:global(details[open] summary .iconify) {
		transform: rotate(90deg);
	}

	/* Improve details styling */
	:global(details summary) {
		list-style: none;
	}

	:global(details summary::-webkit-details-marker) {
		display: none;
	}
</style>

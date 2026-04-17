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
	import type { FrontendMessage } from '$frontend/stores/core/sessions.svelte';
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
		message: FrontendMessage;
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

	// Get timestamp
	const messageTimestamp = $derived(message.createdAt || new Date().toISOString());

	// Get message ID
	const messageId = $derived('messageId' in message ? message.messageId : undefined);

	// Check if this message should be dimmed in edit mode
	const shouldBeDimmed = $derived(shouldDimMessage(messageId));

	const roleCategory = $derived.by(() => {
		// Compact boundary messages
		if (message.type === 'compact_boundary') {
			return 'compact';
		}
		// Reasoning messages
		if (message.type === 'reasoning') {
			return 'reasoning';
		}
		// Streaming assistant text — displayed as assistant
		if (message.type === 'stream_event') return 'assistant';
		if (message.type === 'assistant' && 'content' in message) {
			const hasToolUse = message.content.some((c) => c.type === 'tool_use');
			if (hasToolUse) return 'agent';
		}
		if (message.type === 'user' && 'content' in message) {
			const hasToolResult = message.content.some((c) => c.type === 'tool_result');
			if (hasToolResult) return 'agent';
		}
		return message.type;
	});

	// Get sender info
	const senderName = $derived(message.type === 'user' ? message.sender?.name ?? null : null);

	// Copy message content to clipboard (content text only, not full JSON)
	function copyToClipboard() {
		let content = '';

		if (message.type === 'user' && 'content' in message) {
			const textParts: string[] = [];
			for (const item of message.content) {
				if (item.type === 'text' && 'text' in item) {
					textParts.push((item as any).text);
				}
			}
			content = textParts.join('\n\n');
		} else if (message.type === 'assistant' && 'content' in message) {
			const textParts: string[] = [];
			for (const item of message.content) {
				if (item.type === 'text' && 'text' in item) {
					textParts.push((item as any).text);
				}
			}
			content = textParts.join('\n\n');
		} else if (message.type === 'reasoning' && 'text' in message) {
			content = message.text || '';
		} else if (message.type === 'stream_event') {
			content = message.text || '';
		}

		navigator.clipboard.writeText(content || '');
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

		if (message.type === 'assistant' && 'content' in message) {
			const toolUses = message.content.filter((c) => c.type === 'tool_use');

			if (toolUses.length === 0) return null;

			const allHaveResults = toolUses.every((tool) => tool.type === 'tool_use' && (tool as any).result);

			if (!allHaveResults) {
				if (appState.isWaitingInput) return 'waiting';
				return appState.isLoading ? 'processing' : 'error';
			}

			const hasError = toolUses.some((tool) => tool.type === 'tool_use' && (tool as any).result?.isError === true);

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

		// Get parent message ID
		const parentMessageId = 'parent' in message ? (message as any).parent.messageId : null;

		// Extract message text and attachments
		let messageText = '';
		const messageAttachments: Array<{
			type: 'image' | 'document';
			data: string;
			mediaType: string;
			fileName: string;
		}> = [];

		if (roleCategory === 'user' && message.type === 'user' && 'content' in message) {
			let attachmentIndex = 0;

			for (const item of message.content) {
				if (item.type === 'text' && 'text' in item) {
					messageText = (item as any).text;
				} else if (item.type === 'image' && 'data' in item) {
					messageAttachments.push({
						type: 'image',
						data: (item as any).data,
						mediaType: (item as any).mediaType || 'image/png',
						fileName: 'image.png'
					});
					attachmentIndex++;
				} else if (item.type === 'document' && 'data' in item) {
					messageAttachments.push({
						type: 'document',
						data: (item as any).data,
						mediaType: (item as any).mediaType || 'application/pdf',
						fileName: 'document.pdf'
					});
					attachmentIndex++;
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
		if (message.type === 'user' && 'content' in message) {
			const textParts: string[] = [];
			for (const item of message.content) {
				if (item.type === 'text' && 'text' in item) {
					textParts.push((item as any).text);
				}
			}
			const fullText = textParts.join(' ');
			return fullText.length > 85 ? fullText.substring(0, 85) + '...' : fullText;
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

<script lang="ts">
	import { sessionState, setCurrentSession, createNewChatSession, clearMessages, loadMessagesForSession } from '$frontend/stores/core/sessions.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import ChatMessages from '$frontend/components/chat/message/ChatMessages.svelte';
	import ChatInput from '$frontend/components/chat/input/ChatInput.svelte';
	import TaskProgress from '$frontend/components/chat/widgets/TaskProgress.svelte';
	import RateLimitBanner from '$frontend/components/chat/widgets/RateLimitBanner.svelte';
	import TimelineModal from '$frontend/components/checkpoint/TimelineModal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';
	import { chatService } from '$frontend/services/chat/chat.service';
	import { setSkipNextRestore } from '$frontend/stores/ui/chat-input.svelte';
	import { userStore } from '$frontend/stores/features/user.svelte';
	import { cancelEdit, editModeState } from '$frontend/stores/ui/edit-mode.svelte';

	// Props
	interface Props {
		showMobileHeader?: boolean;
	}

	const { showMobileHeader = false }: Props = $props();

	// Welcome state - don't show during restoration or when session has history (restored to initial)
	const isWelcomeState = $derived(
		sessionState.messages.length === 0 &&
		!appState.isRestoring &&
		!sessionState.hasMessageHistory
	);

	// Check if we should show input (not during restoration)
	const showInput = $derived(!appState.isRestoring);

	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);

	// Scroll container
	const scrollContainer: HTMLElement | undefined = $state();

	// Checkpoints modal state
	let showCheckpoints = $state(false);

	function openCheckpoints() {
		showCheckpoints = true;
	}

	function closeCheckpoints() {
		showCheckpoints = false;
	}

	// Extract text from message content
	function extractMessageText(message: any): string {
		if (!('message' in message) || !message.message?.content) {
			return '';
		}
		const content = message.message.content;

		if (typeof content === 'string') {
			return content;
		} else if (Array.isArray(content)) {
			// Find text content in array
			for (const item of content) {
				if (typeof item === 'string') {
					return item;
				} else if (typeof item === 'object' && item !== null) {
					if ('text' in item && typeof (item as any).text === 'string') {
						return (item as any).text;
					}
				}
			}
		}
		return '';
	}

	// Process timeline messages with all necessary data
	const timelineMessages = $derived(
		sessionState.messages
			.filter(m => {
				if (m.type !== 'user') return false;
				const text = extractMessageText(m);
				return text.length > 0;
			})
			.map(msg => ({
				id: 'id' in msg ? msg.id : undefined,
				timestamp: msg.createdAt || '',
				date: msg.createdAt ? new Date(msg.createdAt).toLocaleDateString() : 'Unknown',
				time: msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown',
				text: extractMessageText(msg)
			}))
	);

	// Handle restore from timeline
	async function handleTimelineRestore(messageId: string | undefined, messageTimestamp: string) {
		if (!messageId) {
			addNotification({
				type: 'error',
				title: 'Restore Failed',
				message: 'Message ID not found',
				duration: 3000
			});
			return;
		}

		try {
			// Send restore request via WebSocket HTTP
			await ws.http('snapshot:restore', {
				messageId: messageId,
				sessionId: sessionState.currentSession?.id || ''
			});

			// Close modal
			showCheckpoints = false;

			// Reload messages from database to update UI
			if (sessionState.currentSession?.id) {
				await loadMessagesForSession(sessionState.currentSession.id);
			}

			addNotification({
				type: 'success',
				title: 'Project Restored',
				message: `Successfully restored to checkpoint at ${new Date(messageTimestamp).toLocaleTimeString()}`,
				duration: 5000
			});
		} catch (error) {
			debug.error('chat', 'Restore error:', error);
			addNotification({
				type: 'error',
				title: 'Restore Failed',
				message: error instanceof Error ? error.message : 'Unknown error',
				duration: 5000
			});
		}
	}

	async function startNewChat() {
		if (!hasActiveProject || !projectState.currentProject) {
			addNotification({
				type: 'warning',
				title: 'No Project Selected',
				message: 'Please select a project first',
				duration: 3000
			});
			return;
		}

		// Clear edit mode if active
		if (editModeState.isEditing) {
			cancelEdit();
		}

		// Reset frontend state without killing the backend stream
		// The old session's stream continues running in the background
		if (appState.isLoading) {
			chatService.resetForSessionSwitch();
		}

		// Clear server input state and prevent stale restore on ChatInput remount
		setSkipNextRestore(true);
		const currentUserId = userStore.currentUser?.id;
		const currentChatSessionId = sessionState.currentSession?.id;
		if (currentUserId && currentChatSessionId) {
			ws.emit('chat:input-sync', {
				text: '',
				senderId: currentUserId,
				chatSessionId: currentChatSessionId,
				attachments: []
			});
		}

		// Clear messages for local view
		clearMessages();

		// Create a new session (existing sessions stay active for other users)
		const newSession = await createNewChatSession(projectState.currentProject.id);

		if (newSession) {
			await setCurrentSession(newSession);
		} else {
			addNotification({
				type: 'error',
				title: 'Failed to Create Session',
				message: 'Could not create a new chat session',
				duration: 3000
			});
		}
	}

	// Check for active stream on mount only if needed
	onMount(async () => {
		debug.log('chat', 'Component mounted');
		// WebSocket reconnection is handled automatically by ws client
	});

	// Export actions for DesktopPanel header
	export const panelActions = {
		checkpoints: openCheckpoints,
		newChat: startNewChat,
		hasMessages: () => sessionState.messages.length > 0
	};
</script>

<div class="h-full flex flex-col bg-transparent">
	{#if !hasActiveProject}
		<div
			class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600 dark:text-slate-500 text-sm"
		>
			<Icon name="lucide:bot" class="w-10 h-10 opacity-30" />
			<span>No project selected</span>
		</div>
	{:else}
		<div class="flex-1 flex flex-col overflow-hidden {showMobileHeader ? '' : '-m-3'}">
			{#if isWelcomeState && !appState.isRestoring}
				<!-- Welcome state with modern design -->
				<div class="flex-1 overflow-y-auto overflow-x-hidden">
					<div class="min-h-full flex items-center justify-center p-4">
						<div class="w-full max-w-4xl space-y-6 md:space-y-8 lg:space-y-10">
							<!-- Modern hero section -->
							<div class="text-center space-y-3 md:space-y-4 px-6">
								<div class="space-y-3 md:space-y-4">
									<h1 class="text-3xl md:text-4xl font-semibold text-slate-900 dark:text-slate-100">
										Build apps & websites with AI
									</h1>
									<p class="md:text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
										Describe your idea. Get production-ready code.
									</p>
								</div>
							</div>

							<!-- Input area integrated in welcome state -->
							{#if showInput}
								<div class="w-full px-4 space-y-4" in:fade={{ duration: 200, delay: 100 }}>
									<ChatInput />
								</div>
							{/if}
						</div>
					</div>
				</div>
			{:else}
				<!-- Enhanced chat interface: Rate Limit banner + Task Progress docked above chat -->
				<div class="flex-1 flex flex-col overflow-hidden">
					{#if sessionState.currentSession}
						<RateLimitBanner />
						<TaskProgress />
					{/if}
					<div class="flex-1 flex justify-center overflow-hidden">
						<div class="w-full flex flex-col overflow-hidden">
							<div class="wrap-anywhere flex-1 overflow-y-auto overflow-x-hidden">
								<ChatMessages {scrollContainer} />
							</div>
						</div>
					</div>
				</div>

				<!-- Input area with SDK integration -->
				{#if showInput}
					<div
						class="sticky bottom-0 flex-shrink-0 bg-gradient-to-t from-slate-50 via-slate-50 dark:from-slate-900 dark:via-slate-900 to-transparent"
						in:fade={{ duration: 200, delay: 100 }}
					>
						<div class="flex justify-center">
							<div class="w-full max-w-5xl px-4 pb-4 pt-2">
								<ChatInput />
							</div>
						</div>
					</div>
				{/if}
			{/if}
		</div>

		<!-- Checkpoint Modal -->
		<TimelineModal
			bind:isOpen={showCheckpoints}
			onClose={closeCheckpoints}
		/>
	{/if}
</div>

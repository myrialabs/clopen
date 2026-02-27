<!--
  Modern Claude Code SDK Chat Interface
  
  Features:
  - Real-time streaming with Server-Sent Events
  - Modern AI-first design with solid backgrounds
  - Proper SDK message handling
  - Enhanced error handling and user feedback
  - Responsive design with mobile optimization
-->

<script lang="ts">
	import { sessionState, setCurrentSession, createNewChatSession, clearMessages, loadMessagesForSession } from '$frontend/lib/stores/core/sessions.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { appState } from '$frontend/lib/stores/core/app.svelte';
	import { presenceState } from '$frontend/lib/stores/core/presence.svelte';
	import { userStore } from '$frontend/lib/stores/features/user.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import ChatMessages from './message/ChatMessages.svelte';
	import ChatInput from './input/ChatInput.svelte';
	import FloatingTodoList from './widgets/FloatingTodoList.svelte';
	import TimelineModal from '$frontend/lib/components/checkpoint/TimelineModal.svelte';
	// import TokenUsage from './widgets/TokenUsage.svelte'; // DISABLED
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import AvatarBubble from '$frontend/lib/components/common/AvatarBubble.svelte';
	import Button from '$frontend/lib/components/common/Button.svelte';
	import PageTemplate from '$frontend/lib/components/common/PageTemplate.svelte';
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { ChatSession } from '$shared/types/database/schema';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/lib/utils/ws';

	// Welcome state - don't show during restoration
	const isWelcomeState = $derived(
		sessionState.messages.length === 0 &&
		!appState.isRestoring
	);

	// Check if we should show input (not during restoration)
	const showInput = $derived(!appState.isRestoring);
	
	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectName = $derived(projectState.currentProject?.name || 'No Project');

	// Dynamic title for PageTemplate (static description)
	const pageTitle = $derived(hasActiveProject ? `${projectName}` : 'No project selected');

	// Scroll container for passing to PageTemplate
	let scrollContainer: HTMLElement | undefined = $state();

	// Session picker state
	let showSessionPicker = $state(false);

	// Active sessions for the current project (non-ended), sorted newest first
	const activeSessions = $derived(
		sessionState.sessions
			.filter(s => s.project_id === projectState.currentProject?.id && !s.ended_at)
			.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
	);

	// Check if another session has an active stream (for badge indicator)
	const otherSessionsStreaming = $derived.by(() => {
		const projectId = projectState.currentProject?.id;
		const currentSessionId = sessionState.currentSession?.id;
		if (!projectId) return false;
		const status = presenceState.statuses.get(projectId);
		if (!status?.streams) return false;
		return status.streams.some(
			(s: any) => s.status === 'active' && s.chatSessionId !== currentSessionId
		);
	});

	// Get users in a specific chat session (excluding self)
	function getSessionUsers(chatSessionId: string): { userId: string; userName: string }[] {
		const projectId = projectState.currentProject?.id;
		const currentUserId = userStore.currentUser?.id;
		if (!projectId) return [];
		const status = presenceState.statuses.get(projectId);
		if (!status?.chatSessionUsers) return [];
		const users = status.chatSessionUsers[chatSessionId] || [];
		return currentUserId ? users.filter(u => u.userId !== currentUserId) : users;
	}

	function toggleSessionPicker() {
		showSessionPicker = !showSessionPicker;
	}

	function closeSessionPicker() {
		showSessionPicker = false;
	}

	async function switchToSession(session: ChatSession) {
		if (session.id === sessionState.currentSession?.id) {
			closeSessionPicker();
			return;
		}
		await setCurrentSession(session);
		closeSessionPicker();
	}

	// Extract short title from session (first user message text)
	function getSessionShortTitle(session: ChatSession): string {
		return session.title?.replace(/^Shared Chat - /, '').slice(0, 40) || 'New Chat';
	}

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
				id: msg.metadata?.message_id,
				timestamp: msg.metadata?.created_at || '',
				date: msg.metadata?.created_at ? new Date(msg.metadata.created_at).toLocaleDateString() : 'Unknown',
				time: msg.metadata?.created_at ? new Date(msg.metadata.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Unknown',
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

		// Clear messages for the local view
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
</script>

<PageTemplate 
	title={pageTitle}
	description="AI-powered development assistant"
	bind:scrollContainer
>
	{#snippet actions()}
		<div class="flex items-center space-x-2">
			<!-- Session Picker (only when multiple active sessions) -->
			{#if activeSessions.length > 1}
				<div class="relative">
					<button
						onclick={toggleSessionPicker}
						class="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-violet-500 dark:hover:border-violet-500 transition-all duration-200"
					>
						<Icon name="lucide:layers" class="w-3.5 h-3.5" />
						<span class="hidden sm:inline max-w-[120px] truncate">{activeSessions.length} sessions</span>
						{#if otherSessionsStreaming}
							<span class="w-2 h-2 rounded-full bg-violet-500 animate-pulse"></span>
						{/if}
						<Icon name="lucide:chevron-down" class="w-3 h-3" />
					</button>

					{#if showSessionPicker}
						<!-- Backdrop -->
						<div class="fixed inset-0 z-40" onclick={closeSessionPicker}></div>

						<!-- Dropdown -->
						<div class="absolute top-full right-0 mt-1 z-50 w-72 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-hidden">
							<div class="px-3 py-2 border-b border-slate-100 dark:border-slate-700">
								<p class="text-xs font-medium text-slate-500 dark:text-slate-400">Active Sessions</p>
							</div>
							<div class="max-h-64 overflow-y-auto">
								{#each activeSessions as session (session.id)}
									{@const isCurrent = session.id === sessionState.currentSession?.id}
									{@const projectId = projectState.currentProject?.id}
									{@const status = projectId ? presenceState.statuses.get(projectId) : undefined}
									{@const isStreaming = status?.streams?.some((s: any) => s.status === 'active' && s.chatSessionId === session.id) ?? false}
									{@const sessionUsers = getSessionUsers(session.id)}
									{@const sessionModel = session.model ? (session.model.includes(':') ? session.model.split(':')[1] : session.model) : ''}
									<button
										onclick={() => switchToSession(session)}
										class="w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors duration-150
											{isCurrent
												? 'bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-300'
												: 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}"
									>
										<div class="flex-1 min-w-0">
											<div class="flex items-center gap-1.5">
												<span class="w-1.5 h-1.5 rounded-full shrink-0 {isStreaming ? 'bg-emerald-500 animate-pulse' : isCurrent ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'}"></span>
												<span class="text-sm font-medium truncate">{getSessionShortTitle(session)}</span>
											</div>
											<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
												{new Date(session.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
												{#if sessionModel}
													<span class="text-slate-400 dark:text-slate-500">· {sessionModel}</span>
												{/if}
											</p>
										</div>
										{#if sessionUsers.length > 0}
											<div class="flex items-center -space-x-1 shrink-0">
												{#each sessionUsers.slice(0, 2) as user}
													<AvatarBubble {user} size="sm" />
												{/each}
												{#if sessionUsers.length > 2}
													<span class="w-4 h-4 rounded-full bg-slate-400 text-white text-5xs font-bold flex items-center justify-center border border-white dark:border-slate-800">
														+{sessionUsers.length - 2}
													</span>
												{/if}
											</div>
										{/if}
										{#if isStreaming}
											<span class="shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-3xs font-medium rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400">
												<span class="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse"></span>
												AI
											</span>
										{/if}
									</button>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<!-- Restore Checkpoint button -->
			{#if sessionState.messages.length > 0}
				<Button variant="outline" onclick={openCheckpoints} class="rounded-lg px-2 sm:px-4 py-1.5 sm:py-2">
					<Icon name="lucide:undo-2" class="w-3.5 h-3.5 sm:w-4 sm:h-4 sm:mr-2" />
					<span class="hidden sm:inline">Restore</span>
				</Button>
			{/if}

			<!-- New Chat button -->
			<Button variant="outline" onclick={startNewChat} class="rounded-lg px-2 sm:px-4 py-1.5 sm:py-2">
				<Icon name="lucide:plus" class="w-3.5 h-3.5 sm:w-4 sm:h-4 sm:mr-2" />
				<span class="hidden sm:inline">New Chat</span>
			</Button>
		</div>
	{/snippet}

	<div class="flex flex-col h-[calc(100%+3rem)] -my-6 -mx-4">
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
			<!-- Enhanced chat interface -->
			<div class="flex-1 flex flex-col overflow-hidden">
				<div class="flex-1 flex justify-center overflow-hidden">
					<div class="w-full flex flex-col overflow-hidden">
						<div class="flex-1 overflow-y-auto overflow-x-hidden">
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

	<!-- Floating TodoList (only shown when there's an active session with todos) -->
	{#if sessionState.currentSession}
		<FloatingTodoList />
	{/if}

	<!-- Checkpoint Timeline Modal -->
	<TimelineModal
		bind:isOpen={showCheckpoints}
		onClose={closeCheckpoints}
	/>
</PageTemplate>
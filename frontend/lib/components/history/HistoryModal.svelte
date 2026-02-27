<script lang="ts">
	import { untrack } from 'svelte';
	import { sessionState, setCurrentSession, removeSession, reloadSessionsForProject } from '$frontend/lib/stores/core/sessions.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import ws from '$frontend/lib/utils/ws';
	import type { ChatSession } from '$shared/types/database/schema';
	import type { SDKMessage } from '$shared/types/messaging';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import AvatarBubble from '$frontend/lib/components/common/AvatarBubble.svelte';
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import Dialog from '$frontend/lib/components/common/Dialog.svelte';
	import { presenceState } from '$frontend/lib/stores/core/presence.svelte';
	import { userStore } from '$frontend/lib/stores/features/user.svelte';
	import { debug } from '$shared/utils/logger';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	// Use real session data from session store - filtered by current project
	const sessions = $derived(
		sessionState.sessions.filter(s => s.project_id === projectState.currentProject?.id)
	);

	// Helper to get relative time (last active)
	function getRelativeTime(dateString: string): string {
		const now = Date.now();
		const date = new Date(dateString).getTime();
		const diffMs = now - date;
		const diffMins = Math.floor(diffMs / 1000 / 60);
		const diffHours = Math.floor(diffMins / 60);
		const diffDays = Math.floor(diffHours / 24);

		if (diffMins < 1) return 'Just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;
		if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
		if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
		return `${Math.floor(diffDays / 365)}y ago`;
	}

	// Helper to get last activity timestamp
	function getLastActive(session: ChatSession): string {
		const timestamp = session.ended_at && session.ended_at !== ''
			? session.ended_at
			: session.started_at;
		return getRelativeTime(timestamp);
	}

	// Cache for session data to avoid multiple API calls
	let sessionDataCache = $state<Record<string, {
		messages: SDKMessage[];
		title: string;
		summary: string;
		count: number;
		userCount: number;
		assistantCount: number;
	}>>({});
	let loadingSessionData = $state(false);

	// Helper to get session data from cache or API
	async function getSessionData(sessionId: string) {
		if (sessionDataCache[sessionId]) {
			return sessionDataCache[sessionId];
		}

		try {
			const messages = await ws.http('messages:list', { session_id: sessionId });

			const firstUserMessage = messages.find((m: SDKMessage) => m.type === 'user');
			let title = 'New Conversation';
			if (firstUserMessage) {
				let textContent = '';
				if (typeof firstUserMessage.message.content === 'string') {
					textContent = firstUserMessage.message.content;
				} else if (Array.isArray(firstUserMessage.message.content)) {
					const textBlocks = firstUserMessage.message.content.filter((c: any) => c.type === 'text');
					textContent = textBlocks.map((b: any) => 'text' in b ? b.text : '').join(' ');
				}

				if (textContent) {
					title = textContent.slice(0, 60) + (textContent.length > 60 ? '...' : '');
				}
			}

			const assistantMessages = messages.filter((m: SDKMessage) => m.type === 'assistant');
			let summary = 'No messages yet';
			if (assistantMessages.length > 0) {
				const lastMessage = assistantMessages[assistantMessages.length - 1];
				const textBlocks = lastMessage.message.content.filter((c: any) => c.type === 'text');
				if (textBlocks.length > 0) {
					const fullText = textBlocks.map((b: any) => 'text' in b ? b.text : '').join(' ');
					const cleanText = fullText.replace(/```[\s\S]*?```/g, '').trim();
					summary = cleanText.slice(0, 100) + (cleanText.length > 100 ? '...' : '');
				}
			}

			const userMessages = messages.filter((m: SDKMessage) => {
				if (m.type !== 'user') return false;
				let textContent = '';
				if (typeof m.message.content === 'string') {
					textContent = m.message.content;
				} else if (Array.isArray(m.message.content)) {
					const textBlocks = m.message.content.filter(c => c.type === 'text');
					textContent = textBlocks.map(b => 'text' in b ? b.text : '').join(' ');
				}
				return textContent.trim().length > 0;
			});

			const totalBubbles = userMessages.length + assistantMessages.length;

			const data = {
				messages,
				title,
				summary,
				count: totalBubbles,
				userCount: userMessages.length,
				assistantCount: assistantMessages.length
			};

			sessionDataCache[sessionId] = data;
			debug.log('session', `Loaded session ${sessionId}:`, {
				title,
				totalMessages: messages.length,
				userCount: userMessages.length,
				assistantCount: assistantMessages.length,
				totalBubbles: totalBubbles,
				summary: summary.substring(0, 50)
			});
			return data;
		} catch (error) {
			debug.error('session', 'Error fetching session data:', error);
			return {
				messages: [],
				title: 'New Conversation',
				summary: 'No messages yet',
				count: 0,
				userCount: 0,
				assistantCount: 0
			};
		}
	}

	function getMessageCount(sessionId: string): number {
		return sessionDataCache[sessionId]?.count || 0;
	}

	function getUserMessageCount(sessionId: string): number {
		return sessionDataCache[sessionId]?.userCount || 0;
	}

	function getSessionTitle(sessionId: string): string {
		return sessionDataCache[sessionId]?.title || 'New Conversation';
	}

	function getSessionSummary(sessionId: string): string {
		return sessionDataCache[sessionId]?.summary || 'No messages yet';
	}

	async function preloadSessionData() {
		loadingSessionData = true;
		try {
			// Sort newest first and load top 20 so new sessions are always included
			const sortedSessions = [...sessions]
				.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
				.slice(0, 20);
			await Promise.all(
				sortedSessions.map(session => getSessionData(session.id))
			);
		} catch (error) {
			debug.error('session', 'Error preloading session data:', error);
		} finally {
			loadingSessionData = false;
		}
	}

	// Refresh sessions from server and reload data each time the modal opens.
	// Uses untrack() so only isOpen is tracked — prevents infinite loops from
	// session/cache mutations re-triggering this effect.
	$effect(() => {
		if (isOpen) {
			untrack(() => {
				// Clear stale cache so all data is fetched fresh
				sessionDataCache = {};
				// Fetch latest sessions from server, then load message data
				reloadSessionsForProject().then(() => {
					preloadSessionData();
				});
			});
		}
	});

	// Incrementally load new sessions that arrive while the modal is open
	// (e.g., from sessions:session-available broadcasts). No spinner — background load.
	$effect(() => {
		if (!isOpen || loadingSessionData) return;
		const currentSessions = sessions;
		if (currentSessions.length === 0) return;

		const uncached = currentSessions.filter(s => !sessionDataCache[s.id]);
		if (uncached.length > 0) {
			debug.log('session', `Found ${uncached.length} new sessions, loading data...`);
			// Load individually without showing spinner
			Promise.all(uncached.map(s => getSessionData(s.id)));
		}
	});

	// Track streaming sessions to detect when a stream completes.
	// When a session stops streaming, refresh its cache to show the new summary.
	let previouslyStreamingIds = new Set<string>();

	$effect(() => {
		if (!isOpen) return;

		// Read presence state to detect stream changes
		const projectId = projectState.currentProject?.id;
		if (!projectId) return;
		const status = presenceState.statuses.get(projectId);
		const activeStreams = status?.streams?.filter((s: any) => s.status === 'active') || [];
		const currentlyStreamingIds = new Set(activeStreams.map((s: any) => s.chatSessionId));

		// Sessions that stopped streaming → refresh their cache for updated summary
		for (const sessionId of previouslyStreamingIds) {
			if (!currentlyStreamingIds.has(sessionId)) {
				delete sessionDataCache[sessionId];
				getSessionData(sessionId);
			}
		}

		previouslyStreamingIds = currentlyStreamingIds;
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

	// Check if a session has an active stream
	function isSessionStreaming(chatSessionId: string): boolean {
		const projectId = projectState.currentProject?.id;
		if (!projectId) return false;
		const status = presenceState.statuses.get(projectId);
		if (!status?.streams) return false;
		return status.streams.some(
			(s: any) => s.status === 'active' && s.chatSessionId === chatSessionId
		);
	}

	// Get the engine/model display for a session
	function getSessionModel(session: ChatSession): string {
		if (session.engine && session.model) {
			const parts = session.model.split(':');
			return parts.length > 1 ? parts[1] : session.model;
		}
		return '';
	}

	let searchQuery = $state('');

	const filteredSessions = $derived(
		sessions
			.filter(session => {
				const title = getSessionTitle(session.id);
				const summary = getSessionSummary(session.id);
				const messageCount = getMessageCount(session.id);

				// Show sessions that are currently streaming even if 0 messages yet
				if (messageCount === 0 && !isSessionStreaming(session.id)) {
					return false;
				}

				const matchesSearch = searchQuery === '' ||
					title.toLowerCase().includes(searchQuery.toLowerCase()) ||
					summary.toLowerCase().includes(searchQuery.toLowerCase());

				return matchesSearch;
			})
			.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
	);

	function isActiveSession(session: ChatSession): boolean {
		return sessionState.currentSession?.id === session.id;
	}

	async function resumeSession(session: ChatSession | null) {
		if (!session) return;

		try {
			let targetSession = session;
			if (session.ended_at) {
				const reactivatedSession = await ws.http('sessions:update', { id: session.id, reactivate: true });
				if (reactivatedSession) {
					const sessionIndex = sessionState.sessions.findIndex(s => s.id === session.id);
					if (sessionIndex !== -1) {
						sessionState.sessions[sessionIndex] = reactivatedSession;
					}
					targetSession = reactivatedSession;
				}
			}

			await setCurrentSession(targetSession);
			onClose();
		} catch (error) {
			debug.error('session', 'Error resuming session:', error);
			addNotification({
				type: 'error',
				title: 'Resume Failed',
				message: 'Failed to resume session',
				duration: 5000
			});
		}
	}

	// Delete session state
	let showDeleteDialog = $state(false);
	let sessionToDelete = $state<ChatSession | null>(null);

	function handleDeleteClick(session: ChatSession, event: MouseEvent) {
		event.stopPropagation();
		sessionToDelete = session;
		showDeleteDialog = true;
	}

	async function confirmDeleteSession() {
		if (!sessionToDelete) return;
		const deleteId = sessionToDelete.id;

		try {
			await ws.http('sessions:delete', { id: deleteId });
			removeSession(deleteId);

			// Clean cache
			delete sessionDataCache[deleteId];

			addNotification({
				type: 'success',
				title: 'Session Deleted',
				message: 'Chat session has been deleted',
				duration: 3000
			});

			showDeleteDialog = false;
			sessionToDelete = null;
		} catch (error) {
			debug.error('session', 'Failed to delete session:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'Failed to delete session',
				duration: 5000
			});
		}
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		sessionToDelete = null;
	}

	function closeModal() {
		searchQuery = '';
		onClose();
	}
</script>

<Modal bind:isOpen onClose={closeModal} size="md">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<h2 class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">Sessions</h2>
			<button
				type="button"
				class="p-1.5 md:p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors"
				onclick={closeModal}
				aria-label="Close modal"
			>
				<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M6 18L18 6M6 6l12 12"
					/>
				</svg>
			</button>
		</div>
	{/snippet}

	{#snippet children()}
		<!-- Search Box -->
		{#if sessions.length > 0}
			<div class="mb-4">
				<div
					class="flex items-center gap-2 py-2.5 px-3.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg"
				>
					<Icon name="lucide:search" class="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Search sessions..."
						class="flex-1 bg-transparent border-none outline-none text-slate-900 dark:text-slate-100 text-sm placeholder:text-slate-500 dark:placeholder:text-slate-400"
					/>
					{#if searchQuery}
						<button
							type="button"
							class="flex items-center justify-center w-5 h-5 bg-transparent border-none rounded text-slate-400 cursor-pointer transition-all duration-150 hover:text-slate-600 dark:hover:text-slate-300"
							onclick={() => (searchQuery = '')}
							aria-label="Clear search"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Sessions List -->
		{#if loadingSessionData}
			<div class="flex items-center justify-center gap-3 py-12">
				<div class="animate-spin rounded-full h-6 w-6 border-b-2 border-violet-600"></div>
				<span class="text-sm text-slate-600 dark:text-slate-400">Loading sessions...</span>
			</div>
		{:else if filteredSessions.length === 0}
			<div class="flex flex-col items-center gap-3 py-8 text-slate-600 dark:text-slate-500 text-sm">
				<Icon name="lucide:message-square-off" class="w-12 h-12 text-slate-400 opacity-40" />
				<p class="font-medium">No sessions found</p>
				<p class="text-xs text-slate-500 dark:text-slate-500">
					{searchQuery ? 'Try adjusting your search' : 'Start a new chat to see it here'}
				</p>
				{#if searchQuery}
					<button
						type="button"
						class="text-xs text-violet-600 dark:text-violet-400 underline cursor-pointer hover:text-violet-700 dark:hover:text-violet-300"
						onclick={() => (searchQuery = '')}
					>
						Clear search
					</button>
				{/if}
			</div>
		{:else}
			<div class="space-y-2">
				{#each filteredSessions.slice(0, 20) as session (session.id)}
					{@const isActive = isActiveSession(session)}
					{@const sessionUsers = getSessionUsers(session.id)}
					{@const streaming = isSessionStreaming(session.id)}
					{@const modelName = getSessionModel(session)}
					<div
						class="flex items-center gap-2 w-full p-3 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 text-sm text-left transition-all duration-150
							{isActive
							? 'border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/10'
							: ''}"
					>
						<button
							type="button"
							class="flex items-center gap-3 flex-1 min-w-0 bg-transparent border-none cursor-pointer text-left"
							onclick={() => resumeSession(session)}
						>
							<div
								class="relative w-8 h-8 {isActive
									? 'bg-violet-200 dark:bg-violet-800/30'
									: 'bg-violet-100 dark:bg-violet-900/20'} rounded-lg flex items-center justify-center flex-shrink-0"
							>
								<Icon name="lucide:message-square" class="text-violet-600 dark:text-violet-400 w-4 h-4" />
								{#if streaming}
									<span
										class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 bg-emerald-500"
									></span>
								{:else}
									<span
										class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 bg-slate-300 dark:bg-slate-600"
									></span>
								{/if}
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<p class="font-semibold text-slate-900 dark:text-slate-100 truncate text-sm">
										{getSessionTitle(session.id)}
									</p>
									{#if isActive}
										<span
											class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-xs font-medium rounded-full shrink-0"
										>
											<Icon name="lucide:circle-check" class="w-3 h-3" />
											Active
										</span>
									{/if}
								</div>
								<div class="flex items-center gap-2 mt-0.5 text-xs text-slate-500 dark:text-slate-400">
									<span class="flex items-center gap-1 flex-none">
										<Icon name="lucide:messages-square" class="w-3 h-3" />
										{getUserMessageCount(session.id)}
									</span>
									<span>·</span>
									<span class="flex items-center gap-1 flex-none">
										<Icon name="lucide:clock" class="w-3 h-3" />
										{getLastActive(session)}
									</span>
									{#if modelName}
										<span>·</span>
										<span class="truncate">{modelName}</span>
									{/if}
								</div>
								{#if streaming}
								<p class="text-xs text-violet-500 dark:text-violet-400 mt-0.5 flex items-center gap-1.5">
									<span class="inline-block w-3 h-3 border-2 border-violet-400 border-t-transparent rounded-full animate-spin shrink-0"></span>
									Processing...
								</p>
							{:else}
								<p class="text-xs text-slate-400 dark:text-slate-500 truncate mt-0.5">
									{getSessionSummary(session.id)}
								</p>
							{/if}
							</div>
						</button>
						{#if sessionUsers.length > 0}
							<div class="flex items-center -space-x-1 shrink-0">
								{#each sessionUsers.slice(0, 2) as user}
									<AvatarBubble {user} size="sm" />
								{/each}
								{#if sessionUsers.length > 2}
									<span class="w-5 h-5 rounded-full bg-gradient-to-br from-slate-500 to-slate-600 text-white text-4xs font-bold flex items-center justify-center border-2 border-white dark:border-slate-900 z-10">
										+{sessionUsers.length - 2}
									</span>
								{/if}
							</div>
						{/if}
						<button
							type="button"
							class="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-lg text-slate-400 dark:text-slate-500 cursor-pointer transition-all duration-150 hover:bg-red-500/15 hover:text-red-500 shrink-0"
							onclick={(e) => handleDeleteClick(session, e)}
							aria-label="Delete session"
							title="Delete"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}
</Modal>

<!-- Delete Confirmation Dialog -->
<Dialog
	bind:isOpen={showDeleteDialog}
	onClose={closeDeleteDialog}
	type="error"
	title="Delete Session"
	message="Are you sure you want to delete this session? All messages will be permanently removed."
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={confirmDeleteSession}
/>

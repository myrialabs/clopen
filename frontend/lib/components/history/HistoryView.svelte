<script lang="ts">
	import { onMount } from 'svelte';
	import { sessionState, removeSession, setCurrentSession } from '$frontend/lib/stores/core/sessions.svelte';
	import { projectState, setCurrentProject } from '$frontend/lib/stores/core/projects.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import { setCurrentView } from '$frontend/lib/stores/core/app.svelte';
	import ws from '$frontend/lib/utils/ws';
	import type { ChatSession, Project } from '$shared/types/database/schema';
	import type { SDKMessage } from '$shared/types/messaging';
	import Input from '../common/Input.svelte';
	import Select from '../common/Select.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import PageTemplate from '../common/PageTemplate.svelte';
	import Button from '../common/Button.svelte';
	import { showConfirm } from '$frontend/lib/stores/ui/dialog.svelte';
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import TimelineModal from '../checkpoint/TimelineModal.svelte';
	import { debug } from '$shared/utils/logger';

	// Use real session data from session store
	const sessions = $derived(sessionState.sessions);
	
	// Helper to get project name from project ID
	function getProjectName(projectId: string): string {
		const project = projectState.projects.find(p => p.id === projectId);
		return project?.name || 'Unknown Project';
	}
	
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
		// Use ended_at if available, otherwise use started_at
		const timestamp = session.ended_at && session.ended_at !== ''
			? session.ended_at
			: session.started_at;
		return getRelativeTime(timestamp);
	}
	
	// Helper to calculate session duration in minutes
	function getSessionDuration(session: ChatSession): number {
		const start = new Date(session.started_at).getTime();
		const end = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
		return Math.round((end - start) / 1000 / 60);
	}
	
	// Cache for session data to avoid multiple API calls
	const sessionDataCache = $state<Record<string, {
		messages: SDKMessage[];
		title: string;
		summary: string;
		count: number;
		userCount: number;
		assistantCount: number;
	}>>({});
	let loadingSessionData = $state(true);

	// Helper to get session data from cache or API
	async function getSessionData(sessionId: string) {
		if (sessionDataCache[sessionId]) {
			return sessionDataCache[sessionId];
		}

		try {
			// Get messages from current HEAD checkpoint (active branch only)
			const messages = await ws.http('messages:list', { session_id: sessionId });

			// Get title from first user message in current HEAD
			const firstUserMessage = messages.find((m: SDKMessage) => m.type === 'user');
			let title = 'New Conversation';
			if (firstUserMessage) {
				// Handle content properly - it can be string or array of content blocks
				let textContent = '';
				if (typeof firstUserMessage.message.content === 'string') {
					textContent = firstUserMessage.message.content;
				} else if (Array.isArray(firstUserMessage.message.content)) {
					// Extract text from content blocks
					const textBlocks = firstUserMessage.message.content.filter((c: any) => c.type === 'text');
					textContent = textBlocks.map((b: any) => 'text' in b ? b.text : '').join(' ');
				}

				if (textContent) {
					title = textContent.slice(0, 60) + (textContent.length > 60 ? '...' : '');
				}
			}

			// Get summary from last assistant message in current HEAD checkpoint
			const assistantMessages = messages.filter((m: SDKMessage) => m.type === 'assistant');
			let summary = 'No messages yet';
			if (assistantMessages.length > 0) {
				const lastMessage = assistantMessages[assistantMessages.length - 1];
				const textBlocks = lastMessage.message.content.filter((c: any) => c.type === 'text');
				if (textBlocks.length > 0) {
					const fullText = textBlocks.map((b: any) => 'text' in b ? b.text : '').join(' ');
					const cleanText = fullText.replace(/```[\s\S]*?```/g, '').trim();
					summary = cleanText.slice(0, 150) + (cleanText.length > 150 ? '...' : '');
				}
			}

			// Count user and assistant messages in current HEAD checkpoint
			// Filter out empty user messages (same as ChatInterface.svelte timeline logic)
			const userMessages = messages.filter((m: SDKMessage) => {
				if (m.type !== 'user') return false;
				// Extract text content
				let textContent = '';
				if (typeof m.message.content === 'string') {
					textContent = m.message.content;
				} else if (Array.isArray(m.message.content)) {
					const textBlocks = m.message.content.filter(c => c.type === 'text');
					textContent = textBlocks.map(b => 'text' in b ? b.text : '').join(' ');
				}
				return textContent.trim().length > 0;
			});

			const totalBubbles = userMessages.length + assistantMessages.length; // Total message bubbles in chat

			const data = {
				messages,
				title,
				summary,
				count: totalBubbles, // Total bubbles (user + assistant with non-empty content)
				userCount: userMessages.length, // Number of chat sessions/exchanges (non-empty user messages)
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

	// Helper functions that use cached data
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

	// Preload session data for visible sessions
	async function preloadSessionData() {
		loadingSessionData = true;
		try {
			// Load all sessions in parallel for better performance
			await Promise.all(
				sessions.slice(0, 20).map(session => getSessionData(session.id))
			);
		} catch (error) {
			debug.error('session', 'Error preloading session data:', error);
		} finally {
			loadingSessionData = false;
		}
	}

	// Initialize session data on mount
	onMount(() => {
		preloadSessionData();
	});

	// Reload session data when sessions change
	$effect(() => {
		if (sessions.length > 0 && !loadingSessionData) {
			// Check if there are sessions without cached data
			const uncachedSessions = sessions.filter(s => !sessionDataCache[s.id]);
			if (uncachedSessions.length > 0) {
				debug.log('session', `Found ${uncachedSessions.length} uncached sessions, loading...`);
				preloadSessionData();
			}
		}
	});
	
	let searchQuery = $state('');
	let projectFilter = $state('all');
	let showTimelineModal = $state(false);
	let timelineSession = $state<ChatSession | null>(null);

	function openTimelineModal(session: ChatSession) {
		timelineSession = session;
		showTimelineModal = true;
	}

	function closeTimelineModal() {
		timelineSession = null;
		showTimelineModal = false;
	}
	
	// Get unique projects
	const projects = $derived(
		Array.from(new Set(sessions.map(s => getProjectName(s.project_id))))
	);
	
	// Filtered sessions (sorted newest first)
	const filteredSessions = $derived(
		sessions
			.filter(session => {
				const title = getSessionTitle(session.id);
				const summary = getSessionSummary(session.id);
				const projectName = getProjectName(session.project_id);
				const messageCount = getMessageCount(session.id);

				// Filter out sessions with 0 messages
				if (messageCount === 0) {
					return false;
				}

				const matchesSearch = searchQuery === '' ||
					title.toLowerCase().includes(searchQuery.toLowerCase()) ||
					summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
					projectName.toLowerCase().includes(searchQuery.toLowerCase());

				const matchesProject = projectFilter === 'all' || projectName === projectFilter;

				return matchesSearch && matchesProject;
			})
			.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
	);
	
	// Session stats (only count sessions with messages)
	const sessionsWithMessages = $derived(sessions.filter(s => getMessageCount(s.id) > 0));

	const stats = $derived({
		totalSessions: sessionsWithMessages.length,
		totalChats: sessionsWithMessages.reduce((sum, s) => sum + getUserMessageCount(s.id), 0),
		totalMessages: sessionsWithMessages.reduce((sum, s) => sum + getMessageCount(s.id), 0),
		totalDuration: sessionsWithMessages.reduce((sum, s) => sum + getSessionDuration(s), 0)
	});
	
	function formatDuration(minutes: number): string {
		const hours = Math.floor(minutes / 60);
		const mins = minutes % 60;
		if (hours > 0) {
			return `${hours}h ${mins}m`;
		}
		return `${mins}m`;
	}
	
	function formatDate(dateString: string): string {
		return new Date(dateString).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	// Helper to check if session is currently active
	function isActiveSession(session: ChatSession): boolean {
		return sessionState.currentSession?.id === session.id;
	}
	
	async function resumeSession(session: ChatSession | null) {
		if (!session) return;

		const sessionData = await getSessionData(session.id);
		const title = sessionData.title;
		const projectName = getProjectName(session.project_id);

		const confirmed = await showConfirm({
			title: 'Resume Session',
			message: `Resume session "${title}" from project "${projectName}"?\n\nThis will load the conversation and navigate to the chat view.`,
			type: 'info',
			confirmText: 'Resume',
			cancelText: 'Cancel'
		});

		if (!confirmed) return;

		try {
			// Reactivate if ended (does NOT end other sessions — multi-session parallel)
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

			// Find the project
			const project = projectState.projects.find(p => p.id === session.project_id);
			if (project) {
				// Set current project and session
				setCurrentProject(project);
				await setCurrentSession(targetSession);
				// Navigate to chat view
				setCurrentView('chat');
			} else {
				addNotification({
					type: 'error',
					title: 'Project Not Found',
					message: 'The project for this session could not be found',
					duration: 4000
				});
			}
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
	
	async function deleteSession(session: ChatSession) {
		const sessionData = await getSessionData(session.id);
		const title = sessionData.title;
		
		const confirmed = await showConfirm({
			title: 'Delete Session',
			message: `Are you sure you want to delete session "${title}"? This action cannot be undone.`,
			type: 'error',
			confirmText: 'Delete',
			cancelText: 'Cancel'
		});
		
		if (confirmed) {
			try {
				// Delete from database via WebSocket
				await ws.http('sessions:delete', { id: session.id });
				// Remove from local state
				removeSession(session.id);
				// Clear cache
				delete sessionDataCache[session.id];
				// User already knows session was deleted from UI update
			} catch (error) {
				addNotification({
					
					type: 'error',
					title: 'Error',
					message: 'Failed to delete session',
					duration: 5000
				});
			}
		}
	}
	
	async function clearHistory() {
		const confirmed = await showConfirm({
			title: 'Clear All Session History',
			message: 'Are you sure you want to clear all session history? This will delete all sessions. This action cannot be undone.',
			type: 'error',
			confirmText: 'Clear All',
			cancelText: 'Cancel'
		});

		if (!confirmed) return;

		if (sessions.length === 0) {
			return;
		}

		try {
			// Delete all sessions from database
			const deletePromises = sessions.map(async (session) => {
				try {
					await ws.http('sessions:delete', { id: session.id });
					// Remove from local state
					removeSession(session.id);
					// Clear cache
					delete sessionDataCache[session.id];
					return { success: true };
				} catch (error) {
					debug.error('session', `Error deleting session ${session.id}:`, error);
					return { success: false, error: 'Failed to delete session' };
				}
			});

			// Wait for all deletions to complete
			const results = await Promise.all(deletePromises);

			// Check if any deletions failed
			const failed = results.filter(r => !r.success);
			if (failed.length > 0) {
				addNotification({
					type: 'warning',
					title: 'Partial Deletion',
					message: `Failed to delete ${failed.length} session(s)`,
					duration: 5000
				});
			}
		} catch (error) {
			debug.error('session', 'Error clearing history:', error);
			addNotification({
				type: 'error',
				title: 'Clear Failed',
				message: 'Failed to clear session history',
				duration: 5000
			});
		}
	}
</script>

<PageTemplate 
	title="Session History" 
	description="Previous conversation sessions"
>
	{#snippet actions()}
		<Button variant="outline" onclick={clearHistory} class="rounded-lg px-2 sm:px-4 py-1.5 sm:py-2">
			<Icon name="lucide:trash-2" class="w-3.5 h-3.5 sm:w-4 sm:h-4 sm:mr-2" />
			<span class="hidden sm:inline">Clear History</span>
		</Button>
	{/snippet}

	<div class="flex flex-col h-full gap-6">
		<!-- Modern Stats -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
			<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 transition-all duration-200">
				<div class="text-2xl font-bold text-slate-600 dark:text-slate-400">{stats.totalSessions}</div>
				<div class="text-sm text-slate-600 dark:text-slate-400 mt-1">Total Sessions</div>
			</div>
			<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 transition-all duration-200">
				<div class="text-2xl font-bold text-slate-600 dark:text-slate-400">{stats.totalChats}</div>
				<div class="text-sm text-slate-600 dark:text-slate-400 mt-1">Total Chats</div>
			</div>
			<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 transition-all duration-200">
				<div class="text-2xl font-bold text-slate-600 dark:text-slate-400">{stats.totalMessages}</div>
				<div class="text-sm text-slate-600 dark:text-slate-400 mt-1">Total Messages</div>
			</div>
			<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 transition-all duration-200">
				<div class="text-2xl font-bold text-slate-600 dark:text-slate-400">{formatDuration(stats.totalDuration)}</div>
				<div class="text-sm text-slate-600 dark:text-slate-400 mt-1">Total Duration</div>
			</div>
		</div>
		
		<!-- Modern Filters -->
		<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4">
			<div class="flex flex-col lg:flex-row gap-4">
				<!-- Search -->
				<div class="flex-1">
					<Input
						bind:value={searchQuery}
						placeholder="Search sessions by title, summary, or project..."
						type="search"
					/>
				</div>

				<!-- Modern Project Filter -->
				<Select
					bind:value={projectFilter}
					placeholder="All Projects"
					options={[
						{ value: "all", label: "All Projects" },
						...projects.map(project => ({ value: project, label: project }))
					]}
					class="bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 rounded-lg"
				/>
			</div>
		</div>
		
		<!-- Modern Sessions List -->
		<div class="flex-1 overflow-auto">
			{#if loadingSessionData}
				<div class="flex items-center justify-center py-12">
					<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-violet-600"></div>
					<span class="ml-3 text-slate-600 dark:text-slate-400">Loading session data...</span>
				</div>
			{:else if filteredSessions.length === 0}
				<div class="flex items-center justify-center h-full">
					<div class="text-center">
						<div class="bg-slate-100 dark:bg-slate-800 rounded-full w-24 h-24 flex items-center justify-center mx-auto mb-6">
							<Icon name="lucide:clock" class="w-12 h-12 text-slate-400" />
						</div>
						<h3 class="text-lg font-bold bg-gradient-to-r from-violet-600 to-violet-600 bg-clip-text text-transparent mb-2">No sessions found</h3>
						<p class="text-slate-600 dark:text-slate-400">
							{searchQuery ? 'Try adjusting your search criteria' : 'Start a new chat session to see it here'}
						</p>
					</div>
				</div>
			{:else}
				<div class="space-y-4">
					{#each filteredSessions as session (session.id)}
						<div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-6 transition-all duration-200">
							<div class="flex flex-col lg:flex-row lg:items-center gap-6">
								<!-- Session Info -->
								<div class="flex-1 space-y-2">
									<!-- Title and Badges -->
									<div class="flex flex-wrap items-center gap-2">
										<h3 class="font-bold text-violet-700 dark:text-violet-500">
											{getSessionTitle(session.id)}
										</h3>
										{#if isActiveSession(session)}
											<span class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-700">
												<Icon name="lucide:circle-check" class="w-3 h-3" />
												Active
											</span>
										{/if}
										<span class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
											<Icon name="lucide:clock" class="w-3 h-3" />
											{getLastActive(session)}
										</span>
									</div>

									<!-- Metadata - Responsive Flex Wrap -->
									<div class="flex flex-wrap gap-x-3 sm:gap-x-4 gap-y-1 text-xs sm:text-sm text-slate-600 dark:text-slate-400">
										<span class="font-semibold text-slate-600 dark:text-slate-400">
											{getProjectName(session.project_id)}
										</span>
										•
										<span class="flex items-center gap-1">
											<Icon name="lucide:calendar" class="w-3 h-3 sm:w-3.5 sm:h-3.5" />
											{formatDate(session.started_at)}
										</span>
										<span class="flex items-center gap-1" title="Chat exchanges">
											<Icon name="lucide:messages-square" class="w-3 h-3 sm:w-3.5 sm:h-3.5" />
											{getUserMessageCount(session.id)} chats
										</span>
										<span class="flex items-center gap-1" title="Total message bubbles">
											<Icon name="lucide:message-circle" class="w-3 h-3 sm:w-3.5 sm:h-3.5" />
											{getMessageCount(session.id)} msgs
										</span>
										<span class="flex items-center gap-1">
											<Icon name="lucide:timer" class="w-3 h-3 sm:w-3.5 sm:h-3.5" />
											{formatDuration(getSessionDuration(session))}
										</span>
									</div>

									<!-- Summary -->
									<p class="text-sm text-slate-600 dark:text-slate-400 line-clamp-2">
										{getSessionSummary(session.id)}
									</p>

								</div>
								
								<!-- Modern Actions -->
								<div class="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 w-full lg:w-auto">
									<button
										onclick={() => openTimelineModal(session)}
										class="flex-1 sm:flex-initial px-3 sm:px-4 py-2 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700 text-purple-700 dark:text-purple-300 rounded-lg hover:bg-purple-100 dark:hover:bg-purple-900/30 transition-all duration-200 flex items-center justify-center gap-1.5 sm:gap-2 text-xs sm:text-sm"
										title="View checkpoint timeline"
									>
										<Icon name="lucide:git-branch" class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
										<span>Timeline</span>
									</button>

									<button
										onclick={() => resumeSession(session)}
										class="flex-1 sm:flex-initial px-3 sm:px-4 py-2 bg-violet-600 dark:bg-violet-600 border border-violet-600 dark:border-violet-600 text-white rounded-lg hover:bg-violet-700 dark:hover:bg-violet-700 hover:border-violet-700 dark:hover:border-violet-700 transition-all duration-200 flex items-center justify-center gap-1.5 sm:gap-2 text-xs sm:text-sm"
									>
										<Icon name="lucide:message-circle-code" class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
										<span>Resume</span>
									</button>

									<button
										onclick={() => deleteSession(session)}
										class="flex p-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-200 dark:hover:border-red-700 rounded-lg transition-all duration-200"
										title="Delete session"
										aria-label="Delete session"
									>
										<Icon name="lucide:trash-2" class="w-3.5 h-3.5 sm:w-4 sm:h-4" />
									</button>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</PageTemplate>

<!-- Timeline Modal (Readonly) -->
{#if timelineSession}
	<TimelineModal
		bind:isOpen={showTimelineModal}
		onClose={closeTimelineModal}
		sessionIdOverride={timelineSession.id}
		readonly={true}
	/>
{/if}
<script lang="ts">
	import { sessionState, setCurrentSession, createNewChatSession, clearMessages, loadMessagesForSession } from '$frontend/stores/core/sessions.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { onMount, untrack } from 'svelte';
	import { fade } from 'svelte/transition';
	import ChatMessages from '$frontend/components/chat/message/ChatMessages.svelte';
	import ChatInput from '$frontend/components/chat/input/ChatInput.svelte';
	import TaskProgress from '$frontend/components/chat/widgets/TaskProgress.svelte';
	import RateLimit from '$frontend/components/chat/widgets/RateLimit.svelte';
	import TimelineModal from '$frontend/components/checkpoint/TimelineModal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';
	import { chatService } from '$frontend/services/chat/chat.service';
	import { snapshotService } from '$frontend/services/snapshot/snapshot.service';
	import { setSkipNextRestore } from '$frontend/stores/ui/chat-input.svelte';
	import { checkpointChanges, hideCheckpointChanges, changesExpanded, toggleChangesExpanded, showCheckpointChanges, requestCheckpointDiff, refreshCheckpointBanner, checkpointDiff, activeCheckpointFile, clearActiveCheckpointFile } from '$frontend/stores/features/checkpoint-changes.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getGitStatusLabel, getGitStatusColor } from '$frontend/utils/git-status';
	import { showPanel } from '$frontend/stores/ui/workspace.svelte';
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

	// Auto-load current checkpoint changes for banner
	$effect(() => {
		const sid = sessionState.currentSession?.id;
		const projectId = projectState.currentProject?.id;
		// Only depend on the session id + project id. Reading
		// `checkpointChanges.visible` here would make the effect re-fire
		// after `hideCheckpointChanges()` (e.g. when a file gets staged)
		// and re-show the banner with stale snapshot data.
		untrack(() => {
		// Clear the banner immediately on project switch so the old
		// project's files don't linger in the UI while we fetch the
		// new project's data.
		if (!projectId) {
			hideCheckpointChanges();
			return;
		}
		if (sid && !checkpointChanges.visible) {
			refreshCheckpointBanner(sid);
		}
		});
	});

	// Re-sync banner when the project changes — clear the old project's
	// banner and fetch the new one. Without this, switching projects
	// leaves the previous project's file list in the UI.
	$effect(() => {
		const projectId = projectState.currentProject?.id;
		untrack(() => {
			hideCheckpointChanges();
			clearActiveCheckpointFile();
			if (!projectId) return;
			const sid = sessionState.currentSession?.id;
			if (sid) refreshCheckpointBanner(sid);
		});
	});

	// Poll the banner while the AI is processing. `snapshot:captured` is
	// unreliable in practice (fires before the frontend listener is ready,
	// gets lost on WS reconnect, etc.), and the message-list effect can't
	// race the backend's `captureSnapshot` in the stream's finally block.
	// A 2s poll while `isLoading` is true is dead-simple and guaranteed to
	// pick up the new snapshot within ~2s of the AI finishing.
	$effect(() => {
		if (!appState.isLoading) return;
		const sid = sessionState.currentSession?.id;
		if (!sid) return;
		const interval = setInterval(() => {
			untrack(() => refreshCheckpointBanner(sid));
		}, 2000);
		return () => clearInterval(interval);
	});

	// Same real-time hook the Git panel uses for its Changes list:
	// `files:changed` fires the moment the AI writes a file to disk.
	// We refresh the banner immediately; if the snapshot hasn't been
	// captured yet, the next poll/`snapshot:captured` will catch up.
	$effect(() => {
		const projectPath = projectState.currentProject?.path;
		const sid = sessionState.currentSession?.id;
		if (!projectPath || !sid) return;
		const unsub = ws.on('files:changed', () => {
			untrack(() => refreshCheckpointBanner(sid));
		});
		return unsub;
	});

	// Backend emits `snapshot:captured` right after `captureSnapshot`
	// finishes writing the new snapshot row. This is the authoritative
	// signal that the banner's data is fresh — the file-watcher hook above
	// fires before the snapshot exists, so we still need this one.
	$effect(() => {
		const sid = sessionState.currentSession?.id;
		if (!sid) return;
		const unsub = ws.on('snapshot:captured', (data: { chatSessionId: string }) => {
			if (data.chatSessionId === sid) {
				untrack(() => refreshCheckpointBanner(sid));
			}
		});
		return unsub;
	});

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
				<!-- Enhanced chat interface: Rate Limit + Task Progress docked above chat -->
				<div class="flex-1 flex flex-col overflow-hidden">
					{#if sessionState.currentSession}
						<RateLimit />
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
								<!-- Checkpoint changes banner -->
								{#if checkpointChanges.visible}
									<div class="mb-2 p-2 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-lg">
										<div role="button" tabindex="0" class="flex items-center gap-2 w-full text-left bg-transparent cursor-pointer" onclick={toggleChangesExpanded} onkeydown={(e) => e.key === 'Enter' && toggleChangesExpanded()}>
											<Icon name={changesExpanded.value ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3 h-3 text-slate-500 flex-shrink-0" />
											<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">Current state · Changed Files ({checkpointChanges.files.length})</span>
											<span role={appState.isLoading ? undefined : 'button'} tabindex={appState.isLoading ? -1 : 0} class="text-slate-400 bg-transparent ml-auto flex-shrink-0 pr-1.5 {appState.isLoading ? 'cursor-not-allowed opacity-40' : 'hover:text-slate-700 cursor-pointer'}" onclick={(e) => { if (appState.isLoading) return; e.stopPropagation(); hideCheckpointChanges(); }} onkeydown={(e) => { if (appState.isLoading) return; if (e.key === 'Enter') hideCheckpointChanges(); }}><Icon name="lucide:x" class="w-3 h-3" /></span>
										</div>
										{#if changesExpanded.value}
											{#if checkpointChanges.loading}
												<div class="flex items-center justify-center py-2 mt-1"><div class="w-3 h-3 border-2 border-slate-300 border-t-slate-500 rounded-full animate-spin"></div></div>
											{:else if checkpointChanges.files.length === 0}
												<p class="text-xs text-slate-400 mt-1 ml-5">No files changed</p>
											{:else}
												<div class="mt-1 ml-2 flex flex-col">
													{#each checkpointChanges.files as f (f.filepath)}
														{@const fName = f.filepath.split(/[\\/]/).pop() || f.filepath}
														{@const fDir = f.filepath.split(/[\\/]/).slice(0, -1).join('/')}
														{@const fStatus = !f.oldHash ? 'A' : !f.newHash ? 'D' : 'M'}
														{@const isActiveFile = activeCheckpointFile.path === f.filepath}
														<div
															role="button"
															tabindex="0"
															class="group flex items-center gap-1.5 py-1.5 px-2 rounded-md cursor-pointer transition-colors text-slate-700 dark:text-slate-200 {isActiveFile ? 'bg-slate-200 dark:bg-slate-700/60' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
															onclick={async (e) => {
																e.stopPropagation();
																const sid = sessionState.currentSession?.id;
																if (sid) {
																	const tl = await snapshotService.getTimeline(sid);
																	const headId = tl.currentHeadId;
																	if (headId && headId !== '__initial__') {
																		const r = await snapshotService.getFileDiff(headId, f.filepath, sid);
																		requestCheckpointDiff(r.filepath, r.oldContent, r.newContent);
																		showPanel('git');
																	}
																}
															}}
															onkeydown={async (e) => {
																if (e.key !== 'Enter') return;
																e.stopPropagation();
																const sid = sessionState.currentSession?.id;
																if (sid) {
																	const tl = await snapshotService.getTimeline(sid);
																	const headId = tl.currentHeadId;
																	if (headId && headId !== '__initial__') {
																		const r = await snapshotService.getFileDiff(headId, f.filepath, sid);
																		requestCheckpointDiff(r.filepath, r.oldContent, r.newContent);
																		showPanel('git');
																	}
																}
															}}
															title={f.filepath}
														>
															<Icon name={getFileIcon(fName)} class="w-3.5 h-3.5 shrink-0" />
															<div class="flex items-baseline gap-1.5 min-w-0 flex-1">
																<span class="text-xs font-medium truncate font-mono">{fName}</span>
																{#if fDir}
																	<span class="text-3xs text-slate-400 dark:text-slate-500 truncate min-w-0" dir="rtl">{fDir}</span>
																{/if}
															</div>
															<span class="w-3 text-center text-3xs font-bold {getGitStatusColor(fStatus)} shrink-0">{getGitStatusLabel(fStatus)}</span>
														</div>
													{/each}
												</div>
											{/if}
										{/if}

									</div>
								{/if}
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

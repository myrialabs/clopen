<!--
  Modern SDK-Based Input Area with File Upload Support

  Features:
  - Server-Sent Events streaming
  - Real-time message display
  - Enhanced error handling
  - Modern AI-first UI design
  - Proper cancellation support
  - File upload support (images, PDFs, documents)
-->

<script lang="ts">
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { appState } from '$frontend/lib/stores/core/app.svelte';
	import { settings } from '$frontend/lib/stores/features/settings.svelte';
	import { onDestroy, untrack } from 'svelte';
	import { ChatService } from '$frontend/lib/services/chat';
	import { chatService } from '$frontend/lib/services/chat/chat.service';
	import { getEngineInfo } from '$shared/constants/engines';
	import { modelStore } from '$frontend/lib/stores/features/models.svelte';
	import { chatModelState } from '$frontend/lib/stores/ui/chat-model.svelte';
	import { presenceState } from '$frontend/lib/stores/core/presence.svelte';
	import { editModeState } from '$frontend/lib/stores/ui/edit-mode.svelte';
	import { claudeAccountsStore } from '$frontend/lib/stores/features/claude-accounts.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import ws from '$frontend/lib/utils/ws';
	import { debug } from '$shared/utils/logger';

	// Components
	import FileAttachmentPreview from './components/FileAttachmentPreview.svelte';
	import EditModeIndicator from './components/EditModeIndicator.svelte';
	import ChatInputActions from './components/ChatInputActions.svelte';
	import LoadingIndicator from './components/LoadingIndicator.svelte';
	import DragDropOverlay from './components/DragDropOverlay.svelte';
	import EngineModelPicker from './components/EngineModelPicker.svelte';

	// Composables
	import { useFileHandling } from './composables/use-file-handling.svelte';
	import { usePlaceholderAnimation, useLoadingTextAnimation } from './composables/use-animations.svelte';
	import { useTextareaResize } from './composables/use-textarea-resize.svelte';
	import { useChatActions } from './composables/use-chat-actions.svelte';
	import { useInputState } from './composables/use-input-state.svelte';

	let messageText = $state('');
	let textareaElement: HTMLTextAreaElement;
	let fileInputElement: HTMLInputElement;

	// Initialize composables
	const fileHandling = useFileHandling();
	const placeholderTexts = ChatService.placeholderTexts;
	const loadingTexts = ChatService.loadingTexts;
	const placeholderAnimation = usePlaceholderAnimation(placeholderTexts);
	const loadingTextAnimation = useLoadingTextAnimation(loadingTexts);
	const textareaResize = useTextareaResize();

	// Helper functions for composables
	const setMessageText = (text: string) => {
		messageText = text;
	};
	const getTextareaElement = () => textareaElement;
	const adjustTextareaHeight = () =>
		textareaResize.adjustTextareaHeight(textareaElement, messageText);
	const focusTextarea = () => textareaElement?.focus();

	// Chat actions params
	const chatActionsParams = {
		get messageText() {
			return messageText;
		},
		get attachedFiles() {
			return fileHandling.attachedFiles;
		},
		clearAllAttachments: fileHandling.clearAllAttachments,
		adjustTextareaHeight,
		focusTextarea,
		startLoadingAnimation: loadingTextAnimation.startAnimation,
		stopLoadingAnimation: loadingTextAnimation.stopAnimation,
		clearDraft: () => inputState.clearDraft()
	};

	// Initialize input state management (restoration, template loading, sync)
	// Declared before chatActions so clearDraft is available
	const inputState = useInputState({
		setMessageText,
		getTextareaElement,
		adjustTextareaHeight,
		focusTextarea,
		setAttachedFiles: (files) => {
			fileHandling.attachedFiles = files;
		}
	});

	const chatActions = useChatActions(chatActionsParams);

	// Enhanced model info based on user settings
	const modelInfo = $derived.by(() => {
		const selectedModel = settings.selectedModel;
		const model = modelStore.getById(selectedModel);
		const modelName = model?.name || 'AI Assistant';
		const engineInfo = getEngineInfo(settings.selectedEngine);

		return {
			name: modelName,
			description: engineInfo?.description || 'AI-powered development assistant',
			icon: 'lucide:brain-circuit' as IconName,
			model: selectedModel
		};
	});

	// Check if the current model supports file attachments
	const modelSupportsAttachments = $derived.by(() => {
		const model = modelStore.getById(chatModelState.model);
		if (!model) return true; // Default to enabled if model not found
		return model.capabilities.some(c => c.toLowerCase() === 'attachments');
	});

	// Check if we're in welcome state (no messages)
	const isWelcomeState = $derived(sessionState.messages.length === 0);

	// Project-aware state
	const hasActiveProject = $derived(projectState.currentProject !== null);

	// Reason why chat input is blocked (aside from isLoading / no project)
	const chatBlockedReason = $derived.by(() => {
		const engine = chatModelState.engine;
		if (engine === 'claude-code') {
			if (claudeAccountsStore.loaded && claudeAccountsStore.accounts.length === 0) {
				return 'no-claude-account' as const;
			}
		} else {
			if (!chatModelState.model) {
				return 'no-model' as const;
			}
		}
		return null;
	});

	const isInputDisabled = $derived(appState.isLoading || !hasActiveProject || !!chatBlockedReason);

	const chatPlaceholder = $derived.by(() => {
		if (chatBlockedReason === 'no-claude-account') {
			return 'No Claude Code account connected. Configure it in Settings → AI Engine → Claude Code → Accounts.';
		}
		if (chatBlockedReason === 'no-model') {
			return 'No model selected. Please select a model to start chatting.';
		}
		return placeholderAnimation.placeholderText;
	});

	// Wrapper functions for event handlers
	const handleTextareaInput = () => {
		textareaResize.handleTextareaInput(textareaElement, messageText);
		// Sync input text to other collaborators (includes draft save)
		inputState.emitInputSync(messageText, fileHandling.attachedFiles);
	};
	const handleKeyDown = (event: KeyboardEvent) =>
		textareaResize.handleKeyDown(event, textareaElement, messageText);
	const handleKeyPress = (event: KeyboardEvent) =>
		chatActions.handleKeyPress(event, messageText, setMessageText);
	const handleSendMessage = () => {
		chatActions.sendMessage(messageText, setMessageText);
	};
	const handleCancelEdit = () => {
		chatActions.handleCancelEdit();
		messageText = '';
		fileHandling.clearAllAttachments();
		adjustTextareaHeight();
	};

	// Reactive effect for placeholder animation
	$effect(() => {
		if (isWelcomeState) {
			placeholderAnimation.startAnimation();
		} else {
			placeholderAnimation.setStaticPlaceholder('Continue the conversation...');
		}
	});

	// Sync appState.isLoading from presence data (single source of truth for all users)
	// Also fetch partial text and reconnect to stream for late-joining users / refresh
	let lastCatchupProjectId: string | undefined;
	let lastPresenceProjectId: string | undefined;
	$effect(() => {
		const projectId = projectState.currentProject?.id;
		const sessionId = sessionState.currentSession?.id; // Reactive dep: retry catchup when session loads
		if (!projectId) return;

		// When switching projects, clear isCancelling from the previous project.
		// The cancel is project-scoped: cancelling Project A must NOT block Project B.
		// Also, after project switch the WS room changes, so the chat:cancelled event
		// for the old project will never arrive — we must clear it here.
		if (projectId !== lastPresenceProjectId) {
			if (lastPresenceProjectId && appState.isCancelling) {
				appState.isCancelling = false;
			}
			lastPresenceProjectId = projectId;
		}

		const status = presenceState.statuses.get(projectId);
		// Check if the active stream is for the CURRENT session (not just any session in the project)
		const hasActiveForSession = status?.streams?.some(
			(s: any) => s.status === 'active' && s.chatSessionId === sessionId
		) ?? false;
		if (hasActiveForSession && !appState.isLoading) {
			// Don't re-enable loading if user just cancelled locally
			if (appState.isCancelling) return;

			appState.isLoading = true;

			// Catch up on active stream's partial text for late-joining users
			// Only do this once per project switch to avoid repeated fetches
			// Only attempt if session is available (may not be on initial load)
			if (projectId !== lastCatchupProjectId && sessionId) {
				lastCatchupProjectId = projectId;
				catchupActiveStream(status);
			}
		} else if (hasActiveForSession && appState.isLoading && sessionId && projectId !== lastCatchupProjectId) {
			// Session became available after loading was already set (e.g. page refresh)
			// The first run set isLoading=true but couldn't catch up because session wasn't loaded yet
			lastCatchupProjectId = projectId;
			catchupActiveStream(status);
		} else if (!hasActiveForSession && appState.isLoading && !appState.isCancelling) {
			// Only clear loading if not in the middle of a cancel operation
			appState.isLoading = false;
			lastCatchupProjectId = undefined;
		} else if (!hasActiveForSession && !appState.isLoading) {
			// No active streams for this session — just reset catchup tracking.
			lastCatchupProjectId = undefined;
		}
	});

	/**
	 * Fetch current stream state, inject partial text, and reconnect to live events
	 * for late-joining users (browser refresh, project switch, long absence)
	 */
	async function catchupActiveStream(status: any) {
		if (!status?.streams?.length || !sessionState.currentSession?.id) return;

		// Find the active stream
		const activeStream = status.streams.find((s: any) => s.status === 'active');
		if (!activeStream) return;

		try {
			const streamState = await ws.http('chat:background-state', {
				chatSessionId: sessionState.currentSession.id
			});

			if (streamState && streamState.status === 'active' && streamState.processId) {
				// Check if we already have a streaming message for this processId
				const hasStreamingMessage = sessionState.messages.some(
					(m: any) => m.type === 'stream_event' && m.processId === streamState.processId
				);

				if (!hasStreamingMessage) {
					// Inject streaming message with the current partial text from the server
					const streamingMessage = {
						type: 'stream_event' as const,
						processId: streamState.processId,
						partialText: streamState.currentPartialText || '',
						timestamp: new Date().toISOString()
					};
					(sessionState.messages as any[]).push(streamingMessage);
				} else {
					// Update existing stream_event with latest partial text
					const existingMsg = sessionState.messages.find(
						(m: any) => m.type === 'stream_event' && m.processId === streamState.processId
					);
					if (existingMsg && streamState.currentPartialText) {
						(existingMsg as any).partialText = streamState.currentPartialText;
					}
				}

				// Reconnect to live stream events so future partials/messages/complete flow in
				chatService.reconnectToStream(
					sessionState.currentSession.id,
					streamState.processId
				);

				debug.log('chat', 'Caught up with active stream:', {
					processId: streamState.processId,
					partialLength: streamState.currentPartialText?.length || 0
				});
			}
		} catch (error) {
			debug.error('chat', 'Failed to catch up with active stream:', error);
		}
	}

	// Sync loading animation with appState.isLoading (works for all users, not just sender)
	$effect(() => {
		if (appState.isLoading) {
			loadingTextAnimation.startAnimation();
		} else {
			loadingTextAnimation.stopAnimation();
		}
	});

	// When edit mode exits (remote cancel, user cancel), reset input and attachments
	// Skip during project transition (isRestoring) - server restore will handle it
	// Use untrack for isRestoring to avoid this effect re-running when isRestoring changes
	let wasEditing = false;
	$effect(() => {
		const isEditing = editModeState.isEditing;
		if (wasEditing && !isEditing) {
			const restoring = untrack(() => appState.isRestoring);
			if (!restoring) {
				messageText = '';
				fileHandling.clearAllAttachments();
				setTimeout(() => adjustTextareaHeight(), 0);
			}
		}
		wasEditing = isEditing;
	});

	// Sync file attachments to other collaborators when they change
	// Use untrack for isRestoring so this effect ONLY re-runs when files change,
	// not when isRestoring transitions (which would emit stale data to new project)
	$effect(() => {
		// Access attachedFiles to create reactive dependency
		const files = fileHandling.attachedFiles;
		const restoring = untrack(() => appState.isRestoring);
		if (!restoring) {
			// Emit attachment sync with current text
			inputState.emitAttachmentSync(messageText, files);
		}
	});

	onDestroy(() => {
		fileHandling.clearAllAttachments();
	});
</script>

<div class="">
	<!-- Hidden file input -->
	<input
		bind:this={fileInputElement}
		type="file"
		multiple
		accept={[...fileHandling.SUPPORTED_IMAGE_TYPES, ...fileHandling.SUPPORTED_DOCUMENT_TYPES].join(
			','
		)}
		onchange={fileHandling.handleFileInputChange}
		class="hidden"
	/>

	<!-- Input container with modern design -->
	<div class="{isWelcomeState ? 'max-w-3xl mx-auto' : 'max-w-4xl mx-auto'} relative">
		<!-- File attachments preview -->
		<FileAttachmentPreview
			attachedFiles={fileHandling.attachedFiles}
			onRemove={fileHandling.removeAttachment}
		/>

		<!-- Main input area with drag and drop support -->
		<div
			class="
			relative z-10 flex items-end gap-3 lg:gap-4 overflow-hidden bg-white dark:bg-slate-900
			border border-slate-200 dark:border-slate-700 rounded-xl transition-all duration-200
			focus-within:ring-2 focus-within:ring-violet-500 {fileHandling.isDragging && 'ring-2 ring-violet-500'}"
			role="region"
			aria-label="Message input with file drop zone"
			ondragover={fileHandling.handleDragOver}
			ondragleave={fileHandling.handleDragLeave}
			ondrop={fileHandling.handleDrop}
		>
			<div class="flex-1">
				<!-- Engine/Model Picker -->
				<EngineModelPicker />

				<!-- Edit Mode Indicator -->
				<EditModeIndicator onCancel={handleCancelEdit} />

				<div class="relative">
					<textarea
						bind:this={textareaElement}
						bind:value={messageText}
						placeholder={chatPlaceholder}
						class="flex w-full p-4 pr-24 border-0 bg-transparent resize-none focus:outline-none text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 text-base leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed"
						rows="1"
						style="max-height: 22.5rem; overflow-y: hidden;"
						disabled={isInputDisabled}
						oninput={handleTextareaInput}
						onkeydown={handleKeyDown}
						onkeypress={handleKeyPress}
						onpaste={fileHandling.handlePaste}
						oncompositionstart={chatActions.handleCompositionStart}
						oncompositionend={chatActions.handleCompositionEnd}
						autocomplete="off"
					></textarea>

					<!-- Action buttons -->
					<ChatInputActions
						isLoading={appState.isLoading}
						hasActiveProject={hasActiveProject}
						messageText={messageText}
						attachedFiles={fileHandling.attachedFiles}
						isProcessingFiles={fileHandling.isProcessingFiles}
						{modelSupportsAttachments}
						onSend={handleSendMessage}
						onCancel={chatActions.cancelRequest}
						onAttachFile={() => fileHandling.handleFileSelect(fileInputElement)}
					/>
				</div>
			</div>
		</div>

		<!-- Overlays -->
		<DragDropOverlay
			isDragging={fileHandling.isDragging}
			isProcessingFiles={fileHandling.isProcessingFiles}
		/>

		<!-- Loading indicator -->
		<LoadingIndicator
			visibleLoadingText={loadingTextAnimation.visibleLoadingText}
			isWelcomeState={isWelcomeState}
		/>
	</div>
</div>

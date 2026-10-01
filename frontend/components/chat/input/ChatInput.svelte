<!--
  Chat composer: text, attachments, slash commands, and the send / queue /
  edit / stop actions for the chat session on screen.

  - Typing stays possible while a response runs; what is sent then is queued
    and the server sends it when the response finishes.
  - Drafts are per user and saved to the server (see use-input-state).
  - On touch keyboards Enter inserts a new line; the button sends.
-->

<script lang="ts">
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { onDestroy } from 'svelte';
	import { ChatService } from '$frontend/services/chat';
	import { chatService } from '$frontend/services/chat/chat.service';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { chatModelState } from '$frontend/stores/ui/chat-model.svelte';
	import { presenceState } from '$frontend/stores/core/presence.svelte';
	import { editModeState } from '$frontend/stores/ui/edit-mode.svelte';
	import { claudeAccountsStore } from '$frontend/stores/features/claude-accounts.svelte';
	import { takeQueued, type QueuedMessage } from '$frontend/stores/ui/message-queue.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import ws, { onWsReconnect } from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	// Components
	import AiChangesSummary from './components/AiChangesSummary.svelte';
	import FileAttachmentPreview from './components/FileAttachmentPreview.svelte';
	import EditModeIndicator from './components/EditModeIndicator.svelte';
	import QueuedMessages from './components/QueuedMessages.svelte';
	import ChatInputActions from './components/ChatInputActions.svelte';
	import LoadingIndicator from './components/LoadingIndicator.svelte';
	import DragDropOverlay from './components/DragDropOverlay.svelte';
	import EngineModelPicker from './components/EngineModelPicker.svelte';
	import SlashCommandMenu from './components/SlashCommandMenu.svelte';
	import ConflictResolutionModal from '$frontend/components/checkpoint/ConflictResolutionModal.svelte';
	import { skillsStore, type AvailableSkill } from '$frontend/stores/features/skills.svelte';

	// Composables
	import {
		useFileHandling,
		buildAcceptedMimeTypes,
		attachmentFromBase64,
		type FileAttachment
	} from './composables/use-file-handling.svelte';
	import { usePlaceholderAnimation, useLoadingTextAnimation } from './composables/use-animations.svelte';
	import { useTextareaResize } from './composables/use-textarea-resize.svelte';
	import { useChatActions } from './composables/use-chat-actions.svelte';
	import { useInputState } from './composables/use-input-state.svelte';

	let messageText = $state('');
	let textareaElement: HTMLTextAreaElement;
	// Hidden twin of the textarea that measures the placeholder (see use-textarea-resize)
	let sizingMirror: HTMLTextAreaElement;
	// Shared by the textarea and its sizing mirror: identical classes mean
	// identical width, font and padding, so the measurement can't drift.
	const textareaClass =
		'w-full px-4 pt-2 pb-4 border-0 bg-transparent resize-none focus:outline-none text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 text-base leading-relaxed';
	let fileInputElement: HTMLInputElement;

	// Initialize composables
	const fileHandling = useFileHandling();
	const placeholderAnimation = usePlaceholderAnimation(ChatService.placeholderTexts);
	const loadingTextAnimation = useLoadingTextAnimation(ChatService.loadingTexts);
	const textareaResize = useTextareaResize();

	// Touch keyboards have no Shift+Enter, so Enter is a new line there and the
	// on-screen key is labelled accordingly.
	const isTouchKeyboard =
		typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

	// --- Blocking state ---

	const hasActiveProject = $derived(projectState.currentProject !== null);
	const isWelcomeState = $derived(sessionState.messages.length === 0);

	// What stops the selected engine from taking a message at all.
	const chatBlockedReason = $derived.by(() => {
		const engine = chatModelState.engine;
		if (engine === 'claude-code' && claudeAccountsStore.loaded && claudeAccountsStore.accounts.length === 0) {
			return 'no-claude-account' as const;
		}
		if (engine !== 'claude-code' && !chatModelState.modelId) {
			return 'no-model' as const;
		}
		// A model that was selected once but is gone from the catalog (engine
		// reinstalled, account changed) would be sent as-is and fail mid-turn.
		if (
			chatModelState.modelId &&
			modelStore.isFetched(engine) &&
			!modelStore.isLoading(engine) &&
			!modelStore.getForEngine(engine, chatModelState.modelId)
		) {
			return 'model-missing' as const;
		}
		return null;
	});

	const blockedPlaceholder = $derived.by(() => {
		switch (chatBlockedReason) {
			case 'no-claude-account':
				return 'No Claude Code account connected. Configure it in Settings → Engines → Claude Code → Accounts.';
			case 'no-model':
				return 'No model selected. Please select a model to start chatting.';
			case 'model-missing':
				return 'The selected model is no longer available. Please select another model.';
			default:
				return null;
		}
	});

	// The placeholder in two forms: as displayed (animated) and as sized (whole),
	// so the box doesn't change height on every animation frame.
	const placeholderFor = (animated: string) => {
		if (blockedPlaceholder) return blockedPlaceholder;
		if (appState.isWaitingInput) return 'Answer the question above to continue...';
		if (appState.isLoading && !editModeState.isEditing) return 'Queue a follow-up...';
		return animated;
	};
	const chatPlaceholder = $derived(placeholderFor(placeholderAnimation.placeholderText));
	const sizingPlaceholder = $derived(placeholderFor(placeholderAnimation.fullText));

	// Helper functions for composables
	const setMessageText = (text: string) => {
		messageText = text;
	};
	const adjustTextareaHeight = () =>
		textareaResize.adjustTextareaHeight(textareaElement, sizingMirror, messageText, sizingPlaceholder);
	const focusTextarea = () => {
		// Re-focusing after a send would pop the on-screen keyboard back up.
		if (!isTouchKeyboard) textareaElement?.focus();
	};

	// Restoration and saving of this user's draft, edit mode and the queue
	const inputState = useInputState({
		getMessageText: () => messageText,
		setMessageText,
		getTextareaElement: () => textareaElement,
		adjustTextareaHeight,
		getAttachedFiles: () => fileHandling.attachedFiles,
		replaceAttachments: fileHandling.replaceAttachments
	});

	const chatActions = useChatActions({
		getAttachedFiles: () => fileHandling.attachedFiles,
		isProcessingFiles: () => fileHandling.isProcessingFiles,
		clearAllAttachments: fileHandling.clearAllAttachments,
		setMessageText,
		adjustTextareaHeight,
		focusTextarea,
		clearDraft: inputState.clearDraft
	});

	const submitMode = $derived<'send' | 'queue' | 'edit'>(
		editModeState.isEditing ? 'edit' : appState.isLoading ? 'queue' : 'send'
	);
	const hasContent = $derived(!!messageText.trim() || fileHandling.attachedFiles.length > 0);

	// Why the submit button can't be used right now — also its tooltip.
	const submitBlockedReason = $derived.by(() => {
		if (!hasActiveProject) return 'Select a project first';
		if (blockedPlaceholder) return blockedPlaceholder;
		if (modelStore.isLoading(chatModelState.engine)) return 'Loading models…';
		if (fileHandling.isProcessingFiles) return 'Attachments are still loading…';
		if (appState.isWaitingInput) return 'Answer the question above first';
		if (appState.isCancelling) return 'Stopping…';
		if (editModeState.isEditing && appState.isLoading) return 'Stop the response before sending an edit';
		if (chatActions.isSubmitting) return 'Sending…';
		return null;
	});

	// --- Slash command menu (typing "/" surfaces slash-invocable Skills) ---
	let slashActiveIndex = $state(0);
	let slashDismissed = $state(false);

	// Active only when the whole input is a single "/token" (no space yet).
	const slashQuery = $derived.by(() => {
		const m = /^\/([A-Za-z0-9-]*)$/.exec(messageText);
		return m ? m[1].toLowerCase() : null;
	});
	const slashMatches = $derived.by(() => {
		if (slashQuery === null) return [] as AvailableSkill[];
		const q = slashQuery;
		return skillsStore.available.filter(c => !q || `${c.slug} ${c.name}`.toLowerCase().includes(q));
	});
	const slashOpen = $derived(
		slashQuery !== null && !slashDismissed && slashMatches.length > 0
	);

	// Re-fetch whenever the session's active profile (or its project, for the
	// project-default fallback) changes, so the "/" picker mirrors exactly what
	// the profile makes available in the stream (see skillsStore.fetchAvailable).
	$effect(() => {
		void skillsStore.fetchAvailable(chatModelState.profileId, projectState.currentProject?.id);
	});

	// Reset dismissal + clamp the active index as the slash session changes.
	$effect(() => {
		if (slashQuery === null) {
			slashDismissed = false;
			slashActiveIndex = 0;
		} else if (slashActiveIndex >= slashMatches.length) {
			slashActiveIndex = 0;
		}
	});

	function selectSlashCommand(command: AvailableSkill) {
		setMessageText(`/${command.slug} `);
		slashDismissed = true;
		textareaElement?.focus();
		adjustTextareaHeight();
		inputState.saveText();
	}

	// --- Attachments ---

	// Accepted MIME types based on the selected model's input modalities
	const acceptedMimeTypes = $derived.by(() => {
		const model = chatModelState.modelId
			? modelStore.getForEngine(chatModelState.engine, chatModelState.modelId)
			: undefined;
		if (!model) return buildAcceptedMimeTypes({ image: true, pdf: true, audio: false, video: false });
		return buildAcceptedMimeTypes(model.modalities.input);
	});

	const modelSupportsAttachments = $derived(acceptedMimeTypes.length > 0);

	// Sync allowed types to the file handling composable when model changes
	$effect(() => {
		fileHandling.allowedTypes = acceptedMimeTypes;
	});

	// Every change to the attachments is saved to the draft right after it.
	async function afterAttachmentChange(change: Promise<void> | void) {
		await change;
		inputState.saveAttachments(fileHandling.attachedFiles);
	}
	const handleFileInputChange = (event: Event) => afterAttachmentChange(fileHandling.handleFileInputChange(event));
	const handleDrop = (event: DragEvent) => afterAttachmentChange(fileHandling.handleDrop(event));
	const handlePaste = (event: ClipboardEvent) => afterAttachmentChange(fileHandling.handlePaste(event));
	const handleRemoveAttachment = (id: string) => afterAttachmentChange(fileHandling.removeAttachment(id));

	// --- Event handlers ---

	const handleTextareaInput = () => {
		adjustTextareaHeight();
		inputState.saveText();
	};
	const handleKeyDown = (event: KeyboardEvent) => {
		// Slash menu owns navigation keys while it's open.
		if (slashOpen) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				slashActiveIndex = (slashActiveIndex + 1) % slashMatches.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				slashActiveIndex = (slashActiveIndex - 1 + slashMatches.length) % slashMatches.length;
				return;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				selectSlashCommand(slashMatches[slashActiveIndex]);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				slashDismissed = true;
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey && submitBlockedReason) {
			// Enter can't send right now: keep it from inserting a line the user
			// didn't ask for (desktop) — the button's tooltip says why.
			if (!isTouchKeyboard) event.preventDefault();
			return;
		}
		chatActions.handleKeyDown(event, messageText);
	};
	const handleSubmit = () => {
		if (submitBlockedReason) return;
		void chatActions.submit(messageText);
	};
	const handleCancelEdit = () => {
		chatActions.handleCancelEdit();
	};

	// Take a queued message back into the box to change it.
	async function handleEditQueued(item: QueuedMessage) {
		try {
			const taken = await takeQueued(item.id);
			if (!taken) return;
			setMessageText(messageText.trim() ? `${messageText.trimEnd()}\n\n${taken.text}` : taken.text);
			const restored = taken.attachments
				.map((a) => attachmentFromBase64({ fileName: a.fileName, mediaType: a.mediaType, base64: a.data }))
				.filter((a): a is FileAttachment => a !== null);
			if (restored.length > 0) {
				fileHandling.replaceAttachments([...fileHandling.attachedFiles, ...restored]);
				inputState.saveAttachments(fileHandling.attachedFiles);
			}
			inputState.saveText();
			textareaElement?.focus();
			setTimeout(() => adjustTextareaHeight(), 0);
		} catch (error) {
			debug.error('chat', 'Failed to take queued message back:', error);
			addNotification({
				type: 'error',
				title: 'Could not edit queued message',
				message: error instanceof Error ? error.message : 'Unknown error',
				duration: 4000
			});
		}
	}

	// Reactive effect for placeholder animation
	$effect(() => {
		if (isWelcomeState) {
			placeholderAnimation.startAnimation();
		} else {
			placeholderAnimation.setStaticPlaceholder('Continue the conversation...');
		}
	});

	// Re-fit when the box's width changes or fonts finish loading
	$effect(() => {
		if (textareaElement) textareaResize.observe(textareaElement, adjustTextareaHeight);
	});

	// An empty box is as tall as its placeholder: re-fit when that changes
	$effect(() => {
		void sizingPlaceholder;
		if (!messageText.trim()) adjustTextareaHeight();
	});

	// Sync appState.isLoading from presence data (single source of truth for all users)
	// Also fetch partial text and reconnect to stream for late-joining users / refresh
	// Keyed by project + session: two sessions of the same project can stream at
	// once, so a project-only key made an intra-project session switch skip
	// catchup entirely — the switched-to session never re-attached to its live
	// stream and its output stopped updating.
	let lastCatchupKey: string | undefined;
	let lastPresenceProjectId: string | undefined;

	// Reset catchup tracking on WS reconnect so catchupActiveStream re-runs.
	// When WS briefly disconnects, the server-side cleanup removes the stream
	// EventEmitter subscription. Without resetting, catchup won't fire again
	// (guarded by lastCatchupKey) and the stream subscription is never
	// re-established — causing stream output to silently stop in the UI.
	const stopReconnectListener = onWsReconnect(() => {
		if (lastCatchupKey) {
			debug.log('chat', 'WS reconnected — resetting stream catchup tracking');
			lastCatchupKey = undefined;
		}
	});

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

		// Catchup reads and writes this session's transcript, so it may only run
		// once that transcript is the one loaded — `currentSession` moves on
		// switch, `messagesSessionId` a round trip later. Leaving the key
		// undefined until then means the attempt is not marked as done, so this
		// effect retries the moment the messages land.
		const transcriptReady = !!sessionId && sessionState.messagesSessionId === sessionId;
		const catchupKey = transcriptReady ? `${projectId}:${sessionId}` : undefined;
		const status = presenceState.statuses.get(projectId);
		// Check if the active stream is for the CURRENT session (not just any session in the project)
		const hasActiveForSession = status?.streams?.some(
			(s: any) => s.status === 'active' && s.chatSessionId === sessionId
		) ?? false;
		if (hasActiveForSession && !appState.isLoading) {
			// Don't re-enable loading if user just cancelled locally
			if (appState.isCancelling || !sessionId) return;

			chatService.syncLoadingFromPresence(sessionId, true);

			// Catch up on active stream's partial text for late-joining users
			// Only do this once per project+session switch to avoid repeated fetches
			// Only attempt if session is available (may not be on initial load)
			if (catchupKey && catchupKey !== lastCatchupKey) {
				lastCatchupKey = catchupKey;
				catchupActiveStream(status);
			}
		} else if (hasActiveForSession && appState.isLoading && catchupKey && catchupKey !== lastCatchupKey) {
			// Session became available after loading was already set (e.g. page refresh),
			// or the user switched to another session of this project that is still
			// streaming — either way this session must re-attach to its live stream.
			lastCatchupKey = catchupKey;
			catchupActiveStream(status);
		} else if (!hasActiveForSession && appState.isLoading && !appState.isCancelling) {
			// A send this client just made is not in presence yet — that is not
			// the end of the stream. Only clear once the server has confirmed it.
			if (sessionId && chatService.isStartPending(sessionId)) return;
			if (sessionId) chatService.syncLoadingFromPresence(sessionId, false);
			lastCatchupKey = undefined;
		} else if (!hasActiveForSession && !appState.isLoading) {
			// No active streams for this session — clear cancelling state and reset catchup tracking.
			// This is the authoritative signal that the cancel is fully complete (presence confirmed).
			if (appState.isCancelling) {
				appState.isCancelling = false;
			}
			lastCatchupKey = undefined;
		}
	});

	/**
	 * Fetch current stream state, inject partial text, and reconnect to live events
	 * for late-joining users (browser refresh, project switch, long absence)
	 */
	async function catchupActiveStream(status: any) {
		// Pin the session this catchup is for. Everything below runs after an
		// await, and `sessionState.messages` always holds whichever session is on
		// screen *now* — so a catchup that resolves after the user switched away
		// would inject one chat's partial text into another's transcript and read
		// that transcript to decide whether to show "Waiting for your input".
		const chatSessionId = sessionState.currentSession?.id;
		if (!status?.streams?.length || !chatSessionId) return;
		// `messagesSessionId` — not `currentSession` — is what says the transcript
		// on screen is this session's; the switch moves one a round trip before
		// the other.
		const holdsThisSession = () => sessionState.messagesSessionId === chatSessionId;

		// Find the active stream for the current session
		const activeStream = status.streams.find(
			(s: any) => s.status === 'active' && s.chatSessionId === chatSessionId
		);
		if (!activeStream) return;

		try {
			const streamState = await ws.http('chat:stream-state', { chatSessionId });
			if (!holdsThisSession()) return;

			if (streamState && streamState.status === 'active' && streamState.processId) {
				// ── Inject reasoning stream_event (if available) ──
				// Must come before text so the display order matches live emission.
				if (streamState.currentReasoningText) {
					const existingReasoning = sessionState.messages.find(
						(m: any) => m.type === 'stream_event' && m.processId === streamState.processId && m.reasoning === true
					);

					if (!existingReasoning) {
						(sessionState.messages as any[]).push({
							type: 'stream_event' as const,
							processId: streamState.processId,
							text: streamState.currentReasoningText,
							createdAt: new Date().toISOString(),
							reasoning: true,
						});
					} else {
						(existingReasoning as any).text = streamState.currentReasoningText;
					}
				}

				// ── Inject text stream_event (if available) ──
				if (streamState.currentPartialText) {
					const existingText = sessionState.messages.find(
						(m: any) => m.type === 'stream_event' && m.processId === streamState.processId && m.reasoning !== true
					);

					if (!existingText) {
						(sessionState.messages as any[]).push({
							type: 'stream_event' as const,
							processId: streamState.processId,
							text: streamState.currentPartialText,
							createdAt: new Date().toISOString(),
							reasoning: false,
						});
					} else {
						(existingText as any).text = streamState.currentPartialText;
					}
				}

				// If no partial text/reasoning yet, inject an empty text stream_event so the loading indicator is visible
				if (!streamState.currentPartialText && !streamState.currentReasoningText) {
					const hasAnyStream = sessionState.messages.some(
						(m: any) => m.type === 'stream_event' && m.processId === streamState.processId
					);
					if (!hasAnyStream) {
						(sessionState.messages as any[]).push({
							type: 'stream_event' as const,
							processId: streamState.processId,
							text: '',
							createdAt: new Date().toISOString(),
							reasoning: false,
						});
					}
				}

				// Reconnect to live stream events so future partials/messages/complete flow in
				chatService.reconnectToStream(chatSessionId, streamState.processId);

				// Detect if an interactive tool (e.g. AskUserQuestion) is pending in existing messages
				chatService.detectPendingInteractiveTools(chatSessionId);

				debug.log('chat', 'Caught up with active stream:', {
					processId: streamState.processId,
					partialLength: streamState.currentPartialText?.length || 0,
					reasoningLength: streamState.currentReasoningText?.length || 0
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

	onDestroy(() => {
		stopReconnectListener();
		fileHandling.clearAllAttachments();
	});
</script>

<div class="">
	<!-- Hidden file input -->
	<input
		bind:this={fileInputElement}
		type="file"
		multiple
		accept={acceptedMimeTypes.join(',')}
		onchange={handleFileInputChange}
		class="hidden"
	/>

	<!-- Input container with modern design -->
	<div class="{isWelcomeState ? 'max-w-3xl mx-auto' : 'max-w-4xl mx-auto'} relative">
		<!-- File attachments preview -->
		<FileAttachmentPreview
			attachedFiles={fileHandling.attachedFiles}
			onRemove={handleRemoveAttachment}
		/>

		<!-- Slash command autocomplete (typing "/" surfaces slash-invocable Skills) -->
		{#if slashOpen}
			<SlashCommandMenu
				commands={slashMatches}
				activeIndex={slashActiveIndex}
				onselect={selectSlashCommand}
				onhover={(i) => (slashActiveIndex = i)}
			/>
		{/if}

		<!-- Main input area with drag and drop support -->
		<div
			class="
			relative z-10 flex items-end gap-3 lg:gap-4 overflow-hidden bg-white dark:bg-slate-900
			border border-slate-200 dark:border-slate-700 rounded-xl transition-all duration-200
			focus-within:ring-1 focus-within:ring-violet-500 {fileHandling.isDragging && 'ring-1 ring-violet-500'}"
			role="region"
			aria-label="Message input with file drop zone"
			ondragover={fileHandling.handleDragOver}
			ondragleave={fileHandling.handleDragLeave}
			ondrop={handleDrop}
		>
			<div class="flex-1 min-w-0">
				<!-- What this chat has changed so far, and the way into the detail -->
				<AiChangesSummary />

				<!-- Messages waiting for the current response -->
				<QueuedMessages isLoading={appState.isLoading} onEdit={handleEditQueued} />

				<!-- Edit Mode Indicator (own edit, or who else is editing) -->
				<EditModeIndicator onCancel={handleCancelEdit} />

				<!-- Engine/Model Picker -->
				<EngineModelPicker />

				<div class="flex items-end">
					<div class="relative flex-1 min-w-0 flex">
						<textarea
							bind:this={sizingMirror}
							class="{textareaClass} absolute inset-x-0 top-0 invisible pointer-events-none overflow-hidden"
							rows="1"
							tabindex="-1"
							aria-hidden="true"
							readonly
						></textarea>
						<textarea
							bind:this={textareaElement}
							bind:value={messageText}
							placeholder={chatPlaceholder}
							class="{textareaClass} disabled:opacity-50 disabled:cursor-not-allowed"
							rows="1"
							disabled={!hasActiveProject}
							enterkeyhint={isTouchKeyboard ? 'enter' : 'send'}
							aria-label="Message"
							oninput={handleTextareaInput}
							onkeydown={handleKeyDown}
							onpaste={handlePaste}
							oncompositionstart={chatActions.handleCompositionStart}
							oncompositionend={chatActions.handleCompositionEnd}
							autocomplete="off"
						></textarea>
					</div>

					<!-- Action buttons -->
					<ChatInputActions
						isLoading={appState.isLoading}
						isCancelling={appState.isCancelling}
						{hasActiveProject}
						attachmentCount={fileHandling.attachedFiles.length}
						isProcessingFiles={fileHandling.isProcessingFiles}
						{modelSupportsAttachments}
						{submitMode}
						{hasContent}
						{submitBlockedReason}
						onSubmit={handleSubmit}
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

<!-- Files another chat changed since the edited message: ask before overwriting -->
<ConflictResolutionModal
	isOpen={chatActions.conflicts.length > 0}
	conflicts={chatActions.conflicts}
	onConfirm={chatActions.resolveConflicts}
	onClose={chatActions.dismissConflicts}
/>

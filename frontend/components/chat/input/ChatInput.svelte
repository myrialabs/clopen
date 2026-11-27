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
	import { onDestroy, untrack } from 'svelte';
	import { ChatService } from '$frontend/services/chat';
	import { chatService } from '$frontend/services/chat/chat.service';
	import { modelStore } from '$frontend/stores/features/models.svelte';
	import { chatModelState } from '$frontend/stores/ui/chat-model.svelte';
	import { presenceState } from '$frontend/stores/core/presence.svelte';
	import { editModeState } from '$frontend/stores/ui/edit-mode.svelte';
	import { claudeAccountsStore } from '$frontend/stores/features/claude-accounts.svelte';
	import { takeQueued, type QueuedMessage } from '$frontend/stores/ui/message-queue.svelte';
	import { chatInputState, takeComposerAdditions } from '$frontend/stores/ui/chat-input.svelte';
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
	import MentionMenu, { type MentionItem } from './components/MentionMenu.svelte';
	import EngineModelPicker from './components/EngineModelPicker.svelte';
	import SlashCommandMenu from './components/SlashCommandMenu.svelte';
	import { hostingStore } from '$frontend/stores/features/hosting.svelte';
	import { searchMentions, captureMention, type MentionResults } from '$frontend/services/chat/mentions';
	import { CONTEXT_ICONS } from '$frontend/utils/context-icons';
	import { describeContext } from '$shared/utils/context-document';
	import type { MentionCandidate } from '$shared/types/mentions';
	import ConflictResolutionModal from '$frontend/components/checkpoint/ConflictResolutionModal.svelte';
	import { skillsStore, type AvailableSkill } from '$frontend/stores/features/skills.svelte';

	// Composables
	import {
		useFileHandling,
		attachmentFromBase64,
		type FileAttachment
	} from './composables/use-file-handling.svelte';
	import { usePlaceholderAnimation, useLoadingTextAnimation } from './composables/use-animations.svelte';
	import { useTextareaResize } from './composables/use-textarea-resize.svelte';
	import { useChatActions } from './composables/use-chat-actions.svelte';
	import { useInputState } from './composables/use-input-state.svelte';
	import { useChatDropTarget } from './composables/use-chat-drop-zone.svelte';
	import { getAttachmentIcon } from '$frontend/utils/file-icon-mappings';
	import { formatFileSize } from '$frontend/utils/format';
	import { mentionToken, removeAllMentions, removeMention, shiftMentions } from '$shared/utils/attachment-mentions';

	let messageText = $state('');
	// Where the caret is in the box, for the `@` picker.
	let caret = $state(0);
	let textareaElement: HTMLTextAreaElement;
	// Hidden twin of the textarea that measures the placeholder (see use-textarea-resize)
	let sizingMirror: HTMLTextAreaElement;
	// Shared by the textarea and its sizing mirror: identical classes mean
	// identical width, font and padding, so the measurement can't drift.
	const textareaClass =
		'w-full px-4 pt-3 pb-2 border-0 bg-transparent resize-none focus:outline-none text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 text-base leading-relaxed';
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
		// Setting a textarea's value puts the caret at the end.
		caret = text.length;
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

	// The `@` picker lists the repository's issues, so it needs to know which
	// service the repository is on even when the Git panel has never been
	// opened. Cheap and local — remotes against accounts.
	$effect(() => {
		if (projectState.currentProject?.id) untrack(() => void hostingStore.load());
	});

	// --- `@` mentions ---
	// Typing "@" lists everything a message can point at: its own files, and
	// whatever in the workspace can be attached as a snapshot (see
	// services/chat/mentions). Read at the caret (see `caret` above), not the
	// end of the text: a mention is often added to a sentence already written.
	let mentionActiveIndex = $state(0);
	let mentionDismissed = $state(false);
	/** The list opened from the root — "Terminals", "Commits", one database. */
	let mentionCategory = $state<{ id: string; label: string } | null>(null);
	let mentionResults = $state<MentionResults>({ items: [], categories: [] });
	let mentionLoading = $state(false);
	let mentionGeneration = 0;

	function syncCaret() {
		if (textareaElement) caret = textareaElement.selectionStart ?? messageText.length;
	}

	const mentionMatch = $derived.by(() => {
		if (slashQuery !== null || !hasActiveProject) return null;
		const before = messageText.slice(0, caret);
		const m = /(?:^|[\s([{"'])@([^\s@]{0,120})$/.exec(before);
		if (!m) return null;
		return { query: m[1], start: before.length - m[1].length - 1 };
	});

	/**
	 * The attachment whose `@N` the caret is on — being typed, or moved over —
	 * so its card can be shown. Null when the caret is on no such token.
	 */
	const caretAttachment = $derived.by(() => {
		const left = /(?:^|[\s([{"'“‘])@(\d{0,4})$/.exec(messageText.slice(0, caret));
		if (!left) return null;
		const digits = left[1] + (/^\d*/.exec(messageText.slice(caret))?.[0] ?? '');
		const number = Number(digits);
		return digits && number >= 1 && number <= fileHandling.attachedFiles.length ? number : null;
	});

	type MentionRow =
		| { item: MentionItem; action: 'attachment' }
		| { item: MentionItem; action: 'browse'; category: { id: string; label: string } }
		| { item: MentionItem; action: 'capture'; candidate: MentionCandidate };

	const mentionRows = $derived.by((): MentionRow[] => {
		const match = mentionMatch;
		if (!match) return [];
		const query = match.query.toLowerCase();
		const rows: MentionRow[] = [];

		if (!mentionCategory) {
			fileHandling.attachedFiles.forEach((attachment, i) => {
				const token = mentionToken(i + 1);
				const label = attachment.context ? describeContext(attachment.context) : attachment.file.name;
				if (query && !token.slice(1).startsWith(query) && !label.toLowerCase().includes(query)) return;
				rows.push({
					action: 'attachment',
					item: {
						key: `attachment:${attachment.id}`,
						group: 'Attached to this message',
						token,
						label,
						detail: attachment.context?.detail ?? formatFileSize(attachment.file.size),
						icon: attachment.context ? CONTEXT_ICONS[attachment.context.kind] : getAttachmentIcon(attachment.file.name, attachment.file.type),
						thumbnailUrl: attachment.type === 'image' ? attachment.previewUrl : undefined
					}
				});
			});
		}

		for (const candidate of mentionResults.items) {
			rows.push({
				action: candidate.browse ? 'browse' : 'capture',
				candidate,
				category: candidate.browse ? { id: candidate.browse, label: candidate.label } : undefined,
				item: { key: candidate.key, group: candidate.group, label: candidate.label, detail: candidate.detail, icon: candidate.icon, browse: !!candidate.browse }
			} as MentionRow);
		}

		for (const category of mentionResults.categories) {
			rows.push({
				action: 'browse',
				category: { id: category.id, label: category.label },
				item: { key: `category:${category.id}`, group: 'Browse', label: category.label, detail: category.detail, icon: category.icon, browse: true }
			});
		}
		return rows;
	});

	const mentionItems = $derived(mentionRows.map((row) => row.item));
	const mentionOpen = $derived(mentionMatch !== null && !mentionDismissed && (mentionRows.length > 0 || mentionLoading || mentionCategory !== null));

	// Look up what matches, a beat after the typing stops. A newer lookup wins.
	$effect(() => {
		const match = mentionMatch;
		const category = mentionCategory;
		const dismissed = mentionDismissed;
		if (!match || dismissed) {
			mentionGeneration++;
			mentionLoading = false;
			return;
		}
		const generation = ++mentionGeneration;
		mentionLoading = true;
		const handle = setTimeout(async () => {
			const results = await searchMentions(match.query, category?.id ?? null);
			if (generation !== mentionGeneration) return;
			mentionResults = results;
			mentionLoading = false;
		}, category ? 0 : 120);
		return () => clearTimeout(handle);
	});

	$effect(() => {
		if (mentionMatch === null) {
			mentionDismissed = false;
			mentionActiveIndex = 0;
			mentionCategory = null;
			mentionResults = { items: [], categories: [] };
		} else if (mentionActiveIndex >= mentionRows.length) {
			mentionActiveIndex = 0;
		}
	});

	/** Replace the `@query` being typed with `text`, leaving the caret after it. */
	function replaceMentionQuery(text: string): number | null {
		const match = mentionMatch;
		if (!match) return null;
		const after = messageText.slice(caret);
		const spacer = text.endsWith('@') || after.startsWith(' ') ? '' : ' ';
		const next = `${messageText.slice(0, match.start)}${text}${spacer}${after}`;
		const position = match.start + text.length + spacer.length;
		setMessageText(next);
		inputState.saveText();
		requestAnimationFrame(() => {
			if (!textareaElement) return;
			textareaElement.focus();
			textareaElement.setSelectionRange(position, position);
			caret = position;
			adjustTextareaHeight();
		});
		return match.start;
	}

	/**
	 * The `@` button: write an "@" at the caret — with a space before it when
	 * it would otherwise run into a word — so the picker opens as if typed.
	 */
	function startMention() {
		if (!textareaElement) return;
		const at = textareaElement.selectionStart ?? messageText.length;
		const end = textareaElement.selectionEnd ?? at;
		const before = messageText.slice(0, at);
		const insert = before && !/[\s([{"']$/.test(before) ? ' @' : '@';
		setMessageText(before + insert + messageText.slice(end));
		mentionDismissed = false;
		const position = at + insert.length;
		inputState.saveText();
		requestAnimationFrame(() => {
			if (!textareaElement) return;
			textareaElement.focus();
			textareaElement.setSelectionRange(position, position);
			caret = position;
			adjustTextareaHeight();
		});
	}

	function openMentionCategory(category: { id: string; label: string }) {
		mentionCategory = category;
		mentionResults = { items: [], categories: [] };
		mentionActiveIndex = 0;
		// What was typed searched the root; the list opens unfiltered.
		replaceMentionQuery('@');
	}

	function closeMentionCategory() {
		mentionCategory = null;
		mentionResults = { items: [], categories: [] };
		mentionActiveIndex = 0;
	}

	function selectMention(item: MentionItem) {
		const row = mentionRows.find((entry) => entry.item.key === item.key);
		if (!row) return;
		if (row.action === 'browse') {
			openMentionCategory(row.category);
			return;
		}
		if (row.action === 'attachment') {
			mentionDismissed = true;
			replaceMentionQuery(item.token!);
			return;
		}
		void captureIntoMessage(row.candidate);
	}

	let captureCount = 0;

	/**
	 * Attach a snapshot of what was picked and write its `@N` where the `@`
	 * was typed. The snapshot takes a moment — a terminal's scrollback, a
	 * diff, a page element — so a placeholder holds the spot in the text and
	 * the attachment row holds a card's place; typing carries on meanwhile.
	 */
	async function captureIntoMessage(candidate: MentionCandidate) {
		const placeholder = `@(adding ${candidate.label.slice(0, 40)}…${++captureCount > 1 ? ` ${captureCount}` : ''})`;
		mentionDismissed = true;
		mentionCategory = null;
		replaceMentionQuery(placeholder);
		const release = fileHandling.holdPlace();
		try {
			const captured = await captureMention(candidate.kind, candidate.ref);
			const restored = captured
				.map((a) => attachmentFromBase64({ fileName: a.fileName, mediaType: a.mediaType, base64: a.data }))
				.filter((a): a is FileAttachment => a !== null);
			if (restored.length === 0) throw new Error('Nothing was captured');
			const first = fileHandling.attachedFiles.length + 1;
			fileHandling.replaceAttachments([...fileHandling.attachedFiles, ...restored]);
			inputState.saveAttachments(fileHandling.attachedFiles);
			// A capture can bring more than one file — a page and its picture —
			// and every one of them is named.
			swapPlaceholder(placeholder, restored.map((_, i) => mentionToken(first + i)).join(' '));
		} catch (error) {
			swapPlaceholder(placeholder, '');
			addNotification({
				type: 'error',
				title: 'Could not attach',
				message: `${candidate.label}: ${error instanceof Error ? error.message : String(error)}`,
				duration: 5000
			});
		} finally {
			release();
		}
	}

	/** Put the token where its placeholder is — or at the end, if the placeholder was edited away. */
	function swapPlaceholder(placeholder: string, token: string) {
		const at = messageText.indexOf(placeholder);
		if (at !== -1) {
			const before = messageText.slice(0, at);
			let after = messageText.slice(at + placeholder.length);
			// Nothing to write: take the space that followed it too.
			if (!token && after.startsWith(' ') && (before === '' || before.endsWith(' '))) after = after.slice(1);
			replaceTextKeepingDraft(before + token + after);
		} else if (token) {
			replaceTextKeepingDraft(messageText.trim() ? `${messageText.trimEnd()} ${token} ` : `${token} `);
		}
	}

	// --- Attachments ---

	// Any file can be attached: the server sends what the model reads inline
	// and saves the rest into the session's folder, naming it in the prompt.

	// Every change to the attachments is saved to the draft right after it.
	async function afterAttachmentChange(change: Promise<unknown> | void) {
		await change;
		inputState.saveAttachments(fileHandling.attachedFiles);
	}

	/**
	 * Files added by paste, drop or the file picker are written into the text
	 * as their `@N`: where the caret is when the box has focus (a paste mid
	 * sentence), otherwise at the end.
	 */
	async function addFilesWithMentions(adding: Promise<FileAttachment[]>) {
		const focused = typeof document !== 'undefined' && document.activeElement === textareaElement;
		const at = focused ? (textareaElement?.selectionStart ?? messageText.length) : null;
		const added = await adding;
		inputState.saveAttachments(fileHandling.attachedFiles);
		writeMentionsFor(added, at);
	}

	/** Write the `@N` of attachments already in the list, at `at` or at the end. */
	function writeMentionsFor(attachments: FileAttachment[], at: number | null) {
		const tokens = attachments
			.map((attachment) => fileHandling.attachedFiles.findIndex((file) => file.id === attachment.id))
			.filter((index) => index !== -1)
			.map((index) => mentionToken(index + 1));
		if (tokens.length === 0) return;
		const text = tokens.join(' ');
		const position = at === null ? messageText.length : Math.min(at, messageText.length);
		const before = messageText.slice(0, position);
		const after = messageText.slice(position);
		const lead = before && !/\s$/.test(before) ? ' ' : '';
		const trail = after.startsWith(' ') ? '' : ' ';
		replaceTextKeepingDraft(`${before}${lead}${text}${trail}${after}`);
		const caretAt = before.length + lead.length + text.length + trail.length;
		if (at !== null) {
			requestAnimationFrame(() => {
				textareaElement?.setSelectionRange(caretAt, caretAt);
				caret = caretAt;
			});
		}
	}

	const handleFileInputChange = (event: Event) => addFilesWithMentions(fileHandling.handleFileInputChange(event));
	const handlePaste = (event: ClipboardEvent) => addFilesWithMentions(fileHandling.handlePaste(event));

	// Files dropped anywhere on the chat panel land here.
	useChatDropTarget((files) => {
		if (!hasActiveProject) return;
		void addFilesWithMentions(fileHandling.processFiles(files));
	});

	/** Put text in the box as if typed: saved, and the box re-fitted. */
	function replaceTextKeepingDraft(text: string) {
		if (text === messageText) return;
		setMessageText(text);
		inputState.saveText();
		setTimeout(() => adjustTextareaHeight(), 0);
	}

	// Removing a file renumbers the ones after it, and `@N` in the text follows:
	// later numbers move down, the removed file's own become its name.
	function handleRemoveAttachment(id: string) {
		const files = fileHandling.attachedFiles;
		const position = files.findIndex((file) => file.id === id);
		if (position === -1) return;
		const removed = files[position];
		replaceTextKeepingDraft(removeMention(messageText, position + 1, files.length));
		void afterAttachmentChange(fileHandling.removeAttachment(id));
	}

	function handleClearAllAttachments() {
		replaceTextKeepingDraft(removeAllMentions(messageText, fileHandling.attachedFiles.length));
		void afterAttachmentChange(fileHandling.clearAllAttachments());
	}

	// --- Event handlers ---

	const handleTextareaInput = () => {
		syncCaret();
		adjustTextareaHeight();
		inputState.saveText();
	};
	const handleKeyDown = (event: KeyboardEvent) => {
		// The `@` picker owns navigation keys while it is open.
		if (mentionOpen) {
			const count = mentionRows.length;
			if (event.key === 'ArrowDown' && count > 0) {
				event.preventDefault();
				mentionActiveIndex = (mentionActiveIndex + 1) % count;
				return;
			}
			if (event.key === 'ArrowUp' && count > 0) {
				event.preventDefault();
				mentionActiveIndex = (mentionActiveIndex - 1 + count) % count;
				return;
			}
			if ((event.key === 'Enter' || event.key === 'Tab') && count > 0) {
				event.preventDefault();
				selectMention(mentionRows[mentionActiveIndex].item);
				return;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				if (mentionCategory) closeMentionCategory();
				else mentionDismissed = true;
				return;
			}
			// Backspace on an empty query inside a list goes back to the root, not
			// through the `@`.
			if (event.key === 'Backspace' && mentionCategory && mentionMatch?.query === '') {
				event.preventDefault();
				closeMentionCategory();
				return;
			}
		}
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

	/**
	 * Add a message's text and attachments to what is in the box already. A
	 * mention sent from elsewhere also gets its `@N` written into the text.
	 */
	function appendToComposer(
		incomingText: string,
		attachments: { fileName: string; mediaType: string; data: string }[],
		mention = false
	) {
		const restored = attachments
			.map((a) => attachmentFromBase64({ fileName: a.fileName, mediaType: a.mediaType, base64: a.data }))
			.filter((a): a is FileAttachment => a !== null);
		const first = fileHandling.attachedFiles.length + 1;
		// Its `@1` meant its own first file, which now follows the ones already here.
		let text = shiftMentions(incomingText, fileHandling.attachedFiles.length, restored.length);
		const tokens = restored.map((_, i) => mentionToken(first + i)).join(' ');
		if (mention && restored.length > 0) text = text ? `${text} ${tokens} ` : `${tokens} `;
		if (text) {
			const joiner = mention ? ' ' : '\n\n';
			setMessageText(messageText.trim() ? `${messageText.trimEnd()}${joiner}${text}` : text);
		}
		if (restored.length > 0) {
			fileHandling.replaceAttachments([...fileHandling.attachedFiles, ...restored]);
			inputState.saveAttachments(fileHandling.attachedFiles);
		}
		inputState.saveText();
		textareaElement?.focus();
		setTimeout(() => adjustTextareaHeight(), 0);
	}

	// Take a queued message back into the box to change it.
	async function handleEditQueued(item: QueuedMessage) {
		try {
			const taken = await takeQueued(item.id);
			if (!taken) return;
			appendToComposer(taken.text, taken.attachments);
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

	// A message that never reached the server comes back into its session's
	// box; a screenshot sent from the preview lands here the same way.
	$effect(() => {
		const chatSessionId = sessionState.currentSession?.id;
		if (!chatSessionId || !chatInputState.pending.some((m) => m.chatSessionId === chatSessionId)) return;
		untrack(() => {
			for (const message of takeComposerAdditions(chatSessionId)) appendToComposer(message.text, message.attachments, message.mention);
		});
	});

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
			// Nothing is running, so a bubble still waiting for its echo never
			// gets one (it went missing with a dropped socket or an early Stop).
			if (sessionId && transcriptReady && !chatService.isStartPending(sessionId)) {
				void chatService.reconcileUnconfirmed(sessionId, { settled: true });
			}
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
				// Bring the streaming placeholders up to the server's text. Shared with
				// the gap repair in chatService, which is what keeps a snapshot from
				// rewinding text that live deltas have already extended.
				chatService.applyStreamSnapshot(streamState);

				// Reconnect to live stream events so future partials/messages/complete flow in
				chatService.reconnectToStream(chatSessionId, streamState.processId);

				// The user message's echo was sent while this client was away; the
				// saved row replaces the bubble still waiting for it.
				void chatService.reconcileUnconfirmed(chatSessionId, { settled: false });

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
		onchange={handleFileInputChange}
		class="hidden"
	/>

	<!-- Input container with modern design -->
	<div class="{isWelcomeState ? 'max-w-3xl mx-auto' : 'max-w-4xl mx-auto'} relative">
		<!-- Attached files: one sideways-scrolling row, numbered for `@N` -->
		<FileAttachmentPreview
			attachedFiles={fileHandling.attachedFiles}
			highlighted={caretAttachment}
			pendingCount={fileHandling.pendingCount}
			onRemove={handleRemoveAttachment}
			onClearAll={handleClearAllAttachments}
		/>

		{#if mentionOpen}
			<MentionMenu
				items={mentionItems}
				activeIndex={mentionActiveIndex}
				loading={mentionLoading}
				title={mentionCategory?.label ?? null}
				query={mentionMatch?.query ?? ''}
				onselect={selectMention}
				onhover={(i) => (mentionActiveIndex = i)}
				onback={closeMentionCategory}
			/>
		{/if}

		<!-- Slash command autocomplete (typing "/" surfaces slash-invocable Skills) -->
		{#if slashOpen}
			<SlashCommandMenu
				commands={slashMatches}
				activeIndex={slashActiveIndex}
				onselect={selectSlashCommand}
				onhover={(i) => (slashActiveIndex = i)}
			/>
		{/if}


		<!-- Main input area (files are dropped on the whole chat panel, see ChatPanel) -->
		<div
			class="
			relative z-10 flex items-end gap-3 lg:gap-4 overflow-hidden bg-white dark:bg-slate-900
			border border-slate-200 dark:border-slate-700 rounded-xl transition-all duration-200
			focus-within:ring-1 focus-within:ring-violet-500"
			role="region"
			aria-label="Message input"
		>
			<div class="flex-1 min-w-0">
				<!-- What this chat has changed so far, and the way into the detail -->
				<AiChangesSummary />

				<!-- Messages waiting for the current response -->
				<QueuedMessages isLoading={appState.isLoading} onEdit={handleEditQueued} />

				<!-- Edit Mode Indicator (own edit, or who else is editing) -->
				<EditModeIndicator onCancel={handleCancelEdit} />

				<!-- The text takes the whole width; what to send it with, and how, sit in one row below it -->
				<div class="flex">
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
							onkeyup={syncCaret}
							onclick={syncCaret}
							onselect={syncCaret}
							onpaste={handlePaste}
							oncompositionstart={chatActions.handleCompositionStart}
							oncompositionend={chatActions.handleCompositionEnd}
							autocomplete="off"
						></textarea>
					</div>
				</div>

				<!-- Toolbar: every picker is always visible with its choice. They wrap among themselves when the
				     box is narrow; the buttons keep their own column at the bottom right and are never alone. -->
				<div class="flex items-end gap-2 pl-3 pr-2 pb-2">
					<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-0.5">
						<EngineModelPicker />
					</div>

					<ChatInputActions
						isLoading={appState.isLoading}
						isCancelling={appState.isCancelling}
						{hasActiveProject}
						attachmentCount={fileHandling.attachedFiles.length}
						isProcessingFiles={fileHandling.isProcessingFiles}
						{submitMode}
						{hasContent}
						{submitBlockedReason}
						onSubmit={handleSubmit}
						onCancel={chatActions.cancelRequest}
						onAttachFile={() => fileHandling.handleFileSelect(fileInputElement)}
						onMention={startMention}
					/>
				</div>
			</div>
		</div>

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

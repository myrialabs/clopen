<script lang="ts">
	import { tick } from 'svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { taskClientStore } from '$frontend/stores/features/task-client.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { showError } from '$frontend/stores/ui/notification.svelte';
	import {
		gitDraft,
		markGitUiDirty,
		setCommitDraft,
		applyGeneratedCommitMessage,
		getGitOps,
		setGitOp
	} from '$frontend/stores/features/git-workspace.svelte';
	import ws from '$frontend/utils/ws';
	import GitMoreMenu, { type GitMoreAction } from '$frontend/components/git/GitMoreMenu.svelte';

	interface Props {
		stagedCount: number;
		isCommitting: boolean;
		onCommit: (message: string) => void;
		hasRemotes?: boolean;
		selectedRemote?: string;
		currentBranch?: string;
		branchAhead?: number;
		branchBehind?: number;
		isPushing?: boolean;
		isPulling?: boolean;
		isMoreBusy?: boolean;
		/** Repo is detached / mid-operation (rebase, merge, …) — block branch-targeted actions */
		repoBusy?: boolean;
		/** Human-readable reason shown in disabled button tooltips */
		repoBusyReason?: string;
		/** Absolute path to a nested repo; when set, actions operate inside that repo. */
		repoPath?: string;
		onCreateBranch?: (name: string) => boolean | Promise<boolean>;
		onPush?: () => void;
		onPull?: () => void;
		onMoreAction?: (action: GitMoreAction) => void;
	}

	const {
		stagedCount,
		isCommitting,
		onCommit,
		hasRemotes = false,
		selectedRemote = 'origin',
		currentBranch,
		branchAhead = 0,
		branchBehind = 0,
		isPushing = false,
		isPulling = false,
		isMoreBusy = false,
		repoBusy = false,
		repoBusyReason = '',
		repoPath,
		onCreateBranch,
		onPush,
		onPull,
		onMoreAction
	}: Props = $props();

	const showSyncActions = $derived(Boolean(onPush || onPull));

	// Branch operand shown in the sync-button tooltips (omitted when unknown).
	const branchRef = $derived(currentBranch ? ` ${currentBranch}` : '');

	// The commit message draft is per-project and lives in the git workspace
	// store so it survives remounts and is isolated/restored per project.
	let textareaEl = $state<HTMLTextAreaElement | null>(null);

	// Busy flags live in the per-project store so a generation started for one
	// project keeps its spinner (and clears the right project's flag) even after
	// the user switches projects mid-run.
	const activeProjectId = $derived(projectState.currentProject?.id ?? '');
	const ops = $derived(getGitOps(activeProjectId, repoPath));
	const isGenerating = $derived(ops.isGenerating);

	// Local commit message for nested repos so each submodule keeps its own draft.
	let localCommitMessage = $state('');
	const isGeneratingBranch = $derived(ops.isGeneratingBranch);
	const isCreatingBranch = $derived(ops.isCreatingBranch);

	let branchNameDraft = $state('');
	let showBranchDraft = $state(false);
	let showGenerateDropdown = $state(false);
	let showBranchSubmenu = $state(false);
	let generateBtnEl = $state<HTMLButtonElement | null>(null);
	let generateMenuStyle = $state('');

	function openGenerateMenu() {
		if (!generateBtnEl) return;
		const rect = generateBtnEl.getBoundingClientRect();
		const menuHeight = 120;
		generateMenuStyle = window.innerHeight - rect.bottom < menuHeight && rect.top > menuHeight
			? `right: ${window.innerWidth - rect.right}px; bottom: ${window.innerHeight - rect.top + 6}px;`
			: `right: ${window.innerWidth - rect.right}px; top: ${rect.bottom + 6}px;`;
		showGenerateDropdown = true;
		showBranchSubmenu = settings.commitGenerator.ticketSource === 'trello' && !!taskClientStore.selectedBoardId;
	}

	function handleGenerateClick() {
		if (!onCreateBranch) { generateCommitMessage(); return; }
		if (showGenerateDropdown) {
			showGenerateDropdown = false;
			showBranchSubmenu = false;
		} else {
			openGenerateMenu();
		}
	}

	function generateBoth() {
		generateCommitMessage();
		generateBranchName();
	}

	function handleCommit() {
		const message = repoPath ? localCommitMessage : gitDraft.commitMessage;
		if (!message.trim() || stagedCount === 0) return;
		onCommit(message.trim());
		if (repoPath) {
			localCommitMessage = '';
		} else {
			setCommitDraft(activeProjectId, '');
			markGitUiDirty();
		}
		autoResize();
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			handleCommit();
		}
	}

	function autoResize() {
		if (!textareaEl) return;
		// Reset to single line to measure content
		textareaEl.style.height = 'auto';
		// Line height is ~20px for text-sm, so 5 lines max = 100px
		const lineHeight = 20;
		const maxHeight = lineHeight * 5;
		const scrollHeight = textareaEl.scrollHeight;
		const newHeight = Math.min(scrollHeight, maxHeight);
		textareaEl.style.height = newHeight + 'px';
		textareaEl.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
	}

	// Re-fit the textarea height whenever the message changes from outside a
	// keystroke — restored on a project/tab switch, filled by AI generation, or
	// cleared after commit — so a multi-line draft doesn't render stuck at one row.
	$effect(() => {
		gitDraft.commitMessage;
		if (textareaEl && !repoPath) autoResize();
	});

	$effect(() => {
		localCommitMessage;
		if (textareaEl && repoPath) autoResize();
	});

	function handleInput() {
		autoResize();
		// Mirror the live edit into the per-project store, then persist (debounced)
		// so it survives refresh and never leaks across a project switch.
		// For nested repos, keep the draft local to this form only.
		if (!repoPath) {
			setCommitDraft(activeProjectId, gitDraft.commitMessage);
			markGitUiDirty();
		}
	}

	function buildCommitExtra(): string {
		const config = settings.commitGenerator.commitConfig;
		if (!config) return '';
		const { style, subjectLength, allowedTypes, context } = config;
		const parts: string[] = [];
		if (style === 'concise') parts.push('Be as concise as possible; avoid filler words.');
		if (style === 'descriptive') parts.push('Use natural, explanatory phrasing that is clear to any contributor reading the log.');
		if (subjectLength !== 72) parts.push(`Subject line must not exceed ${subjectLength} characters.`);
		const types = (allowedTypes ?? '').split(',').map(s => s.trim()).filter(Boolean);
		if (types.length) parts.push(`Type must be one of: ${types.join(', ')}.`);
		if (context?.trim()) parts.push(`Project context: ${context.trim()}`);
		return parts.join('\n');
	}

	function buildBranchExtra(source?: 'card' | 'diff'): string {
		const config = settings.commitGenerator.branchConfig;
		const parts: string[] = [];

		const useCard = source === 'card' || (source === undefined && settings.commitGenerator.ticketSource === 'trello' && taskClientStore.activeCardId);

		if (useCard) {
			const activeCardId = taskClientStore.activeCardId;
			if (activeCardId) {
				const activeCard = taskClientStore.cards.find(c => c.id === activeCardId);
				if (activeCard) {
					parts.push(`CRITICAL: The branch description MUST be generated directly from this task card title: "${activeCard.name}".`);
					
					const ticketLanguage = settings.commitGenerator.ticketLanguage;
					if (ticketLanguage === 'en') {
						parts.push('Write/translate the branch description in English.');
					}
				}
			}
		}

		if (!config) return parts.join('\n');
		const { maxWords, allowedPrefixes, context } = config;
		if (maxWords !== 3) parts.push(`Description must be at most ${maxWords} word${maxWords === 1 ? '' : 's'}.`);
		const prefixes = (allowedPrefixes ?? '').split(',').map(s => s.trim()).filter(Boolean);
		if (prefixes.length) parts.push(`Prefix must be one of: ${prefixes.join(', ')}.`);
		if (context?.trim()) parts.push(`Project context: ${context.trim()}`);
		return parts.join('\n');
	}

	async function generateCommitMessage() {
		const projectId = projectState.currentProject?.id;
		if (!projectId || stagedCount === 0 || isGenerating) return;

		setGitOp(projectId, 'isGenerating', true, repoPath);
		try {
			const { useCustomModel, engine, provider, modelId, format } = settings.commitGenerator;
			const resolvedEngine = useCustomModel ? engine : settings.selectedEngine;
			const resolvedProvider = useCustomModel ? provider : settings.selectedProvider;
			const resolvedModel = useCustomModel ? modelId : settings.selectedModelId;
			const extra = buildCommitExtra();
			const result = await ws.http('git:generate-commit-message', {
				projectId,
				engine: resolvedEngine,
				providerSlug: resolvedProvider,
				modelId: resolvedModel,
				format,
				...(repoPath && { repoPath }),
				...(extra && { customPrompt: extra })
			});
			// Route the result to the project it was generated for — only touches
			// the live commit box if that project is still active.
			if (repoPath) {
				localCommitMessage = result.message;
			} else {
				applyGeneratedCommitMessage(projectId, result.message);
			}
			markGitUiDirty();
			await tick();
			autoResize();
		} catch (err) {
			showError('Generate Failed', err instanceof Error ? err.message : 'Failed to generate commit message');
		} finally {
			setGitOp(projectId, 'isGenerating', false, repoPath);
		}
	}

	async function generateBranchName(source?: 'card' | 'diff') {
		const projectId = projectState.currentProject?.id;
		if (!projectId || stagedCount === 0 || isGeneratingBranch || repoBusy) return;

		setGitOp(projectId, 'isGeneratingBranch', true, repoPath);
		try {
			const { useCustomModel, engine, provider, modelId, branchSeparator, branchConfig, ticketSource, ticketPrefix } = settings.commitGenerator;
			const msgSep = branchConfig?.branchMessageSeparator !== undefined ? branchConfig.branchMessageSeparator : '-';

			// 1. Get the ticket ID/prefix if enabled and active
			let ticketId = '';
			if (ticketSource === 'trello') {
				const activeCardId = taskClientStore.activeCardId;
				if (activeCardId) {
					const activeCard = taskClientStore.cards.find(c => c.id === activeCardId);
					if (activeCard) {
						if (ticketPrefix === 'id-short' && activeCard.idShort) {
							ticketId = String(activeCard.idShort);
						} else if (activeCard.shortLink) {
							ticketId = activeCard.shortLink;
						} else {
							// fallback to parsing shortLink from Trello card URL
							const match = activeCard.url?.match(/\/c\/([a-zA-Z0-9]+)/);
							if (match) {
								ticketId = match[1];
							}
						}
					}
				}
			}

			// Fallback to AI generation
			const resolvedEngine = useCustomModel ? engine : settings.selectedEngine;
			const resolvedProvider = useCustomModel ? provider : settings.selectedProvider;
			const resolvedModel = useCustomModel ? modelId : settings.selectedModelId;
			const extra = buildBranchExtra(source);

			const result = await ws.http('git:generate-branch-name', {
				projectId,
				engine: resolvedEngine,
				providerSlug: resolvedProvider,
				modelId: resolvedModel,
				branchSeparator,
				maxWords: branchConfig?.maxWords ?? 3,
				...(repoPath && { repoPath }),
				...(extra && { customPrompt: extra })
			});

			let branchName = result.branchName;
			
			// Find the separator index that divides the prefix and the description
			const sepIdx = branchSeparator ? branchName.indexOf(branchSeparator) : -1;
			let prefix = '';
			let description = branchName;
			if (sepIdx !== -1) {
				prefix = branchName.slice(0, sepIdx + branchSeparator.length);
				description = branchName.slice(sepIdx + branchSeparator.length);
			}

			// Format the description with the custom branch message separator (defaulting to '-')
			let formattedDesc = description.split('-').join(msgSep);

			// 2. Prepends the ticket ID if found
			if (ticketId) {
				if (formattedDesc) {
					formattedDesc = `${ticketId}${msgSep}${formattedDesc}`;
				} else {
					formattedDesc = ticketId;
				}
			}

			branchName = `${prefix}${formattedDesc}`;

			branchNameDraft = branchName;
			showBranchDraft = true;
		} catch (err) {
			showError('Generate Branch Failed', err instanceof Error ? err.message : 'Failed to generate branch name');
		} finally {
			setGitOp(projectId, 'isGeneratingBranch', false, repoPath);
		}
	}

	async function createGeneratedBranch() {
		const projectId = projectState.currentProject?.id;
		if (!projectId || !onCreateBranch || !branchNameDraft.trim() || isCreatingBranch) return;

		setGitOp(projectId, 'isCreatingBranch', true, repoPath);
		try {
			const created = await onCreateBranch(branchNameDraft.trim());
			if (created !== false) {
				branchNameDraft = '';
				showBranchDraft = false;
			}
		} finally {
			setGitOp(projectId, 'isCreatingBranch', false, repoPath);
		}
	}

	let showCardSelector = $state(false);
	let cardSearchQuery = $state('');
	let selectedListId = $state<string | null>(null);
	let listContainerEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		if (listContainerEl) {
			// Trigger on dropdown open, board change, or list change
			const _open = showCardSelector;
			const _board = taskClientStore.selectedBoardId;
			const _list = selectedListId;
			listContainerEl.scrollTop = 0;
		}
	});

	const filteredCards = $derived(
		taskClientStore.cards.filter(c =>
			c.idList === selectedListId && (
				!cardSearchQuery.trim() ||
				c.name.toLowerCase().includes(cardSearchQuery.toLowerCase()) ||
				String(c.idShort || '').includes(cardSearchQuery) ||
				(c.shortLink || '').toLowerCase().includes(cardSearchQuery.toLowerCase())
			)
		)
	);

	const filteredLists = $derived(
		taskClientStore.lists.filter(l =>
			!cardSearchQuery.trim() ||
			l.name.toLowerCase().includes(cardSearchQuery.toLowerCase())
		)
	);

	function openCardSelector() {
		showCardSelector = true;
		cardSearchQuery = '';
		if (taskClientStore.activeCardId) {
			const activeCard = taskClientStore.cards.find(c => c.id === taskClientStore.activeCardId);
			if (activeCard) {
				selectedListId = activeCard.idList;
				return;
			}
		}
		selectedListId = null;
	}

	const sortedBoards = $derived(
		taskClientStore.boards.map(board => ({
			...board,
			isStarred: taskClientStore.boardStars.some(s => s.idBoard === board.id)
		})).sort((a, b) => {
			if (a.isStarred && !b.isStarred) return -1;
			if (!a.isStarred && b.isStarred) return 1;
			return a.name.localeCompare(b.name);
		})
	);

	const filteredBoards = $derived(
		sortedBoards.filter(b =>
			!cardSearchQuery.trim() ||
			b.name.toLowerCase().includes(cardSearchQuery.toLowerCase())
		)
	);

	function selectTrelloCard(cardId: string) {
		taskClientStore.activeCardId = cardId;
		showCardSelector = false;
	}

	function clearActiveCard() {
		taskClientStore.activeCardId = null;
	}
</script>

<div class="px-2 py-2">
	{#if settings.commitGenerator.ticketSource === 'trello'}
		{@const activeCard = taskClientStore.cards.find(c => c.id === taskClientStore.activeCardId)}
		<div class="relative flex items-center mb-2">
			{#if activeCard}
				{@const activeTicketLabel = settings.commitGenerator.ticketPrefix === 'id-short' && activeCard.idShort ? `#${activeCard.idShort}` : (activeCard.shortLink || '')}
				<!-- Linked Card Card -->
				<div class="flex items-center justify-between w-full gap-3 p-2 rounded-md border border-slate-200 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-900/30 text-xs shadow-sm">
					<div class="flex items-center gap-2.5 min-w-0">
						<div class="flex items-center justify-center w-5 h-5 rounded-md bg-violet-500/10 text-violet-500 dark:text-violet-400 shrink-0">
							<Icon name="lucide:trello" class="w-3.5 h-3.5" />
						</div>
						{#if activeTicketLabel}
							<span class="font-mono text-[10px] font-bold bg-violet-500/10 text-violet-600 dark:text-violet-400 px-1.5 py-0.5 rounded border border-violet-500/20 shrink-0">
								{activeTicketLabel}
							</span>
						{/if}
						{#if activeCard.url}
							<a
								href={activeCard.url}
								target="_blank"
								rel="noopener noreferrer"
								class="truncate font-medium text-slate-700 dark:text-slate-200 hover:text-violet-600 dark:hover:text-violet-400 hover:underline min-w-0"
							>
								{activeCard.name}
							</a>
						{:else}
							<span class="truncate font-medium text-slate-700 dark:text-slate-200">{activeCard.name}</span>
						{/if}
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<button
							type="button"
							onclick={openCardSelector}
							class="text-[10px] font-semibold text-violet-600 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300 hover:underline cursor-pointer border-none bg-transparent"
						>
							Change
						</button>
						<div class="w-[1px] h-3 bg-slate-200 dark:bg-slate-800"></div>
						<button
							type="button"
							onclick={clearActiveCard}
							class="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-350 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer border-none bg-transparent flex items-center justify-center"
							aria-label="Clear active card"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>
				</div>
			{:else}
				<!-- Unlinked Placeholder Card -->
				<button
					type="button"
					onclick={openCardSelector}
					class="flex items-center gap-2 p-2 w-full rounded-md border border-dashed border-slate-200 dark:border-slate-800 hover:border-violet-500/40 bg-slate-50/50 dark:bg-slate-900/10 hover:bg-violet-500/5 dark:hover:bg-violet-500/5 text-xs text-slate-500 hover:text-violet-600 dark:text-slate-400 dark:hover:text-violet-400 cursor-pointer transition-all duration-200 text-left"
				>
					<Icon name="lucide:trello" class="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
					<span class="font-medium">Link Trello card...</span>
				</button>
			{/if}
			
			<!-- Card Selector Dropdown -->
			{#if showCardSelector}
				<!-- Click outside backdrop to close -->
				<button type="button" class="fixed inset-0 z-40 bg-transparent cursor-default border-none w-full h-full" onclick={() => showCardSelector = false}></button>
				
				<div class="absolute top-full mt-1 left-0 z-50 w-72 p-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl flex flex-col gap-1.5 animate-in fade-in slide-in-from-top-2 duration-150">
					<!-- Search input -->
					<div class="relative flex items-center px-2.5 py-1.5 bg-slate-50 dark:bg-slate-900 rounded-md border border-slate-200 dark:border-slate-800 focus-within:border-slate-350 dark:focus-within:border-slate-700">
						<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 mr-2 shrink-0" />
						<input
							type="text"
							bind:value={cardSearchQuery}
							placeholder={!taskClientStore.selectedBoardId ? "Search boards..." : !selectedListId ? "Search lists..." : "Search cards..."}
							class="w-full bg-transparent border-none text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-0 p-0"
						/>
					</div>
					
					<!-- Cards List -->
					<div bind:this={listContainerEl} class="flex-grow overflow-y-auto max-h-48 pr-0.5 flex flex-col gap-0.5">
						{#if !taskClientStore.selectedBoardId}
							{#if taskClientStore.accounts.length === 0}
								<div class="text-xs text-slate-500 text-center py-4">
									No Trello account connected.
									<div class="text-[10px] text-slate-400 mt-1">Please connect your account in the Task Client.</div>
								</div>
							{:else}
								{#if taskClientStore.loadingBoards}
									<div class="text-xs text-slate-500 text-center py-4 flex items-center justify-center gap-1.5">
										<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin text-violet-500" />
										<span>Loading boards...</span>
									</div>
								{:else if taskClientStore.boards.length === 0}
									<div class="text-xs text-slate-500 text-center py-4 px-2">
										No boards found.
										<button
											type="button"
											onclick={() => taskClientStore.loadBoards()}
											class="mt-2 w-full px-2 py-1 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800 rounded text-slate-700 dark:text-slate-300 font-medium text-[11px] cursor-pointer transition-colors"
										>
											Reload Boards
										</button>
									</div>
								{:else if filteredBoards.length === 0}
									<div class="text-xs text-slate-500 text-center py-4 px-2">No boards match your search.</div>
								{:else}
									{@const starred = filteredBoards.filter(b => b.isStarred)}
									{@const unstarred = filteredBoards.filter(b => !b.isStarred)}

									{#if starred.length > 0}
										<div class="px-2.5 py-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider shrink-0">Starred Boards</div>
										{#each starred as board}
											<button
												type="button"
												class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left border-none cursor-pointer text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-900 bg-transparent text-slate-700 dark:text-slate-350 hover:text-slate-900 dark:hover:text-slate-100 font-medium"
												onclick={() => { taskClientStore.selectBoard(board.id); selectedListId = null; cardSearchQuery = ''; }}
											>
												<Icon name="lucide:star" class="w-3.5 h-3.5 text-amber-500 fill-amber-500 shrink-0" />
												<span class="truncate">{board.name}</span>
											</button>
										{/each}
										
										{#if unstarred.length > 0}
											<div class="h-[1px] bg-slate-100 dark:bg-slate-900 my-1 shrink-0"></div>
										{/if}
									{/if}

									{#if unstarred.length > 0}
										{#if starred.length > 0}
											<div class="px-2.5 py-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider shrink-0">All Boards</div>
										{/if}
										{#each unstarred as board}
											<button
												type="button"
												class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left border-none cursor-pointer text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-900 bg-transparent text-slate-650 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
												onclick={() => { taskClientStore.selectBoard(board.id); selectedListId = null; cardSearchQuery = ''; }}
											>
												<Icon name="lucide:trello" class="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
												<span class="truncate font-medium">{board.name}</span>
											</button>
										{/each}
									{/if}
								{/if}
							{/if}
						{:else}
							<!-- Header with active board name and a Switch Board button -->
							<div class="flex flex-col border-b border-slate-100 dark:border-slate-900/60 pb-1.5 mb-1.5 shrink-0 gap-1 px-2.5">
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-1.5 min-w-0">
										<Icon name="lucide:trello" class="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
										<div class="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 font-semibold truncate">
											<span class="uppercase tracking-wider">Board:</span>
											<span class="text-slate-700 dark:text-slate-300 font-bold truncate max-w-[130px]">{taskClientStore.selectedBoard?.name ?? 'Loading...'}</span>
										</div>
									</div>
									<button
										type="button"
										onclick={() => { taskClientStore.selectBoard(null); selectedListId = null; cardSearchQuery = ''; }}
										class="text-[10px] text-violet-650 dark:text-violet-400 hover:underline cursor-pointer border-none bg-transparent font-medium shrink-0"
									>
										Switch
									</button>
								</div>

								{#if selectedListId}
									{@const activeList = taskClientStore.lists.find(l => l.id === selectedListId)}
									<div class="flex items-center justify-between border-t border-slate-50 dark:border-slate-900/40 pt-1 mt-0.5">
										<div class="flex items-center gap-1.5 min-w-0">
											<Icon name="lucide:list" class="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
											<div class="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 font-semibold truncate font-semibold truncate">
												<span class="uppercase tracking-wider">List:</span>
												<span class="text-slate-700 dark:text-slate-300 font-bold truncate max-w-[140px]">{activeList?.name ?? 'Loading...'}</span>
											</div>
										</div>
										<button
											type="button"
											onclick={() => { selectedListId = null; cardSearchQuery = ''; }}
											class="text-[10px] text-violet-650 dark:text-violet-400 hover:underline cursor-pointer border-none bg-transparent font-medium shrink-0"
										>
											Back
										</button>
									</div>
								{/if}
							</div>

							{#if !selectedListId}
								{#if taskClientStore.loadingCards}
									<div class="text-xs text-slate-500 text-center py-4 flex items-center justify-center gap-1.5">
										<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin text-violet-500" />
										<span>Loading lists...</span>
									</div>
								{:else if filteredLists.length === 0}
									<div class="text-xs text-slate-500 text-center py-4 px-2">No lists match your search.</div>
								{:else}
									<div class="px-2.5 py-1 text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider shrink-0">Select a List:</div>
									{#each filteredLists as list}
										<button
											type="button"
											class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left border-none cursor-pointer text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-900 bg-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
											onclick={() => { selectedListId = list.id; cardSearchQuery = ''; }}
										>
											<Icon name="lucide:list" class="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
											<span class="truncate font-medium">{list.name}</span>
										</button>
									{/each}
								{/if}
							{:else}
								{#if taskClientStore.loadingCards}
									<div class="text-xs text-slate-500 text-center py-4 flex items-center justify-center gap-1.5">
										<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin text-violet-500" />
										<span>Loading cards...</span>
									</div>
								{:else if filteredCards.length === 0}
									<div class="text-xs text-slate-500 text-center py-4">No cards found.</div>
								{:else}
									{#each filteredCards as card}
										{@const isActive = card.id === taskClientStore.activeCardId}
										{@const ticketLabel = settings.commitGenerator.ticketPrefix === 'id-short' && card.idShort ? `#${card.idShort}` : (card.shortLink || '')}
										<button
											type="button"
											class="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left border-none cursor-pointer text-xs transition-colors bg-transparent text-slate-700 dark:text-slate-350 hover:bg-slate-50 dark:hover:bg-slate-900 hover:text-slate-900 dark:hover:text-slate-100 {isActive ? 'bg-violet-500/5 dark:bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium' : ''}"
											onclick={() => selectTrelloCard(card.id)}
										>
											{#if ticketLabel}
												<span class="font-mono text-[9px] font-semibold px-1.5 py-0.5 rounded border shrink-0 text-center {isActive ? 'bg-violet-500/10 dark:bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/20 dark:border-violet-500/30' : 'bg-slate-50 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-200/60 dark:border-slate-850'}">
													{ticketLabel}
												</span>
											{/if}
											<span class="line-clamp-2 leading-tight">{card.name}</span>
										</button>
									{/each}
								{/if}
							{/if}
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}
	<div class="flex flex-col gap-1.5">
			<textarea
			bind:this={textareaEl}
			value={repoPath ? localCommitMessage : gitDraft.commitMessage}
			placeholder="Commit message..."
			class="w-full px-2.5 py-2 text-sm bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 resize-none outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
			rows="1"
			style="overflow-y: hidden;"
			onkeydown={handleKeydown}
			oninput={(e) => {
				const val = (e.target as HTMLTextAreaElement).value;
				if (repoPath) {
					localCommitMessage = val;
				} else {
					gitDraft.commitMessage = val;
				}
				handleInput();
			}}
			disabled={isCommitting || isGenerating}
		></textarea>
		{#if showBranchDraft}
			<div class="flex items-center overflow-hidden rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800/80">
				<div class="min-w-0 flex-1 px-2.5">
					<input
						type="text"
						bind:value={branchNameDraft}
						class="w-full bg-transparent border-none outline-none text-xs text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
						placeholder="dev/login"
						disabled={isCreatingBranch}
					/>
				</div>
				<button
					type="button"
					class="flex items-center justify-center gap-1.5 h-7 px-2.5 border-l border-slate-200 dark:border-slate-700 text-xs font-medium transition-all duration-150 shrink-0
						{branchNameDraft.trim() && !isCreatingBranch
							? 'bg-violet-600 text-white hover:bg-violet-700 cursor-pointer'
							: 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'}"
					onclick={createGeneratedBranch}
					disabled={!branchNameDraft.trim() || isCreatingBranch}
					title="Create and switch to this branch"
				>
					{#if isCreatingBranch}
						<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
					{:else}
						<Icon name="lucide:git-branch-plus" class="w-3.5 h-3.5" />
					{/if}
					<span>Create</span>
				</button>
				<button
					type="button"
					class="flex items-center justify-center w-8 h-7 border-l border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-600 hover:bg-slate-50 dark:hover:text-slate-300 dark:hover:bg-slate-700/50 transition-colors shrink-0"
					onclick={() => { showBranchDraft = false; }}
					disabled={isCreatingBranch}
					aria-label="Cancel generated branch"
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
			</div>
		{/if}
		<div class="flex items-center gap-1.5">
			<button
				type="button"
				class="flex items-center justify-center gap-1.5 flex-1 h-7 px-3 border rounded-md text-xs font-medium transition-all duration-150
						{stagedCount > 0 && (repoPath ? localCommitMessage : gitDraft.commitMessage).trim() && !isCommitting
						? 'bg-violet-600 border-violet-700 text-white hover:bg-violet-700 cursor-pointer'
						: 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-600 cursor-not-allowed'}"
				onclick={handleCommit}
					disabled={stagedCount === 0 || !(repoPath ? localCommitMessage : gitDraft.commitMessage).trim() || isCommitting}
			>
				{#if isCommitting}
					<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
					<span>Committing...</span>
				{:else}
					<Icon name="lucide:check" class="w-3.5 h-3.5" />
					<span>Commit{stagedCount > 0 ? ` (${stagedCount})` : ''}</span>
				{/if}
			</button>
			<div class="relative h-7 flex-shrink-0" use:clickOutside={() => { showGenerateDropdown = false; showBranchSubmenu = false; }}>
				<button
					bind:this={generateBtnEl}
					type="button"
					class="flex items-center justify-center w-8 h-7 rounded-md bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-slate-800/80 disabled:hover:text-slate-500 flex-shrink-0
						{showGenerateDropdown ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : ''}"
					onclick={handleGenerateClick}
					disabled={(stagedCount === 0 && !(settings.commitGenerator.ticketSource === 'trello' && taskClientStore.selectedBoardId)) || isGenerating || isGeneratingBranch || isCommitting}
					title={onCreateBranch ? 'AI generation options' : stagedCount > 0 ? 'Generate commit message' : 'Stage changes first'}
					aria-haspopup="menu"
					aria-expanded={showGenerateDropdown}
				>
					{#if isGenerating || isGeneratingBranch}
						<div class="w-3.5 h-3.5 border-2 border-slate-300/30 border-t-slate-500 rounded-full animate-spin flex-shrink-0"></div>
					{:else}
						<Icon name="lucide:sparkles" class="w-3.5 h-3.5 flex-shrink-0" />
					{/if}
				</button>
				{#if showGenerateDropdown && onCreateBranch}
					<div
						class="fixed w-52 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 py-1.5"
						style={generateMenuStyle}
						role="menu"
						transition:scale={{ duration: 130, easing: cubicOut, start: 0.95, opacity: 0 }}
					>
						<button
							type="button"
							role="menuitem"
							class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left bg-transparent border-none transition-colors
								{stagedCount === 0 || isCommitting ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 cursor-pointer'}"
							onclick={() => { showGenerateDropdown = false; generateCommitMessage(); }}
							disabled={stagedCount === 0 || isCommitting}
						>
							<Icon name="lucide:message-square" class="w-3.5 h-3.5 flex-shrink-0" />
							<span class="flex-1 text-xs font-medium truncate">Generate commit message</span>
						</button>
						{#if settings.commitGenerator.ticketSource === 'trello' && taskClientStore.selectedBoardId}
							<div>
								<button
									type="button"
									role="menuitem"
									class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left bg-transparent border-none transition-colors
										{(stagedCount === 0 && !taskClientStore.activeCardId) || repoBusy ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 cursor-pointer'}"
									onclick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										showBranchSubmenu = !showBranchSubmenu;
									}}
									disabled={(stagedCount === 0 && !taskClientStore.activeCardId) || repoBusy}
								>
									<Icon name="lucide:git-branch-plus" class="w-3.5 h-3.5 flex-shrink-0" />
									<span class="flex-1 text-xs font-medium truncate">Generate branch name</span>
									<Icon name={showBranchSubmenu ? "lucide:chevron-down" : "lucide:chevron-right"} class="w-3 h-3 text-slate-400 flex-shrink-0 ml-auto" />
								</button>
								{#if showBranchSubmenu}
									<div class="pl-4 py-1 bg-slate-50/50 dark:bg-slate-900/20 border-l border-slate-200 dark:border-slate-700 ml-4 mr-2 my-1 flex flex-col gap-0.5 rounded-r">
										<button
											type="button"
											class="flex w-full items-center gap-2 px-2 py-1 text-left bg-transparent border-none rounded text-[11px] font-medium transition-colors
												{!taskClientStore.activeCardId || repoBusy ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer'}"
											onclick={() => { showGenerateDropdown = false; showBranchSubmenu = false; generateBranchName('card'); }}
											disabled={!taskClientStore.activeCardId || repoBusy}
											title={!taskClientStore.activeCardId ? 'Select a card first' : ''}
										>
											<Icon name="lucide:file-text" class="w-3 h-3 flex-shrink-0" />
											<span class="truncate">From card title</span>
										</button>
										<button
											type="button"
											class="flex w-full items-center gap-2 px-2 py-1 text-left bg-transparent border-none rounded text-[11px] font-medium transition-colors
												{stagedCount === 0 || repoBusy ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-600 dark:text-slate-300 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 cursor-pointer'}"
											onclick={() => { showGenerateDropdown = false; showBranchSubmenu = false; generateBranchName('diff'); }}
											disabled={stagedCount === 0 || repoBusy}
										>
											<Icon name="lucide:file-diff" class="w-3 h-3 flex-shrink-0" />
											<span class="truncate">From diff</span>
										</button>
									</div>
								{/if}
							</div>
						{:else}
							<button
								type="button"
								role="menuitem"
								class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left bg-transparent border-none transition-colors
									{stagedCount === 0 || repoBusy ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 cursor-pointer'}"
								onclick={() => { showGenerateDropdown = false; generateBranchName(); }}
								disabled={stagedCount === 0 || repoBusy}
							>
								<Icon name="lucide:git-branch-plus" class="w-3.5 h-3.5 flex-shrink-0" />
								<span class="flex-1 text-xs font-medium truncate">Generate branch name</span>
							</button>
						{/if}
						<div class="my-1 mx-2 border-t border-slate-200 dark:border-slate-700/70"></div>
						<button
							type="button"
							role="menuitem"
							class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left bg-transparent border-none transition-colors
								{stagedCount === 0 || repoBusy || isCommitting ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed' : 'text-slate-700 dark:text-slate-200 hover:bg-violet-500/10 cursor-pointer'}"
							onclick={() => { showGenerateDropdown = false; generateBoth(); }}
							disabled={stagedCount === 0 || repoBusy || isCommitting}
						>
							<Icon name="lucide:zap" class="w-3.5 h-3.5 flex-shrink-0" />
							<span class="flex-1 text-xs font-medium truncate">Generate both</span>
						</button>
					</div>
				{/if}
			</div>

			{#if showSyncActions}
				<!-- Push -->
				<button
					type="button"
					class="relative flex items-center justify-center w-8 h-7 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-slate-800/80 disabled:hover:text-slate-500 flex-shrink-0"
					onclick={onPush}
					disabled={isPushing || !hasRemotes || !onPush || repoBusy}
					title={repoBusy ? repoBusyReason : hasRemotes ? `Push${branchAhead > 0 ? ` (${branchAhead} ahead)` : ''} — git push -u ${selectedRemote}${branchRef}` : 'No remote configured'}
				>
					{#if isPushing}
						<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin flex-shrink-0"></div>
					{:else}
						<Icon name="lucide:arrow-up-from-line" class="w-3.5 h-3.5 flex-shrink-0" />
						{#if branchAhead > 0}
							<span class="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 rounded-full bg-violet-600 text-white text-3xs font-semibold flex items-center justify-center flex-shrink-0">{branchAhead}</span>
						{/if}
					{/if}
				</button>

				<!-- Pull -->
				<button
					type="button"
					class="relative flex items-center justify-center w-8 h-7 bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 rounded-md text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-slate-800/80 disabled:hover:text-slate-500 flex-shrink-0"
					onclick={onPull}
					disabled={isPulling || !hasRemotes || !onPull || repoBusy}
					title={repoBusy ? repoBusyReason : hasRemotes ? `Pull${branchBehind > 0 ? ` (${branchBehind} behind)` : ''} — git pull ${selectedRemote}${branchRef}` : 'No remote configured'}
				>
					{#if isPulling}
						<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin flex-shrink-0"></div>
					{:else}
						<Icon name="lucide:arrow-down-to-line" class="w-3.5 h-3.5 flex-shrink-0" />
						{#if branchBehind > 0}
							<span class="absolute -top-1 -right-1 min-w-3.5 h-3.5 px-0.5 rounded-full bg-violet-600 text-white text-3xs font-semibold flex items-center justify-center flex-shrink-0">{branchBehind}</span>
						{/if}
					{/if}
				</button>

			{/if}

			{#if onMoreAction}
				<!-- More git actions -->
				<GitMoreMenu
					isBusy={isMoreBusy}
					{hasRemotes}
					{selectedRemote}
					{currentBranch}
					onAction={onMoreAction}
				/>
			{/if}
		</div>
	</div>
</div>

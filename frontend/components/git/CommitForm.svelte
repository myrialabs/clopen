<script lang="ts">
	import { tick } from 'svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { settings } from '$frontend/stores/features/settings.svelte';
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
	}

	function handleGenerateClick() {
		if (!onCreateBranch) { generateCommitMessage(); return; }
		showGenerateDropdown ? (showGenerateDropdown = false) : openGenerateMenu();
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

	function buildBranchExtra(): string {
		const config = settings.commitGenerator.branchConfig;
		if (!config) return '';
		const { maxWords, allowedPrefixes, context } = config;
		const parts: string[] = [];
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

	async function generateBranchName() {
		const projectId = projectState.currentProject?.id;
		if (!projectId || stagedCount === 0 || isGeneratingBranch || repoBusy) return;

		setGitOp(projectId, 'isGeneratingBranch', true, repoPath);
		try {
			const { useCustomModel, engine, provider, modelId, branchSeparator, branchConfig } = settings.commitGenerator;
			const resolvedEngine = useCustomModel ? engine : settings.selectedEngine;
			const resolvedProvider = useCustomModel ? provider : settings.selectedProvider;
			const resolvedModel = useCustomModel ? modelId : settings.selectedModelId;
			const extra = buildBranchExtra();
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
			branchNameDraft = result.branchName;
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
</script>

<div class="px-2 py-2">
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
			<div class="relative h-7 flex-shrink-0" use:clickOutside={() => showGenerateDropdown = false}>
				<button
					bind:this={generateBtnEl}
					type="button"
					class="flex items-center justify-center w-8 h-7 rounded-md bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white dark:disabled:hover:bg-slate-800/80 disabled:hover:text-slate-500 flex-shrink-0
						{showGenerateDropdown ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : ''}"
					onclick={handleGenerateClick}
					disabled={stagedCount === 0 || isGenerating || isGeneratingBranch || isCommitting}
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

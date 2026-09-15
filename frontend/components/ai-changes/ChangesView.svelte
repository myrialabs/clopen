<script lang="ts">
	/**
	 * Everything this chat changed, turn by turn.
	 *
	 * The editor's gutter answers "what happened to this file"; this answers
	 * "what happened, across every file" — which is the only way to review a long
	 * session without opening each file in turn and remembering what you saw.
	 *
	 * Grouping flips between the two readings of the same data: by turn ("what
	 * did this instruction do") and by file ("everything that happened to this
	 * file"). Both come from the same turn list, so neither can be more current
	 * than the other.
	 */
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MonacoDiffEditor from '$frontend/components/common/editor/MonacoDiffEditor.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { gitStatusState } from '$frontend/stores/features/git-status.svelte';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import {
		aiChangesState,
		turnId,
		requestAiReveal,
		type TurnChanges,
		type TurnFileChange
	} from '$frontend/stores/features/ai-changes.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import { toAbsolutePath } from '$frontend/utils/ai-change-index';
	import { acquireFileWatch } from '$frontend/utils/file-watch';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		/** Session to describe. Defaults to whatever the store already holds. */
		sessionId: string | undefined;
		/** Absolute path to select on open, if the caller came from a file. */
		focusPath?: string | null;
		/** Close the dialog. Rendered in the sidebar header, the way Notes does it. */
		onClose?: () => void;
		/** Close the dialog when jumping out to the editor. */
		onNavigateAway?: () => void;
	}

	const { sessionId, focusPath = null, onClose, onNavigateAway }: Props = $props();

	// One size for every row action, matching NotesSidebar so the two dialogs sit
	// on the same visual grid.
	const ROW_ACTION =
		'flex items-center justify-center w-6 h-6 shrink-0 rounded-md text-slate-400 transition-colors';
	const ROW_ICON = 'w-3.5 h-3.5';

	type Grouping = 'turn' | 'file';

	let grouping = $state<Grouping>('turn');
	/**
	 * Narrow screens get one pane at a time: the list, then the diff with a way
	 * back. Two columns inside a phone-width dialog left the diff about 150px
	 * wide, which is not a diff so much as a rumour of one.
	 */
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
	const isNarrow = $derived(windowWidth < 768);
	let search = $state('');
	let uncommittedOnly = $state(false);
	let expandedTurns = $state(new Set<string>());
	let expandedFiles = $state(new Set<string>());
	let selected = $state<{ turn: TurnChanges; file: TurnFileChange } | null>(null);
	let diff = $state<{ before: string; after: string; isBinary: boolean } | null>(null);
	let diffLoading = $state(false);
	let diffError = $state<string | null>(null);

	/** Turns for a session other than the one the store holds (history view). */
	let foreignTurns = $state<TurnChanges[]>([]);
	let foreignLoading = $state(false);

	const isStoreSession = $derived(!!sessionId && sessionId === aiChangesState.sessionId);
	const turns = $derived(isStoreSession ? aiChangesState.turns : foreignTurns);
	const loading = $derived(isStoreSession ? aiChangesState.loading : foreignLoading);

	// A session the store is not tracking has to be read directly. This is the
	// history page opening a past conversation, where nothing is live.
	$effect(() => {
		if (!sessionId || isStoreSession) return;
		const target = sessionId;
		foreignLoading = true;
		ws.http('snapshot:list-turn-changes', { sessionId: target })
			.then((response) => {
				if (sessionId !== target) return;
				foreignTurns = response.turns as TurnChanges[];
			})
			.catch((error) => {
				debug.error('snapshot', 'Failed to load turn changes:', error);
				foreignTurns = [];
			})
			.finally(() => {
				foreignLoading = false;
			});
	});

	const projectRoot = $derived(projectState.currentProject?.path ?? '');

	function absolutePathOf(relativePath: string): string {
		return projectRoot ? toAbsolutePath(projectRoot, relativePath) : relativePath;
	}

	/**
	 * Still sitting in the working tree, i.e. neither staged nor committed.
	 *
	 * Only meaningful for the session being worked in: the history page can open
	 * a chat from another project, where the git status on screen describes a
	 * different tree entirely.
	 */
	const canReadWorkingTree = $derived(isStoreSession && !!projectRoot);

	function isUncommitted(relativePath: string): boolean {
		if (!gitStatusState.isRepo) return true;
		return gitStatusState.unstagedSet.has(absolutePathOf(relativePath));
	}

	const query = $derived(search.trim().toLowerCase());

	/**
	 * Does this row survive the filters?
	 *
	 * The query matches a path OR the instruction that produced it, because the
	 * thing a user remembers about a change is usually what they asked for, not
	 * which file it landed in. A prompt match keeps the whole turn: the question
	 * was "what did that instruction do", and answering with part of it is worse
	 * than not answering.
	 */
	function matchesFilters(turn: TurnChanges, file: TurnFileChange): boolean {
		if (uncommittedOnly && canReadWorkingTree && !isUncommitted(file.path)) return false;
		if (!query) return true;
		return (
			file.path.toLowerCase().includes(query) ||
			turn.promptText.toLowerCase().includes(query)
		);
	}

	const visibleTurns = $derived(
		turns
			.map((turn) => ({ turn, files: turn.files.filter((file) => matchesFilters(turn, file)) }))
			.filter((entry) => entry.files.length > 0)
	);

	/** The same data read the other way: one row per file, its turns beneath. */
	const visibleFiles = $derived.by(() => {
		const byPath = new Map<string, { path: string; entries: Array<{ turn: TurnChanges; file: TurnFileChange }> }>();
		for (const turn of turns) {
			for (const file of turn.files) {
				if (!matchesFilters(turn, file)) continue;
				const existing = byPath.get(file.path);
				if (existing) existing.entries.push({ turn, file });
				else byPath.set(file.path, { path: file.path, entries: [{ turn, file }] });
			}
		}
		return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
	});

	const totals = $derived.by(() => {
		const paths = new Set<string>();
		let insertions = 0;
		let deletions = 0;
		for (const { files } of visibleTurns) {
			for (const file of files) {
				paths.add(file.path);
				insertions += file.insertions;
				deletions += file.deletions;
			}
		}
		return { files: paths.size, insertions, deletions, turns: visibleTurns.length };
	});

	// Hold a file watch while this tab is open. The running turn's changes are
	// read from the watcher's dirty set, and this view can be opened with the
	// Files and Git panels both closed — where nothing else would be holding one.
	$effect(() => {
		if (!canReadWorkingTree) return;
		const release = acquireFileWatch(projectRoot);
		return release;
	});

	// Open the newest turn by default: it is the one being reviewed almost every
	// time, and a list of collapsed rows answers nothing on its own.
	let autoExpanded = false;
	$effect(() => {
		if (autoExpanded || visibleTurns.length === 0) return;
		autoExpanded = true;
		expandedTurns = new Set([...expandedTurns, turnId(visibleTurns[0].turn)]);
	});

	// Open on the file the caller pointed at, once its turn is known.
	let focusApplied = false;
	$effect(() => {
		if (focusApplied || !focusPath || turns.length === 0) return;
		for (const turn of turns) {
			const file = turn.files.find((candidate) => absolutePathOf(candidate.path) === focusPath);
			if (file) {
				focusApplied = true;
				expandedTurns = new Set([...expandedTurns, turnId(turn)]);
				expandedFiles = new Set([...expandedFiles, file.path]);
				select(turn, file);
				return;
			}
		}
		// The turns are loaded and none of them mentions it — stop looking rather
		// than re-scanning on every store update.
		focusApplied = true;
	});

	// Keep the open diff pointing at real content: a restore can drop the turn it
	// belongs to, and leaving a stale diff on screen reads as current. When the
	// running turn settles into a checkpoint it is not gone, only renamed — follow
	// the file into the turn that replaced it rather than dropping the selection.
	$effect(() => {
		const all = turns;
		const current = untrack(() => selected);
		if (!current) return;

		const stillThere = all.some(
			(turn) =>
				turnId(turn) === turnId(current.turn) &&
				turn.files.some((file) => file.path === current.file.path)
		);
		if (stillThere) return;

		if (current.turn.checkpointMessageId === null) {
			for (const turn of all) {
				const file = turn.files.find((candidate) => candidate.path === current.file.path);
				if (file) {
					select(turn, file);
					return;
				}
			}
		}

		selected = null;
		diff = null;
	});

	// The running turn's content moves while it runs, and its timestamp moves with
	// it — so re-read whenever that stamp advances and the open diff is its own.
	$effect(() => {
		const running = turns.find((turn) => turn.checkpointMessageId === null);
		void running?.timestamp;
		const current = untrack(() => selected);
		if (!running || !current || current.turn.checkpointMessageId !== null) return;

		const file = running.files.find((candidate) => candidate.path === current.file.path);
		if (file) untrack(() => loadDiff(running, file));
	});

	function toggleTurn(id: string) {
		const next = new Set(expandedTurns);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expandedTurns = next;
	}

	function toggleFile(path: string) {
		const next = new Set(expandedFiles);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		expandedFiles = next;
	}

	function select(turn: TurnChanges, file: TurnFileChange) {
		selected = { turn, file };
		loadDiff(turn, file);
	}

	/** Read both sides of one file's change. Split out so the running turn, whose
	 *  content is still moving, can be re-read without re-selecting anything. */
	function loadDiff(turn: TurnChanges, file: TurnFileChange) {
		diff = null;
		diffError = null;

		if (file.isBinary || !file.contentAvailable) return;

		diffLoading = true;
		ws.http('snapshot:read-turn-file', {
			filePath: file.path,
			...(turn.checkpointMessageId
				? { messageId: turn.checkpointMessageId }
				: { sessionId: sessionId ?? '' })
		})
			.then((response) => {
				// A late reply for a file or turn the user has moved off must not
				// land on the diff they are looking at now.
				if (selected?.file.path !== file.path) return;
				if (!selected || turnId(selected.turn) !== turnId(turn)) return;
				if (response.before === null && response.after === null) {
					diffError = 'This version is no longer stored.';
					return;
				}
				diff = {
					before: response.before ?? '',
					after: response.after ?? '',
					isBinary: response.isBinary
				};
			})
			.catch((error) => {
				debug.error('snapshot', 'Failed to read turn file:', error);
				diffError = 'Could not read this version.';
			})
			.finally(() => {
				diffLoading = false;
			});
	}

	function openInEditor() {
		if (!selected) return;
		const absolute = absolutePathOf(selected.file.path);
		revealFile(absolute);
		requestAiReveal(absolute, turnId(selected.turn));
		onNavigateAway?.();
	}

	function fileNameOf(path: string): string {
		return path.split('/').pop() || path;
	}

	function dirOf(path: string): string {
		const parts = path.split('/');
		parts.pop();
		return parts.join('/');
	}

	function statusLabel(status: TurnFileChange['status']): string {
		return status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M';
	}

	function statusColor(status: TurnFileChange['status']): string {
		return status === 'added'
			? 'text-emerald-500'
			: status === 'deleted'
				? 'text-red-500'
				: 'text-amber-500';
	}

	function turnLabel(turn: TurnChanges): string {
		return turn.turnIndex === null ? 'Running now' : `Turn ${turn.turnIndex}`;
	}

	const selectedLanguage = $derived(
		selected ? detectLanguageFromFilename(fileNameOf(selected.file.path)) : 'plaintext'
	);
</script>

<svelte:window onresize={() => (windowWidth = window.innerWidth)} />

<!-- Two columns, like Notes: the title, the controls and the totals all live in
     the sidebar so the diff keeps the dialog's whole height. The sidebar's
     spacing and type scale are lifted from NotesSidebar on purpose — two review
     dialogs that look like two different applications is its own kind of bug. -->
<div class="flex flex-1 min-h-0">
	<aside
		class="flex flex-col min-h-0 bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800
			{isNarrow ? 'w-full border-r-0' : 'w-72 shrink-0 border-r'}
			{isNarrow && selected ? 'hidden' : ''}"
	>
		<header class="flex items-center justify-between gap-2 py-1.5 pl-4 pr-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
			<div class="flex items-center gap-2 min-w-0">
				<Icon name="lucide:sparkles" class="w-4 h-4 shrink-0 text-violet-500 dark:text-violet-400" />
				<span id="ai-changes-title" class="text-base font-bold text-slate-900 dark:text-slate-100 truncate">
					Changes in this chat
				</span>
			</div>
			{#if onClose}
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 shrink-0 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
					onclick={onClose}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			{/if}
		</header>

		<!-- Two readings of the same list: what one instruction did, or everything
		     that happened to one file. -->
		<div class="flex items-center gap-1 p-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
			<div class="flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800/60 w-full" role="group" aria-label="Grouping">
				<button
					type="button"
					onclick={() => (grouping = 'turn')}
					aria-pressed={grouping === 'turn'}
					class="flex-1 flex items-center justify-center gap-1.5 h-7 px-2 text-xs font-medium rounded-md transition-colors {grouping === 'turn'
						? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
						: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				>
					<Icon name="lucide:message-square" class="w-3.5 h-3.5" />
					By turn
				</button>
				<button
					type="button"
					onclick={() => (grouping = 'file')}
					aria-pressed={grouping === 'file'}
					class="flex-1 flex items-center justify-center gap-1.5 h-7 px-2 text-xs font-medium rounded-md transition-colors {grouping === 'file'
						? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
						: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				>
					<Icon name="lucide:file" class="w-3.5 h-3.5" />
					By file
				</button>
			</div>
		</div>

		<!-- Search, with the uncommitted filter beside it rather than alone on a
		     row of its own. -->
		<div class="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-slate-200 dark:border-slate-800">
			<div class="flex-1 flex items-center gap-2 px-2.5 py-1 bg-slate-100/80 dark:bg-slate-800/60 rounded-md min-w-0">
				<Icon name="lucide:search" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
				<input
					type="text"
					bind:value={search}
					placeholder="Filter files or prompts…"
					class="py-1 flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
				/>
			</div>
			{#if canReadWorkingTree}
				<button
					type="button"
					onclick={() => (uncommittedOnly = !uncommittedOnly)}
					aria-pressed={uncommittedOnly}
					aria-label="Show only uncommitted changes"
					title="Show only uncommitted changes"
					class="{ROW_ACTION} {uncommittedOnly
						? 'text-violet-600 dark:text-violet-400 bg-violet-500/10'
						: 'hover:text-violet-600 hover:bg-violet-500/10'}"
				>
					<Icon name="lucide:circle-dot" class={ROW_ICON} />
				</button>
			{/if}
		</div>

		<!-- List -->
		<div class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5">
			{#if loading && turns.length === 0}
				<div class="flex items-center justify-center py-10">
					<Icon name="lucide:loader-circle" class="w-5 h-5 animate-spin text-slate-400" />
				</div>
			{:else if visibleTurns.length === 0}
				<div class="flex flex-col items-center gap-2 py-8 px-3 text-center text-slate-500 dark:text-slate-400">
					<Icon name="lucide:file-diff" class="w-8 h-8 opacity-40" />
					<span class="text-xs">
						{turns.length === 0 ? 'This chat has not changed any files yet' : 'No file matches these filters'}
					</span>
				</div>
			{:else if grouping === 'turn'}
				{#each visibleTurns as entry (turnId(entry.turn))}
					{@const id = turnId(entry.turn)}
					<div class="flex flex-col">
						<button
							type="button"
							onclick={() => toggleTurn(id)}
							title={entry.turn.promptText}
							class="flex items-start gap-1.5 px-1.5 py-1.5 rounded-md text-left hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
						>
							<Icon
								name={expandedTurns.has(id) ? 'lucide:chevron-down' : 'lucide:chevron-right'}
								class="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400"
							/>
							<span class="min-w-0 flex-1">
								<span class="flex items-baseline gap-1.5">
									<span class="text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
										{turnLabel(entry.turn)}
									</span>
									<span class="text-[11px] text-slate-400 dark:text-slate-500">
										{entry.files.length}
										{entry.files.length === 1 ? 'file' : 'files'}
									</span>
								</span>
								<!-- One line, always. The row is a label for the turn, not the
								     place to read the instruction back; the tooltip carries the
								     rest without costing the list its rhythm. -->
								<span class="block text-xs text-slate-600 dark:text-slate-300 truncate">
									{entry.turn.promptText || 'No prompt text'}
								</span>
							</span>
						</button>
						{#if expandedTurns.has(id)}
							{#each entry.files as file (file.path)}
								<button
									type="button"
									onclick={() => select(entry.turn, file)}
									class="flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-lg text-left transition-colors {selected?.file.path === file.path && turnId(selected.turn) === id
										? 'bg-violet-500/10'
										: 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
								>
									<Icon name={getFileIcon(fileNameOf(file.path)) as IconName} class="w-3.5 h-3.5 shrink-0" />
									<span
										class="min-w-0 flex-1 text-sm font-medium truncate {selected?.file.path === file.path && turnId(selected.turn) === id
											? 'text-violet-700 dark:text-violet-300'
											: 'text-slate-800 dark:text-slate-100'}"
										title={file.path}
									>
										{fileNameOf(file.path)}
									</span>
									<span class="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">+{file.insertions}</span>
									<span class="shrink-0 text-[11px] text-red-500">-{file.deletions}</span>
									<span class="shrink-0 w-3 text-center text-[11px] font-bold {statusColor(file.status)}">
										{statusLabel(file.status)}
									</span>
								</button>
							{/each}
						{/if}
					</div>
				{/each}
			{:else}
				{#each visibleFiles as group (group.path)}
					<div class="flex flex-col">
						<button
							type="button"
							onclick={() => toggleFile(group.path)}
							class="flex items-center gap-1.5 px-1.5 py-1.5 rounded-md text-left hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
						>
							<Icon
								name={expandedFiles.has(group.path) ? 'lucide:chevron-down' : 'lucide:chevron-right'}
								class="w-3.5 h-3.5 shrink-0 text-slate-400"
							/>
							<Icon name={getFileIcon(fileNameOf(group.path)) as IconName} class="w-3.5 h-3.5 shrink-0" />
							<span class="min-w-0 flex-1">
								<span class="block text-sm font-medium text-slate-800 dark:text-slate-100 truncate">
									{fileNameOf(group.path)}
								</span>
								<span class="block text-[11px] text-slate-400 dark:text-slate-500 truncate" dir="rtl">
									{dirOf(group.path)}
								</span>
							</span>
							<span class="shrink-0 text-[11px] text-slate-400 dark:text-slate-500">{group.entries.length}×</span>
						</button>
						{#if expandedFiles.has(group.path)}
							{#each group.entries as entry (turnId(entry.turn))}
								<button
									type="button"
									onclick={() => select(entry.turn, entry.file)}
									title={entry.turn.promptText}
									class="flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-lg text-left transition-colors {selected?.file.path === group.path && turnId(selected.turn) === turnId(entry.turn)
										? 'bg-violet-500/10'
										: 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
								>
									<span class="shrink-0 text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
										{turnLabel(entry.turn)}
									</span>
									<span class="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400 truncate">
										{entry.turn.promptText}
									</span>
									<span class="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">+{entry.file.insertions}</span>
									<span class="shrink-0 text-[11px] text-red-500">-{entry.file.deletions}</span>
								</button>
							{/each}
						{/if}
					</div>
				{/each}
			{/if}
		</div>

		<!-- Totals. The sentence behind them is the honest reading of this list, and
		     it is repeated in full on the empty diff pane where there is room. -->
		<div
			class="flex items-center gap-2.5 px-3 py-2 shrink-0 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400"
			title="Everything that changed on disk while a turn ran."
		>
			<span>{totals.turns} {totals.turns === 1 ? 'turn' : 'turns'}</span>
			<span>{totals.files} {totals.files === 1 ? 'file' : 'files'}</span>
			<span class="text-emerald-600 dark:text-emerald-400">+{totals.insertions}</span>
			<span class="text-red-500">-{totals.deletions}</span>
		</div>
	</aside>

	<!-- Diff -->
	<main
		class="flex-1 min-w-0 flex flex-col bg-slate-50 dark:bg-slate-950 {isNarrow && !selected ? 'hidden' : ''}"
	>
		{#if !selected}
			<div class="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-slate-500 dark:text-slate-400">
				<Icon name="lucide:file-diff" class="w-8 h-8 opacity-40" />
				<span class="text-xs">Pick a file to see what changed</span>
				<span class="text-xs opacity-70">Everything that changed on disk while a turn ran</span>
			</div>
		{:else}
			<!-- Same surface as the sidebar header, so the two read as one bar
			     across the top of the dialog rather than two stacked panels. -->
			<div class="flex items-center gap-2 px-3 py-2 shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
				{#if isNarrow}
					<button
						type="button"
						onclick={() => (selected = null)}
						aria-label="Back to the file list"
						title="Back to the file list"
						class="{ROW_ACTION} hover:text-violet-600 hover:bg-violet-500/10"
					>
						<Icon name="lucide:arrow-left" class={ROW_ICON} />
					</button>
				{/if}
				<Icon name={getFileIcon(fileNameOf(selected.file.path)) as IconName} class="w-4 h-4 shrink-0" />
				<span class="min-w-0 flex-1 text-sm font-medium text-slate-700 dark:text-slate-200 truncate" title={selected.file.path}>
					{selected.file.path}
				</span>
				<span
					class="shrink-0 text-xs text-slate-400 dark:text-slate-500"
					title={selected.turn.promptText}
				>{turnLabel(selected.turn)}</span>
				{#if !isNarrow}
					<button
						type="button"
						onclick={() => updateSettings({ gitDiffSideBySide: !settings.gitDiffSideBySide })}
						title={settings.gitDiffSideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
						aria-label="Toggle diff layout"
						class="{ROW_ACTION} hover:text-violet-600 hover:bg-violet-500/10"
					>
						<Icon name={settings.gitDiffSideBySide ? 'lucide:columns-2' : 'lucide:rows-2'} class={ROW_ICON} />
					</button>
				{/if}
				{#if selected.file.status !== 'deleted' && canReadWorkingTree}
					<button
						type="button"
						onclick={openInEditor}
						title="Open in the editor with this turn's gutter"
						class="shrink-0 flex items-center gap-1 px-2 h-6 rounded-md text-xs font-medium text-slate-500 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/10 transition-colors"
					>
						<Icon name="lucide:file-symlink" class={ROW_ICON} /> Open
					</button>
				{/if}
			</div>

			<div class="flex-1 min-h-0">
				{#if selected.file.isBinary}
					<div class="flex items-center justify-center h-full text-xs text-slate-500 dark:text-slate-400">
						Binary file — no text diff to show.
					</div>
				{:else if !selected.file.contentAvailable}
					<div class="flex items-center justify-center h-full text-xs text-slate-500 dark:text-slate-400">
						This version is no longer stored.
					</div>
				{:else if diffLoading}
					<div class="flex items-center justify-center h-full">
						<Icon name="lucide:loader-circle" class="w-5 h-5 animate-spin text-slate-400" />
					</div>
				{:else if diffError}
					<div class="flex items-center justify-center h-full text-xs text-slate-500 dark:text-slate-400">
						{diffError}
					</div>
				{:else if diff}
					<MonacoDiffEditor
						original={diff.before}
						modified={diff.after}
						language={selectedLanguage}
						readonly={true}
						renderSideBySide={!isNarrow && settings.gitDiffSideBySide}
						height="100%"
					/>
				{/if}
			</div>
		{/if}
	</main>
</div>

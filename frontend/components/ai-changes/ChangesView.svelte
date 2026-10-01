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
	 *
	 * The diff is editable only while it is the truth on disk: when the file
	 * still reads exactly as this turn left it (or as it was last saved from
	 * here) and the turn has settled. Anywhere else, saving would write an old
	 * version over newer work, so the view says why it is read-only and where
	 * the newer version is.
	 */
	import { untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MonacoDiffEditor from '$frontend/components/common/editor/MonacoDiffEditor.svelte';
	import EditorHeader from '$frontend/components/common/editor/EditorHeader.svelte';
	import { layoutAction, saveAction, type HeaderAction } from '$frontend/components/common/editor/header-actions';
	import { HEADER_BUTTON, HEADER_ICON } from '$frontend/components/common/editor/header-styles';
	import { NO_CHANGES, type ChangeControls, type ChangeState } from '$frontend/components/common/editor/editor-changes';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { gitStatusState } from '$frontend/stores/features/git-status.svelte';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { showError } from '$frontend/stores/ui/notification.svelte';
	import {
		aiChangesState,
		turnId,
		requestAiReveal,
		type ChangeTotals,
		type TurnChanges,
		type TurnFileChange
	} from '$frontend/stores/features/ai-changes.svelte';
	import ws from '$frontend/utils/ws';
	import { naturalCompare } from '$shared/utils/compare';
	import { debug } from '$shared/utils/logger';
	import { toAbsolutePath } from '$frontend/utils/ai-change-index';
	import { acquireFileWatch } from '$frontend/utils/file-watch';
	import { saveShortcut } from '$frontend/utils/save-shortcut';
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


	/**
	 * Why the open diff cannot be edited, when it cannot.
	 * - running: the agent is still writing this file.
	 * - changed-later: a later turn of this chat changed it again.
	 * - changed-since: it changed on disk some other way.
	 * - conflict: it changed on disk while it was being edited here.
	 */
	type ReadOnlyReason = 'running' | 'changed-later' | 'changed-since' | 'conflict';

	/** The disk version the editable diff is based on; null when read-only. */
	let live = $state<{ content: string; modified: string } | null>(null);
	let readOnlyReason = $state<ReadOnlyReason | null>(null);
	/** The newest turn that changed the open file after the selected one. */
	let laterTurn = $state<{ turn: TurnChanges; file: TurnFileChange } | null>(null);
	/** What the editor holds right now, once it has been touched. */
	let draft = $state<string | null>(null);
	let saving = $state(false);
	const dirty = $derived(!!live && draft !== null && draft !== live.content);
	/** The diff can be edited and saved right now. */
	const editable = $derived(!!live && !!diff && readOnlyReason !== 'conflict');

	let diffEditor = $state<MonacoDiffEditor | null>(null);
	let changeState = $state<ChangeState>(NO_CHANGES);
	const changeControls = $derived<ChangeControls>(
		editable
			? {
				previous: () => diffEditor?.previousChange(),
				next: () => diffEditor?.nextChange(),
				discard: () => diffEditor?.discardChange(),
				undo: () => diffEditor?.undo(),
				redo: () => diffEditor?.redo()
			}
			: {
				previous: () => diffEditor?.previousChange(),
				next: () => diffEditor?.nextChange()
			}
	);

	/**
	 * Content last saved from this view, by path. A save makes the disk differ
	 * from what the turn left, and without this the file would turn read-only
	 * the moment the user looked at another one and came back.
	 */
	const savedHere = new Map<string, string>();

	/** Guards every async read: only the newest request may land. */
	let loadToken = 0;

	/** Turns for a session other than the one the store holds (history view). */
	let foreignTurns = $state<TurnChanges[]>([]);
	let foreignNet = $state<ChangeTotals>({ filesChanged: 0, insertions: 0, deletions: 0 });
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
				foreignNet = response.net;
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
		return Array.from(byPath.values()).sort((a, b) => naturalCompare(a.path, b.path));
	});

	const isFiltered = $derived(!!query || (uncommittedOnly && canReadWorkingTree));

	const totals = $derived.by(() => {
		// Unfiltered, the footer states what the chat changed: the backend's net,
		// the same numbers the composer shows. A filtered view can only add up
		// the rows it kept.
		if (!isFiltered) {
			const net = isStoreSession ? aiChangesState.net : foreignNet;
			return {
				files: net.filesChanged,
				insertions: net.insertions,
				deletions: net.deletions,
				turns: visibleTurns.length
			};
		}

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
		resetEditing();
	});

	// A later turn landing on the file being edited makes the open version old.
	// Untouched, just re-read it so it turns read-only with the reason; with
	// edits in it, leave them be — saving will report the conflict instead.
	$effect(() => {
		void turns;
		const current = untrack(() => selected);
		if (!current || !untrack(() => live) || untrack(() => dirty)) return;
		if (untrack(() => findLaterTurn(current.turn, current.file.path))) {
			untrack(() => loadDiff(current.turn, current.file));
		}
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

	/** Leaving an edited diff drops the edits — only after asking. */
	async function confirmDiscard(): Promise<boolean> {
		if (!dirty) return true;
		// One question at a time: Escape answers the dialog AND reaches the
		// modal behind it, and a second ask would orphan the first one's answer.
		pendingDiscard ??= showConfirm({
			title: 'Discard unsaved edits?',
			message: `Your edits to ${fileNameOf(selected?.file.path ?? '')} have not been saved.`,
			type: 'warning',
			confirmText: 'Discard',
			cancelText: 'Keep editing'
		}).finally(() => {
			pendingDiscard = null;
		});
		return pendingDiscard;
	}
	let pendingDiscard: Promise<boolean> | null = null;

	/** A selection the user asked for, as opposed to one the view follows. */
	async function pick(turn: TurnChanges, file: TurnFileChange) {
		if (selected && turnId(selected.turn) === turnId(turn) && selected.file.path === file.path) return;
		if (!(await confirmDiscard())) return;
		select(turn, file);
	}

	async function backToList() {
		if (!(await confirmDiscard())) return;
		selected = null;
		resetEditing();
	}

	/** Close the dialog, asking first when there are edits to lose. */
	export async function requestClose() {
		if (!(await confirmDiscard())) return;
		onClose?.();
	}

	function resetEditing() {
		live = null;
		readOnlyReason = null;
		laterTurn = null;
		draft = null;
		changeState = NO_CHANGES;
	}

	/** The newest turn after `turn` that changed `path` — turns are newest first. */
	function findLaterTurn(turn: TurnChanges, path: string): { turn: TurnChanges; file: TurnFileChange } | null {
		const id = turnId(turn);
		for (const candidate of turns) {
			if (turnId(candidate) === id) return null;
			const file = candidate.files.find((entry) => entry.path === path);
			if (file) return { turn: candidate, file };
		}
		return null;
	}

	/**
	 * Decide whether the diff can be edited, by comparing what the turn left
	 * with what is on disk now. Returns the text the right side should show.
	 */
	async function resolveLive(
		turn: TurnChanges,
		file: TurnFileChange,
		after: string,
		token: number
	): Promise<string> {
		if (!canReadWorkingTree || file.status === 'deleted') return after;
		if (turn.checkpointMessageId === null) {
			readOnlyReason = 'running';
			return after;
		}

		const disk = await ws.http('files:read-file', { file_path: absolutePathOf(file.path) });
		if (token !== loadToken) return after;
		const content = disk.content ?? '';
		if (!disk.isBinary && (content === after || content === savedHere.get(file.path))) {
			live = { content, modified: disk.modified };
			return content;
		}

		laterTurn = findLaterTurn(turn, file.path);
		readOnlyReason = laterTurn ? 'changed-later' : 'changed-since';
		return after;
	}

	async function saveDraft() {
		if (!selected || !live || !dirty || saving || draft === null || readOnlyReason === 'conflict') return;
		const path = selected.file.path;
		const content = draft;
		saving = true;
		try {
			const response = await ws.http('files:write-file', {
				filePath: absolutePathOf(path),
				content,
				baseModified: live.modified
			});
			savedHere.set(path, content);
			if (selected?.file.path === path) live = { content, modified: response.modified };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes('FILE_CONFLICT')) {
				readOnlyReason = 'conflict';
				showError('Not saved', 'The file changed on disk while you were editing it.');
			} else {
				debug.error('snapshot', 'Failed to save from the changes view:', error);
				showError('Not saved', message);
			}
		} finally {
			saving = false;
		}
	}

	/** Read both sides of one file's change. Split out so the running turn, whose
	 *  content is still moving, can be re-read without re-selecting anything. */
	async function loadDiff(turn: TurnChanges, file: TurnFileChange) {
		// A late reply for a file or turn the user has moved off must not land on
		// the diff they are looking at now.
		const token = ++loadToken;
		diff = null;
		diffError = null;
		resetEditing();

		if (file.isBinary || !file.contentAvailable) {
			diffLoading = false;
			return;
		}

		diffLoading = true;
		try {
			const response = await ws.http('snapshot:read-turn-file', {
				filePath: file.path,
				...(turn.checkpointMessageId
					? { messageId: turn.checkpointMessageId }
					: { sessionId: sessionId ?? '' })
			});
			if (token !== loadToken) return;
			if (response.before === null && response.after === null) {
				diffError = 'This version is no longer stored.';
				return;
			}
			const before = response.before ?? '';
			const after = await resolveLive(turn, file, response.after ?? '', token).catch((error) => {
				// Not being able to read the disk costs the editing, not the diff.
				debug.warn('snapshot', 'Could not compare with the file on disk:', error);
				return response.after ?? '';
			});
			if (token !== loadToken) return;
			diff = { before, after, isBinary: response.isBinary };
		} catch (error) {
			if (token !== loadToken) return;
			debug.error('snapshot', 'Failed to read turn file:', error);
			diffError = 'Could not read this version.';
		} finally {
			if (token === loadToken) diffLoading = false;
		}
	}

	/** Throw the edits away and read the file again. */
	async function reload() {
		if (!selected) return;
		if (!(await confirmDiscard())) return;
		loadDiff(selected.turn, selected.file);
	}

	async function openInEditor() {
		if (!selected) return;
		if (!(await confirmDiscard())) return;
		const absolute = absolutePathOf(selected.file.path);
		revealFile(absolute);
		requestAiReveal(absolute, turnId(selected.turn));
		onNavigateAway?.();
	}

	const headerActions = $derived.by<HeaderAction[]>(() => {
		const list: HeaderAction[] = [];
		if (diff && selected && !selected.file.isBinary) {
			list.push({
				id: 'changes-only',
				label: settings.diffChangesOnly ? 'Show the full file' : 'Show only the changes',
				icon: settings.diffChangesOnly ? 'lucide:unfold-vertical' : 'lucide:fold-vertical',
				active: settings.diffChangesOnly,
				onclick: () => updateSettings({ diffChangesOnly: !settings.diffChangesOnly }),
				priority: 5
			});
			if (!isNarrow) {
				list.push(
					layoutAction({
						sideBySide: settings.gitDiffSideBySide,
						onToggle: () => updateSettings({ gitDiffSideBySide: !settings.gitDiffSideBySide })
					})
				);
			}
		}
		if (editable) list.push(saveAction({ dirty, saving, onSave: saveDraft }));
		if (selected && selected.file.status !== 'deleted' && canReadWorkingTree) {
			list.push({ id: 'open-in-files', label: 'Open in Files', icon: 'lucide:file-symlink', onclick: openInEditor, priority: 4 });
		}
		return list;
	});

	let listElement = $state<HTMLDivElement | null>(null);

	/**
	 * Up and down move between rows, the way a file tree does. Landing on a file
	 * opens it, so a list can be read top to bottom without the mouse; landing on
	 * a turn or a file group only focuses it (Enter or Space toggles it).
	 */
	function handleListKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		if (!listElement) return;
		const rows = Array.from(listElement.querySelectorAll<HTMLButtonElement>('[data-row]'));
		if (rows.length === 0) return;
		event.preventDefault();

		const current = rows.indexOf(document.activeElement as HTMLButtonElement);
		const next = current === -1
			? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
			: Math.min(rows.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)));
		if (next === current) return;

		const row = rows[next];
		row.focus();
		row.scrollIntoView({ block: 'nearest' });
		if (row.dataset.row === 'file') row.click();
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
					onclick={requestClose}
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

		<!-- List. Arrow keys walk the rows; landing on a file opens it. -->
		<div
			class="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5"
			bind:this={listElement}
			onkeydown={handleListKeydown}
			role="presentation"
		>
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
							data-row="group"
							aria-expanded={expandedTurns.has(id)}
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
									onclick={() => pick(entry.turn, file)}
									data-row="file"
									class="flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-lg text-left transition-colors {selected?.file.path === file.path && turnId(selected.turn) === id
										? 'bg-violet-500/10'
										: 'hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
								>
									<Icon name={getFileIcon(fileNameOf(file.path)) as IconName} class="w-3.5 h-3.5 shrink-0" />
									<!-- The folder, faintly, after the name: two index.ts in one turn
									     are otherwise the same row twice. -->
									<span class="min-w-0 flex-1 flex items-baseline gap-1.5 overflow-hidden" title={file.path}>
										<span
											class="min-w-0 shrink-0 max-w-full text-sm font-medium truncate {selected?.file.path === file.path && turnId(selected.turn) === id
												? 'text-violet-700 dark:text-violet-300'
												: 'text-slate-800 dark:text-slate-100'}"
										>
											{fileNameOf(file.path)}
										</span>
										{#if dirOf(file.path)}
											<span class="min-w-0 truncate text-[11px] text-slate-400 dark:text-slate-500" dir="rtl">
												{dirOf(file.path)}
											</span>
										{/if}
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
							data-row="group"
							aria-expanded={expandedFiles.has(group.path)}
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
									onclick={() => pick(entry.turn, entry.file)}
									data-row="file"
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
		use:saveShortcut={saveDraft}
	>
		{#if !selected}
			<div class="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-slate-500 dark:text-slate-400">
				<Icon name="lucide:file-diff" class="w-8 h-8 opacity-40" />
				<span class="text-xs">Pick a file to see what changed</span>
				<span class="text-xs opacity-70">Everything that changed on disk while a turn ran</span>
			</div>
		{:else}
			{@const isTextDiff = !!diff && !selected.file.isBinary}
			{@const fileDir = dirOf(selected.file.path)}
			<EditorHeader
				icon={getFileIcon(fileNameOf(selected.file.path)) as IconName}
				title={`${fileNameOf(selected.file.path)}${dirty ? ' •' : ''}`}
				subtitle={fileDir || undefined}
				changes={isTextDiff ? { state: changeState, controls: changeControls } : undefined}
				actions={headerActions}
			>
				{#snippet leading()}
					{#if isNarrow}
						<button
							type="button"
							onclick={backToList}
							aria-label="Back to the file list"
							title="Back to the file list"
							class={HEADER_BUTTON}
						>
							<Icon name="lucide:arrow-left" class={HEADER_ICON} />
						</button>
					{/if}
				{/snippet}
				{#snippet meta()}
					<span
						class="shrink-0 px-1 text-xs text-slate-500 dark:text-slate-400"
						title={selected?.turn.promptText}
					>{selected ? turnLabel(selected.turn) : ''}</span>
				{/snippet}
			</EditorHeader>

			<!-- Why this diff cannot be edited, and where the newer version is. -->
			{#if readOnlyReason && diff}
				<div class="flex items-center gap-2 px-3 py-1.5 shrink-0 text-xs border-b border-slate-200 dark:border-slate-800 {readOnlyReason === 'conflict'
					? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
					: 'bg-slate-100 dark:bg-slate-900/60 text-slate-500 dark:text-slate-400'}"
				>
					<Icon
						name={readOnlyReason === 'running' ? 'lucide:lock' : readOnlyReason === 'conflict' ? 'lucide:triangle-alert' : 'lucide:history'}
						class="w-3.5 h-3.5 shrink-0"
					/>
					<span class="min-w-0 flex-1 truncate">
						{#if readOnlyReason === 'running'}
							Read-only while this turn is still running.
						{:else if readOnlyReason === 'changed-later' && laterTurn}
							{laterTurn.turn.turnIndex === null ? 'The running turn' : turnLabel(laterTurn.turn)} changed this file again — read-only, as {turnLabel(selected.turn)} left it.
						{:else if readOnlyReason === 'changed-since'}
							The file has changed on disk since this turn — read-only, as {turnLabel(selected.turn)} left it.
						{:else}
							The file changed on disk while you were editing — your edits were not saved.
						{/if}
					</span>
					{#if readOnlyReason === 'changed-later' && laterTurn}
						{@const later = laterTurn}
						<button
							type="button"
							onclick={() => pick(later.turn, later.file)}
							class="shrink-0 px-2 h-6 rounded-md font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 transition-colors"
						>
							View {later.turn.turnIndex === null ? 'running turn' : turnLabel(later.turn)}
						</button>
					{:else if readOnlyReason === 'changed-since' && selected.file.status !== 'deleted' && canReadWorkingTree}
						<button
							type="button"
							onclick={openInEditor}
							class="shrink-0 px-2 h-6 rounded-md font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 transition-colors"
						>
							Open current
						</button>
					{:else if readOnlyReason === 'conflict'}
						<button
							type="button"
							onclick={reload}
							class="shrink-0 px-2 h-6 rounded-md font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-500/10 transition-colors"
						>
							Reload
						</button>
					{/if}
				</div>
			{/if}

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
						bind:this={diffEditor}
						original={diff.before}
						modified={diff.after}
						language={selectedLanguage}
						modifiedPath={selected.file.path}
						readonly={!editable}
						renderSideBySide={!isNarrow && settings.gitDiffSideBySide}
						hideUnchangedRegions={settings.diffChangesOnly}
						revealFirstChange
						onChangesUpdate={(state) => (changeState = state)}
						onModifiedChange={(value) => (draft = value)}
						height="100%"
					/>
				{/if}
			</div>
		{/if}
	</main>
</div>

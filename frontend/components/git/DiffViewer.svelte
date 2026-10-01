<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MediaPreview from '$frontend/components/common/media/MediaPreview.svelte';
	import type { editor } from 'monaco-editor';
	import MonacoDiffEditor from '$frontend/components/common/editor/MonacoDiffEditor.svelte';
	import EditorHeader from '$frontend/components/common/editor/EditorHeader.svelte';
	import { layoutAction, type HeaderAction } from '$frontend/components/common/editor/header-actions';
	import { NO_CHANGES, type ChangeControls, type ChangeState } from '$frontend/components/common/editor/editor-changes';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { isPreviewableFile } from '$frontend/utils/file-type';
	import { getGitStatusBadgeLabel, getGitStatusBadgeColor } from '$frontend/utils/git-status';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import type { GitFileDiff } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
	import { showError } from '$frontend/stores/ui/notification.svelte';
	import { applyLineEdit, invertLineEdit, LineEditConflictError, type LineEdit } from '$frontend/utils/line-edit';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	interface Props {
		diff: GitFileDiff | null;
		diffs?: GitFileDiff[];
		isLoading: boolean;
		onSelectFile?: (index: number) => void;
		selectedFileIndex?: number;
		// When true (e.g. for unmerged conflict files), render the file content in
		// a single-pane code editor instead of the side-by-side diff — there is no
		// "original" to compare against, so the left pane would just be empty.
		inlinePreview?: boolean;
		/** Initial vertical scroll to restore once the diff has rendered. */
		scrollTop?: number;
		/** Fired when the user scrolls the diff. */
		onScroll?: (top: number) => void;
		/**
		 * Which list the diff came from. Only a working-tree ("unstaged") diff can
		 * have a change discarded: anything else is already in the index or in
		 * history, where putting lines back on disk would not undo it.
		 */
		section?: string;
	}

	const { diff, diffs = [], isLoading, onSelectFile, selectedFileIndex = 0, inlinePreview = false, scrollTop = 0, onScroll, section }: Props = $props();

	const renderSideBySide = $derived(settings.gitDiffSideBySide);

	let diffEditorRef = $state<MonacoDiffEditor | null>(null);
	let changeState = $state<ChangeState>(NO_CHANGES);

	function toggleRenderSideBySide() {
		updateSettings({ gitDiffSideBySide: !settings.gitDiffSideBySide });
	}

	const allDiffs = $derived(diffs.length > 0 ? diffs : diff ? [diff] : []);
	const activeDiff = $derived(allDiffs.length > 0 ? allDiffs[selectedFileIndex] ?? allDiffs[0] : null);

	const activePath = $derived(activeDiff?.newPath || activeDiff?.oldPath || '');
	const activeLanguage = $derived(detectLanguageFromFilename(getFileName(activePath)));
	const originalSide = $derived(activeDiff ? buildContent(activeDiff, 'old') : { text: '', lineNumbers: [] });
	const modifiedSide = $derived(activeDiff ? buildContent(activeDiff, 'new') : { text: '', lineNumbers: [] });
	const originalContent = $derived(originalSide.text);
	const modifiedContent = $derived(modifiedSide.text);
	const originalLineNumbers = $derived(originalSide.lineNumbers);
	const modifiedLineNumbers = $derived(modifiedSide.lineNumbers);

	const binaryPreviewPath = $derived.by(() => {
		if (!activeDiff?.isBinary || activeDiff.status === 'D') return null;
		const filePath = activeDiff.newPath || activeDiff.oldPath;
		if (!filePath) return null;
		const fileName = getFileName(filePath);
		if (!isPreviewableFile(fileName)) return null;
		const projectPath = projectState.currentProject?.path;
		if (!projectPath) return null;
		return `${projectPath}/${filePath}`;
	});

	const binaryFileName = $derived.by(() => {
		if (!activeDiff) return '';
		return getFileName(activeDiff.newPath || activeDiff.oldPath);
	});

	function buildContent(diff: GitFileDiff, side: 'old' | 'new'): { text: string; lineNumbers: number[] } {
		if (!diff || diff.isBinary || diff.hunks.length === 0) return { text: '', lineNumbers: [] };
		const lines: string[] = [];
		const lineNumbers: number[] = [];
		for (const hunk of diff.hunks) {
			for (const line of hunk.lines) {
				if (side === 'old') {
					if (line.type === 'context' || line.type === 'delete') {
						lines.push(line.content);
						lineNumbers.push(line.oldLineNumber ?? 0);
					}
				} else {
					if (line.type === 'context' || line.type === 'add') {
						lines.push(line.content);
						lineNumbers.push(line.newLineNumber ?? 0);
					}
				}
			}
		}
		return { text: lines.join('\n'), lineNumbers };
	}

	function getFileName(path: string): string {
		return path.split(/[\\/]/).pop() || path;
	}

	function absolutePathOf(relativePath: string): string | null {
		const basePath = projectState.currentProject?.path;
		if (!basePath) return null;
		const separator = basePath.includes('\\') ? '\\' : '/';
		return `${basePath}${separator}${relativePath}`;
	}

	function openInFilesPanel() {
		if (!activeDiff) return;
		const absolute = absolutePathOf(activeDiff.newPath || activeDiff.oldPath);
		if (absolute) revealFile(absolute);
	}

	const headerActions = $derived.by<HeaderAction[]>(() => {
		const list: HeaderAction[] = [];
		if (activeDiff && !activeDiff.isBinary && !inlinePreview) {
			list.push(layoutAction({ sideBySide: renderSideBySide, onToggle: toggleRenderSideBySide }));
		}
		if (activeDiff && activeDiff.status !== 'D') {
			list.push({ id: 'open-in-files', label: 'Open in Files', icon: 'lucide:file-symlink', onclick: openInFilesPanel, priority: 4 });
		}
		return list;
	});

	// ── Discarding a change on disk ──────────────────────────────────────────
	//
	// The diff is built from git's hunks, so its lines carry the file's real
	// line numbers. A change is put back by swapping those exact lines on disk,
	// and remembered so Undo can swap them again — one history per file, kept
	// while it stays open. Each step is checked against the file first, so one
	// that no longer fits is refused rather than written in the wrong place.

	const discardable = $derived(section === 'unstaged' && !inlinePreview && !activeDiff?.isBinary);

	let undoStack = $state<LineEdit[]>([]);
	let redoStack = $state<LineEdit[]>([]);
	let busy = $state(false);

	// History belongs to one file; another file starts clean.
	$effect(() => {
		void activePath;
		undoStack = [];
		redoStack = [];
	});

	/** Real line numbers for built lines `from..to`, if they run without a gap. */
	function realLines(numbers: number[], from: number, to: number): number[] | null {
		const real = numbers.slice(from - 1, to);
		if (real.length !== to - from + 1 || real.some((n) => !n)) return null;
		for (let i = 1; i < real.length; i++) if (real[i] !== real[i - 1] + 1) return null;
		return real;
	}

	/**
	 * The disk edit that undoes one change of the diff, or null when the change
	 * straddles two hunks (where the built text has a gap the file does not).
	 */
	function editForChange(change: editor.ILineChange): LineEdit | null {
		const { originalStartLineNumber: oStart, originalEndLineNumber: oEnd } = change;
		const { modifiedStartLineNumber: mStart, modifiedEndLineNumber: mEnd } = change;
		const originalLines = originalContent.split('\n');
		const modifiedLines = modifiedContent.split('\n');

		if (oEnd !== 0 && !realLines(originalLineNumbers, oStart, oEnd)) return null;

		let start: number;
		if (mEnd !== 0) {
			const real = realLines(modifiedLineNumbers, mStart, mEnd);
			if (!real) return null;
			start = real[0];
		} else {
			// Removed lines go back after the line they followed.
			const after = mStart > 0 ? modifiedLineNumbers[mStart - 1] : (modifiedLineNumbers[0] ?? 1) - 1;
			if (after === undefined || after < 0) return null;
			start = after + 1;
		}

		return {
			start,
			remove: mEnd === 0 ? [] : modifiedLines.slice(mStart - 1, mEnd),
			insert: oEnd === 0 ? [] : originalLines.slice(oStart - 1, oEnd)
		};
	}

	/** Apply one edit to the working-tree file. The Git panel re-reads the diff on its own. */
	async function writeEdit(edit: LineEdit): Promise<boolean> {
		const absolute = activeDiff ? absolutePathOf(activeDiff.newPath || activeDiff.oldPath) : null;
		if (!absolute) return false;
		busy = true;
		try {
			const file = await ws.http('files:read-file', { file_path: absolute });
			const next = applyLineEdit(file.content ?? '', edit);
			await ws.http('files:write-file', { filePath: absolute, content: next, baseModified: file.modified });
			return true;
		} catch (error) {
			const conflict = error instanceof LineEditConflictError || String(error).includes('FILE_CONFLICT');
			if (!conflict) debug.error('git', 'Failed to change the working tree:', error);
			showError(
				'Nothing changed',
				conflict ? 'The file changed since this diff was loaded.' : error instanceof Error ? error.message : String(error)
			);
			if (conflict) {
				undoStack = [];
				redoStack = [];
			}
			return false;
		} finally {
			busy = false;
		}
	}

	async function discardChange(change: editor.ILineChange) {
		const edit = editForChange(change);
		if (!edit || busy) return;
		if (await writeEdit(edit)) {
			undoStack = [...undoStack, edit];
			redoStack = [];
		}
	}

	async function undo() {
		const edit = undoStack.at(-1);
		if (!edit || busy) return;
		if (await writeEdit(invertLineEdit(edit))) {
			undoStack = undoStack.slice(0, -1);
			redoStack = [...redoStack, edit];
		}
	}

	async function redo() {
		const edit = redoStack.at(-1);
		if (!edit || busy) return;
		if (await writeEdit(edit)) {
			redoStack = redoStack.slice(0, -1);
			undoStack = [...undoStack, edit];
		}
	}

	const headerState = $derived<ChangeState>({
		...changeState,
		canDiscard: discardable && !busy && changeState.canDiscard,
		canUndo: !busy && undoStack.length > 0,
		canRedo: !busy && redoStack.length > 0
	});

	const changeControls = $derived<ChangeControls>(
		discardable
			? {
				previous: () => diffEditorRef?.previousChange(),
				next: () => diffEditorRef?.nextChange(),
				discard: () => diffEditorRef?.discardChange(),
				undo,
				redo
			}
			: {
				previous: () => diffEditorRef?.previousChange(),
				next: () => diffEditorRef?.nextChange()
			}
	);
</script>

<div class="h-full flex flex-col">
	{#if isLoading}
		<div class="flex-1 flex items-center justify-center">
			<div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
		</div>
	{:else if !activeDiff}
		<div class="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500 text-xs">
			<Icon name="lucide:file-diff" class="w-8 h-8 opacity-30" />
			<span>Select a file to view diff</span>
		</div>
	{:else}
		<EditorHeader
			icon={getFileIcon(getFileName(activePath)) as IconName}
			title={getFileName(activePath)}
			subtitle={activePath}
			changes={!activeDiff.isBinary && !inlinePreview ? { state: headerState, controls: changeControls } : undefined}
			actions={headerActions}
		>
			{#snippet meta()}
				{#if activeDiff}
					<span class="text-3xs font-bold px-1.5 py-0.5 rounded {getGitStatusBadgeColor(activeDiff.status)}">
						{getGitStatusBadgeLabel(activeDiff.status)}
					</span>
				{/if}
			{/snippet}
		</EditorHeader>

		{#if activeDiff.isBinary}
			{@const isDeleted = activeDiff.status === 'D'}
			{#if isDeleted}
				<!-- Deleted binary file -->
				<div class="flex-1 flex flex-col items-center justify-center gap-3 p-8">
					<Icon name="lucide:file-x" class="w-12 h-12 text-red-400 opacity-60" />
					<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Binary File Deleted</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400 text-center">
						This binary file has been deleted and cannot be previewed.
					</p>
				</div>
			{:else if binaryPreviewPath}
				<div class="flex-1 overflow-hidden">
					<MediaPreview fileName={binaryFileName} filePath={binaryPreviewPath} />
				</div>
			{:else}
				<!-- Generic binary file -->
				<div class="flex-1 flex flex-col items-center justify-center gap-3 p-8">
					<Icon name="lucide:file-archive" class="w-12 h-12 text-slate-400 opacity-60" />
					<h3 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Binary File</h3>
					<p class="text-xs text-slate-500 dark:text-slate-400 text-center">
						This file cannot be previewed in the diff viewer.
					</p>
				</div>
			{/if}
		{:else if inlinePreview}
			<!-- Single-pane preview: shows the working-tree file (with conflict
				markers, for unmerged files) without a useless empty "original" pane. -->
			<div class="flex-1 overflow-hidden">
				{#key activePath}
					<MonacoCodeEditor
						value={modifiedContent}
						language={activeLanguage}
						path={activeDiff.newPath || activeDiff.oldPath}
						readonly
					/>
				{/key}
			</div>
		{:else}
			<!-- Monaco Diff Editor -->
			<div class="flex-1 overflow-hidden">
				{#key activePath}
					<MonacoDiffEditor
						bind:this={diffEditorRef}
						original={originalContent}
						modified={modifiedContent}
						{originalLineNumbers}
						{modifiedLineNumbers}
						language={activeLanguage}
						originalPath={activeDiff.oldPath}
						modifiedPath={activeDiff.newPath}
						{renderSideBySide}
						{scrollTop}
						{onScroll}
						onChangesUpdate={(state) => (changeState = state)}
						onDiscardChange={discardChange}
						canDiscardChange={(change) => discardable && editForChange(change) !== null}
					/>
				{/key}
			</div>
		{/if}
	{/if}
</div>

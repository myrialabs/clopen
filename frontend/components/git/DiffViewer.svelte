<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MediaPreview from '$frontend/components/common/media/MediaPreview.svelte';
	import MonacoDiffEditor from '$frontend/components/common/editor/MonacoDiffEditor.svelte';
	import MonacoCodeEditor from '$frontend/components/common/editor/MonacoCodeEditor.svelte';
	import { detectLanguageFromFilename } from '$frontend/components/common/editor/monaco-languages';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { isPreviewableFile } from '$frontend/utils/file-type';
	import { getGitStatusBadgeLabel, getGitStatusBadgeColor } from '$frontend/utils/git-status';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import type { GitFileDiff } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';
	import { requestRevealFile } from '$frontend/stores/core/files.svelte';
	import { getVisiblePanels, workspaceState } from '$frontend/stores/ui/workspace.svelte';
	import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';

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
	}

	const { diff, diffs = [], isLoading, onSelectFile, selectedFileIndex = 0, inlinePreview = false }: Props = $props();

	const renderSideBySide = $derived(settings.gitDiffSideBySide);

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

	function openInFilesPanel() {
		if (!activeDiff) return;
		const visiblePanels = getVisiblePanels(workspaceState.layout);
		if (!visiblePanels.includes('files')) return;
		const basePath = projectState.currentProject?.path;
		if (!basePath) return;
		const relativePath = activeDiff.newPath || activeDiff.oldPath;
		const separator = basePath.includes('\\') ? '\\' : '/';
		requestRevealFile(`${basePath}${separator}${relativePath}`);
	}

	const isFilesPanelVisible = $derived(getVisiblePanels(workspaceState.layout).includes('files'));
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
		<!-- File header -->
		<div class="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700">
			<div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
				<Icon name={getFileIcon(getFileName(activeDiff.newPath || activeDiff.oldPath)) as IconName} class="w-7 h-7 shrink-0" />
				<div class="min-w-0 flex-1">
					<h3 class="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
						{getFileName(activeDiff.newPath || activeDiff.oldPath)}
					</h3>
					<p class="text-xs text-slate-600 dark:text-slate-400 truncate mt-0.5">
						{activeDiff.newPath || activeDiff.oldPath}
					</p>
				</div>
			</div>
			<div class="flex items-center gap-1.5 sm:gap-1 flex-shrink-0">
				{#if !activeDiff.isBinary && !inlinePreview}
					<button
						type="button"
						class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200 cursor-pointer"
						onclick={toggleRenderSideBySide}
						title={renderSideBySide ? 'Switch to inline (1 column)' : 'Switch to side-by-side (2 columns)'}
					>
						<Icon name={renderSideBySide ? 'lucide:columns-2' : 'lucide:rows-2'} class="w-4 h-4" />
					</button>
				{/if}
				{#if isFilesPanelVisible && activeDiff.status !== 'D'}
					<button
						type="button"
						class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200 cursor-pointer"
						onclick={openInFilesPanel}
						title="Open in Files panel"
					>
						<Icon name="lucide:file-symlink" class="w-4 h-4" />
					</button>
				{/if}
				<span class="text-3xs font-bold px-1.5 py-0.5 rounded {getGitStatusBadgeColor(activeDiff.status)}">
					{getGitStatusBadgeLabel(activeDiff.status)}
				</span>
			</div>
		</div>

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
						original={originalContent}
						modified={modifiedContent}
						{originalLineNumbers}
						{modifiedLineNumbers}
						language={activeLanguage}
						originalPath={activeDiff.oldPath}
						modifiedPath={activeDiff.newPath}
						{renderSideBySide}
					/>
				{/key}
			</div>
		{/if}
	{/if}
</div>

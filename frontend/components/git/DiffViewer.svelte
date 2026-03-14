<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import MediaPreview from '$frontend/components/common/media/MediaPreview.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { isPreviewableFile } from '$frontend/utils/file-type';
	import { getGitStatusBadgeLabel, getGitStatusBadgeColor } from '$frontend/utils/git-status';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import loader from '@monaco-editor/loader';
	import type { editor } from 'monaco-editor';
	import type { GitFileDiff } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';
	import { debug } from '$shared/utils/logger';
	import { requestRevealFile } from '$frontend/stores/core/files.svelte';
	import { getVisiblePanels, workspaceState } from '$frontend/stores/ui/workspace.svelte';

	interface Props {
		diff: GitFileDiff | null;
		diffs?: GitFileDiff[];
		isLoading: boolean;
		onSelectFile?: (index: number) => void;
		selectedFileIndex?: number;
	}

	const { diff, diffs = [], isLoading, onSelectFile, selectedFileIndex = 0 }: Props = $props();

	const allDiffs = $derived(diffs.length > 0 ? diffs : diff ? [diff] : []);
	const activeDiff = $derived(allDiffs.length > 0 ? allDiffs[selectedFileIndex] ?? allDiffs[0] : null);

	// Monaco diff editor
	let containerRef = $state<HTMLDivElement | null>(null);
	let diffEditorInstance: editor.IDiffEditor | null = null;
	let monacoInstance: typeof import('monaco-editor') | null = null;
	const isDark = $derived(themeStore.isDark);

	// Derive absolute path for binary preview
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

	// Build full content from hunks
	function buildContent(diff: GitFileDiff, side: 'old' | 'new'): string {
		if (!diff || diff.isBinary || diff.hunks.length === 0) return '';
		const lines: string[] = [];
		for (const hunk of diff.hunks) {
			for (const line of hunk.lines) {
				if (side === 'old') {
					if (line.type === 'context' || line.type === 'delete') {
						lines.push(line.content);
					}
				} else {
					if (line.type === 'context' || line.type === 'add') {
						lines.push(line.content);
					}
				}
			}
		}
		return lines.join('\n');
	}

	function getLanguageFromPath(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase();
		if (!ext) return 'plaintext';
		const map: Record<string, string> = {
			js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
			mjs: 'javascript', cjs: 'javascript',
			html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
			py: 'python', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
			cs: 'csharp', go: 'go', rs: 'rust', php: 'php', rb: 'ruby',
			swift: 'swift', kt: 'kotlin', scala: 'scala',
			sh: 'shell', bash: 'shell', zsh: 'shell',
			sql: 'sql', xml: 'xml', json: 'json', yaml: 'yaml', yml: 'yaml',
			toml: 'toml', md: 'markdown', dockerfile: 'dockerfile',
			svelte: 'html', vue: 'html', svg: 'xml',
			gitignore: 'plaintext', env: 'plaintext', txt: 'plaintext', log: 'plaintext'
		};
		return map[ext] || 'plaintext';
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

	async function initDiffEditor() {
		if (!containerRef || !activeDiff) return;

		try {
			if (!monacoInstance) {
				monacoInstance = await loader.init();

				// Define themes
				monacoInstance.editor.defineTheme('diff-dark', {
					base: 'vs-dark',
					inherit: true,
					rules: [],
					colors: {
						'editor.background': '#0d1117',
						'editor.foreground': '#e6edf3',
						'editor.lineHighlightBackground': '#161b22',
						'editorLineNumber.foreground': '#6e7681',
						'editorLineNumber.activeForeground': '#f0f6fc',
						'diffEditor.insertedTextBackground': '#23863633',
						'diffEditor.removedTextBackground': '#f8514933',
						'diffEditor.insertedLineBackground': '#23863620',
						'diffEditor.removedLineBackground': '#f8514920',
					}
				});
				monacoInstance.editor.defineTheme('diff-light', {
					base: 'vs',
					inherit: true,
					rules: [],
					colors: {
						'editor.background': '#ffffff',
						'diffEditor.insertedTextBackground': '#dafbe133',
						'diffEditor.removedTextBackground': '#ffc3c333',
						'diffEditor.insertedLineBackground': '#dafbe120',
						'diffEditor.removedLineBackground': '#ffc3c320',
					}
				});
			}

			// Dispose previous
			if (diffEditorInstance) {
				diffEditorInstance.dispose();
				diffEditorInstance = null;
			}

			const language = getLanguageFromPath(activeDiff.newPath || activeDiff.oldPath || '');
			const oldContent = buildContent(activeDiff, 'old');
			const newContent = buildContent(activeDiff, 'new');

			const originalModel = monacoInstance.editor.createModel(oldContent, language);
			const modifiedModel = monacoInstance.editor.createModel(newContent, language);

			diffEditorInstance = monacoInstance.editor.createDiffEditor(containerRef, {
				theme: isDark ? 'diff-dark' : 'diff-light',
				readOnly: true,
				renderSideBySide: true,
				renderSideBySideInlineBreakpoint: Math.round(600 * (settings.fontSize / 13)),
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				fontSize: Math.round(settings.fontSize * 0.9),
				lineHeight: Math.round(settings.fontSize * 0.9 * 1.5),
				renderOverviewRuler: false,
				enableSplitViewResizing: true,
				automaticLayout: true,
				scrollbar: {
					verticalScrollbarSize: 8,
					horizontalScrollbarSize: 8
				}
			});

			diffEditorInstance.setModel({
				original: originalModel,
				modified: modifiedModel
			});
		} catch (err) {
			debug.error('git', 'Failed to init diff editor:', err);
		}
	}

	// Update theme when it changes
	$effect(() => {
		const theme = isDark ? 'diff-dark' : 'diff-light';
		if (diffEditorInstance && monacoInstance) {
			monacoInstance.editor.setTheme(theme);
		}
	});

	// Update font size when setting changes
	$effect(() => {
		const size = settings.fontSize;
		if (diffEditorInstance) {
			diffEditorInstance.updateOptions({
				fontSize: Math.round(size * 0.9),
				lineHeight: Math.round(size * 0.9 * 1.5),
				renderSideBySideInlineBreakpoint: Math.round(600 * (size / 13))
			});
		}
	});

	// Reinitialize when diff or selected file changes
	$effect(() => {
		if (activeDiff && containerRef) {
			selectedFileIndex;
			untrack(() => initDiffEditor());
		}
	});

	onDestroy(() => {
		if (diffEditorInstance) {
			diffEditorInstance.dispose();
			diffEditorInstance = null;
		}
	});
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
		{:else}
			<!-- Monaco Diff Editor -->
			<div class="flex-1 overflow-hidden">
				<div class="h-full w-full" bind:this={containerRef}></div>
			</div>
		{/if}
	{/if}
</div>

<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import { getGitStatusBadgeLabel, getGitStatusBadgeColor } from '$frontend/lib/utils/git-status';
	import { themeStore } from '$frontend/lib/stores/ui/theme.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import loader from '@monaco-editor/loader';
	import type { editor } from 'monaco-editor';
	import type { GitFileDiff } from '$shared/types/git';
	import type { IconName } from '$shared/types/ui/icons';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/lib/utils/ws';

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

	// Binary file preview state
	let blobUrl = $state<string | null>(null);
	let pdfBlobUrl = $state<string | null>(null);
	let isBinaryLoading = $state(false);

	// File type detection helpers
	function isImageFile(fileName: string): boolean {
		const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
		return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp'].includes(ext);
	}

	function isSvgFile(fileName: string): boolean {
		return fileName.toLowerCase().endsWith('.svg');
	}

	function isPdfFile(fileName: string): boolean {
		return fileName.toLowerCase().endsWith('.pdf');
	}

	function isPreviewableBinary(fileName: string): boolean {
		return isImageFile(fileName) || isSvgFile(fileName) || isPdfFile(fileName);
	}

	// Load binary content for preview
	async function loadBinaryPreview(filePath: string) {
		const projectPath = projectState.currentProject?.path;
		if (!projectPath) return;

		const absolutePath = `${projectPath}/${filePath}`;
		isBinaryLoading = true;

		try {
			const response = await ws.http('files:read-content', { path: absolutePath });

			if (response.content) {
				const binaryString = atob(response.content);
				const bytes = new Uint8Array(binaryString.length);
				for (let i = 0; i < binaryString.length; i++) {
					bytes[i] = binaryString.charCodeAt(i);
				}
				const blob = new Blob([bytes], { type: response.contentType || 'application/octet-stream' });

				if (isPdfFile(filePath)) {
					if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
					pdfBlobUrl = URL.createObjectURL(blob);
				} else {
					if (blobUrl) URL.revokeObjectURL(blobUrl);
					blobUrl = URL.createObjectURL(blob);
				}
			}
		} catch (err) {
			debug.error('git', 'Failed to load binary preview:', err);
		} finally {
			isBinaryLoading = false;
		}
	}

	function cleanupBlobUrls() {
		if (blobUrl) {
			URL.revokeObjectURL(blobUrl);
			blobUrl = null;
		}
		if (pdfBlobUrl) {
			URL.revokeObjectURL(pdfBlobUrl);
			pdfBlobUrl = null;
		}
	}

	// Load binary preview when activeDiff changes to a binary file
	$effect(() => {
		const currentDiff = activeDiff;
		if (currentDiff?.isBinary) {
			const filePath = currentDiff.newPath || currentDiff.oldPath;
			if (filePath && isPreviewableBinary(getFileName(filePath))) {
				// Status 'D' means file is deleted, can't preview
				if (currentDiff.status !== 'D') {
					untrack(() => {
						cleanupBlobUrls();
						loadBinaryPreview(filePath);
					});
				}
			}
		} else {
			untrack(() => cleanupBlobUrls());
		}
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
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				fontSize: 12,
				lineHeight: 20,
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
		cleanupBlobUrls();
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
		<!-- File header (like FileViewer) -->
		<div class="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700">
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<Icon name={getFileIcon(getFileName(activeDiff.newPath || activeDiff.oldPath)) as IconName} class="w-5 h-5 shrink-0" />
				<div class="min-w-0 flex-1">
					<h3 class="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
						{getFileName(activeDiff.newPath || activeDiff.oldPath)}
					</h3>
					<p class="text-3xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
						{activeDiff.newPath || activeDiff.oldPath}
					</p>
				</div>
			</div>
			<div class="flex items-center gap-2 shrink-0">
				<span class="text-3xs font-bold px-1.5 py-0.5 rounded {getGitStatusBadgeColor(activeDiff.status)}">
					{getGitStatusBadgeLabel(activeDiff.status)}
				</span>
			</div>
		</div>

		{#if activeDiff.isBinary}
			{@const fileName = getFileName(activeDiff.newPath || activeDiff.oldPath)}
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
			{:else if isImageFile(fileName) || isSvgFile(fileName)}
				<!-- Image / SVG preview -->
				<div class="flex-1 flex items-center justify-center p-4 overflow-hidden bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%3E%3Crect%20width%3D%2220%22%20height%3D%2220%22%20fill%3D%22%23f0f0f0%22%2F%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23e0e0e0%22%2F%3E%3Crect%20x%3D%2210%22%20y%3D%2210%22%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22%23e0e0e0%22%2F%3E%3C%2Fsvg%3E')]">
					{#if isBinaryLoading}
						<div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
					{:else if blobUrl}
						<img
							src={blobUrl}
							alt={fileName}
							class="max-w-full max-h-full object-contain"
						/>
					{:else}
						<div class="flex flex-col items-center gap-2 text-slate-500 text-xs">
							<Icon name="lucide:image-off" class="w-8 h-8 opacity-40" />
							<span>Failed to load preview</span>
						</div>
					{/if}
				</div>
			{:else if isPdfFile(fileName)}
				<!-- PDF preview -->
				<div class="flex-1 h-full w-full">
					{#if isBinaryLoading}
						<div class="flex items-center justify-center h-full">
							<div class="w-5 h-5 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
						</div>
					{:else if pdfBlobUrl}
						<iframe
							src={pdfBlobUrl}
							title={fileName}
							class="w-full h-full border-0"
						></iframe>
					{:else}
						<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-500 text-xs">
							<Icon name="lucide:file-x" class="w-8 h-8 opacity-40" />
							<span>Failed to load PDF preview</span>
						</div>
					{/if}
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

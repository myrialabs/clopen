<script lang="ts">
	import type { FileNode } from '$shared/types/filesystem';
	import LoadingSpinner from '../common/feedback/LoadingSpinner.svelte';
	import MonacoEditor from '../common/editor/MonacoEditor.svelte';
	import MediaPreview from '../common/media/MediaPreview.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/utils/folder-icon-mappings';
	import { isImageFile, isSvgFile, isPdfFile, isAudioFile, isVideoFile, isBinaryFile, isBinaryContent, isPreviewableFile, formatFileSize } from '$frontend/utils/file-type';
	import { onMount } from 'svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { editor } from 'monaco-editor';
	import { debug } from '$shared/utils/logger';

	// Interface untuk MonacoEditor component
	interface MonacoEditorComponent {
		getEditor: () => editor.IStandaloneCodeEditor | null;
		getValue: () => string;
		setValue: (newValue: string) => void;
		getLanguage: () => string;
		setLanguage: (newLanguage: string) => void;
		detectLanguageFromFilename: (filename: string) => string;
		focus: () => void;
		layout: () => void;
	}

	interface Props {
		file: FileNode | null;
		content?: string;
		savedContent?: string;
		isLoading?: boolean;
		error?: string;
		onSave?: (filePath: string, content: string) => Promise<void>;
		hideHeader?: boolean;
		targetLine?: number;
		onContentChange?: (content: string) => void;
		wordWrap?: boolean;
		onToggleWordWrap?: () => void;
		externallyChanged?: boolean;
		onForceReload?: () => void;
		isBinary?: boolean;
		projectPath?: string;
	}

	const {
		file = null,
		content = '',
		savedContent: savedContentProp,
		isLoading = false,
		error = '',
		onSave,
		hideHeader = false,
		targetLine = undefined,
		onContentChange,
		wordWrap = false,
		onToggleWordWrap,
		externallyChanged = false,
		onForceReload,
		isBinary = false,
		projectPath = ''
	}: Props = $props();

	// Relative path for display
	const displayPath = $derived.by(() => {
		if (!file) return '';
		if (projectPath && file.path.startsWith(projectPath)) {
			return file.path.slice(projectPath.length).replace(/^[/\\]/, '');
		}
		return file.path;
	});

	// Theme state
	const isDark = $derived(themeStore.isDark);
	const monacoTheme = $derived(isDark ? 'vs-dark' : 'vs-light');
	// Force remount Monaco Editor when theme or file changes
	const themeKey = $derived(`monaco-${monacoTheme}-${file?.path || ''}`);

	// Edit state - always in edit mode (no toggle)
	let editableContent = $state('');
	let isSaving = $state(false);
	let hasChanges = $state(false);

	// Derived state for save button
	const canSave = $derived(hasChanges && !isSaving && !!file && !!onSave);
	const saveButtonDisabled = $derived(!canSave);

	let monacoEditorRef: MonacoEditorComponent | null = $state(null);

	// Line highlighting state
	let currentDecorations: string[] = $state([]);

	// SVG view mode
	let svgViewMode = $state<'visual' | 'code'>('visual');

	// Keyboard shortcut for save
	onMount(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				if (canSave) {
					saveChanges();
				}
			}
		}

		window.addEventListener('keydown', handleKeyDown);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
		};
	});

	// Reference content for change detection (use savedContent if provided)
	const referenceContent = $derived(savedContentProp !== undefined ? savedContentProp : content);

	// Sync editable content when file or content changes (not when user types)
	let lastSyncedContent = '';
	let lastSyncedFilePath = '';
	$effect(() => {
		const currentFilePath = file?.path || '';
		// Force sync when file changes OR when content changes
		if (content !== lastSyncedContent || currentFilePath !== lastSyncedFilePath) {
			lastSyncedContent = content;
			lastSyncedFilePath = currentFilePath;
			editableContent = content;
			hasChanges = content !== referenceContent;

			// Directly update Monaco editor to ensure content syncs
			// (bypasses reactive bind:value chain which may not flush in async contexts)
			const editor = monacoEditorRef?.getEditor();
			if (editor && editor.getValue() !== content) {
				editor.setValue(content);
			}
		}
	});

	// Handle content changes from editor
	function handleContentChange(newContent: string) {
		hasChanges = newContent !== referenceContent;
		onContentChange?.(newContent);
	}

	// Update Monaco word wrap when prop changes
	// Read wordWrap BEFORE the if-check so it's always tracked by $effect
	$effect(() => {
		const wrapValue: 'on' | 'off' = wordWrap ? 'on' : 'off';
		const editor = monacoEditorRef?.getEditor();
		if (editor) {
			editor.updateOptions({ wordWrap: wrapValue });
		}
	});

	// Handle line highlighting when targetLine changes
	$effect(() => {
		if (targetLine !== undefined && targetLine > 0) {
			setTimeout(() => {
				const editor = monacoEditorRef?.getEditor();
				if (editor) {
					editor.revealLineInCenter(targetLine);

					const newDecorations = editor.deltaDecorations(currentDecorations, [
						{
							range: {
								startLineNumber: targetLine,
								startColumn: 1,
								endLineNumber: targetLine,
								endColumn: 1
							},
							options: {
								isWholeLine: true,
								className: 'line-highlight',
								marginClassName: 'line-highlight-margin'
							}
						}
					]);

					currentDecorations = newDecorations;

					setTimeout(() => {
						if (editor) {
							editor.deltaDecorations(currentDecorations, []);
							currentDecorations = [];
						}
					}, 3000);
				}
			}, 100);
		}
	});

	// Save changes
	async function saveChanges() {
		if (!file || !onSave || !hasChanges) {
			return;
		}

		isSaving = true;
		try {
			await onSave(file.path, editableContent);
			hasChanges = false;
		} catch (error) {
			debug.error('file', 'Failed to save file:', error);
		} finally {
			isSaving = false;
		}
	}

	// Get detected language from filename
	function getDetectedLanguage(): string {
		if (!file) return 'plaintext';

		const ext = file.name.split('.').pop()?.toLowerCase();
		if (!ext) return 'plaintext';

		const languageMap: Record<string, string> = {
			js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
			mjs: 'javascript', cjs: 'javascript',
			html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
			py: 'python', pyx: 'python', pyi: 'python',
			java: 'java', c: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp',
			h: 'c', hpp: 'cpp', hxx: 'cpp',
			cs: 'csharp', csx: 'csharp', go: 'go', rs: 'rust',
			php: 'php', phtml: 'php', rb: 'ruby', rbw: 'ruby',
			swift: 'swift', kt: 'kotlin', kts: 'kotlin',
			scala: 'scala', sc: 'scala', r: 'r',
			sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
			ps1: 'powershell', psm1: 'powershell', bat: 'bat', cmd: 'bat',
			sql: 'sql', xml: 'xml', xsd: 'xml', xsl: 'xml',
			json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
			toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
			md: 'markdown', markdown: 'markdown',
			dockerfile: 'dockerfile', lua: 'lua',
			pl: 'perl', pm: 'perl', hs: 'haskell',
			fs: 'fsharp', fsx: 'fsharp', clj: 'clojure', cljs: 'clojure',
			erl: 'erlang', ex: 'elixir', exs: 'elixir',
			dart: 'dart', sol: 'solidity',
			graphql: 'graphql', gql: 'graphql',
			svelte: 'html', vue: 'html',
			gitignore: 'plaintext', env: 'plaintext', txt: 'plaintext', log: 'plaintext',
			svg: 'xml'
		};

		return languageMap[ext] || 'plaintext';
	}

	// Helper functions
	function getDisplayIcon(fileName: string, isDirectory: boolean): IconName {
		if (isDirectory) {
			return getFolderIcon(fileName, false);
		}
		return getFileIcon(fileName);
	}

	function copyToClipboard() {
		if (editableContent) {
			navigator.clipboard.writeText(editableContent);
		}
	}

	function downloadFile() {
		if (file) {
			if (editableContent) {
				const blob = new Blob([editableContent], { type: 'text/plain' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = file.name;
				a.click();
				URL.revokeObjectURL(url);
			}
		}
	}
</script>

{#if file}
	<div class="w-full h-full flex flex-col">
		<!-- Header -->
		{#if !hideHeader}
		<div class="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-slate-700">
			<div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
				<Icon name={getDisplayIcon(file.name, file.type === 'directory')} class="w-7 h-7" />
				<div class="min-w-0 flex-1">
					<h3 class="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
						{file.name}
					</h3>
					<p class="text-xs text-slate-600 dark:text-slate-400 truncate mt-0.5">
						<span class="hidden sm:inline">{displayPath} • </span> {formatFileSize(file.size || 0)}
					</p>
				</div>
			</div>

			<div class="flex items-center gap-1.5 sm:gap-1 flex-shrink-0">
				<!-- SVG view mode toggle -->
				{#if file && file.type === 'file' && isSvgFile(file.name)}
					<div class="flex bg-slate-100 dark:bg-slate-800 rounded-lg overflow-hidden mr-1">
						<button
							class="flex px-2 py-1.5 text-xs font-medium transition-colors {svgViewMode === 'visual' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
							onclick={() => { svgViewMode = 'visual'; }}
							title="Visual preview"
						>
							<Icon name="lucide:eye" class="w-3.5 h-3.5" />
						</button>
						<button
							class="flex px-2 py-1.5 text-xs font-medium transition-colors {svgViewMode === 'code' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'}"
							onclick={() => { svgViewMode = 'code'; }}
							title="Code view"
						>
							<Icon name="lucide:code" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/if}

				<!-- External change badge + refresh button -->
				{#if externallyChanged && onForceReload}
					<div class="flex items-center gap-1 mr-1">
						<span class="text-3xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-400 font-medium whitespace-nowrap">
							Changed externally
						</span>
						<button
							class="flex p-1.5 text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30 rounded-lg transition-all duration-200"
							onclick={onForceReload}
							title="Reload file from disk (discard local changes)"
						>
							<Icon name="lucide:refresh-cw" class="w-4 h-4" />
						</button>
					</div>
				{/if}

				<!-- Actions for editable files -->
				{#if file && file.type === 'file' && !isBinary && !isBinaryContent(content) && !isImageFile(file.name) && !isBinaryFile(file.name) && !isPdfFile(file.name) && !isAudioFile(file.name) && !isVideoFile(file.name) && !(isSvgFile(file.name) && svgViewMode === 'visual')}
					<!-- Word Wrap toggle -->
					{#if onToggleWordWrap}
						<button
							class="flex p-2 rounded-lg transition-all duration-200
							{wordWrap ?
								'text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/50' :
								'text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30'
							}"
							onclick={onToggleWordWrap}
							title="Toggle Word Wrap"
						>
							<Icon name="lucide:wrap-text" class="w-4 h-4" />
						</button>
					{/if}
					<!-- Save button -->
					<button
						class="flex p-2 text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30 rounded-lg transition-all duration-200 {saveButtonDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
						onclick={() => {
							if (canSave) {
								saveChanges();
							}
						}}
						disabled={saveButtonDisabled}
						title={saveButtonDisabled ? (hasChanges ? 'Saving...' : 'No changes to save') : 'Save changes (Ctrl+S)'}
					>
						{#if isSaving}
							<div class="w-4 h-4 border-2 border-green-600 border-t-transparent rounded-full animate-spin"></div>
						{:else}
							<Icon name="lucide:save" class="w-4 h-4" />
						{/if}
					</button>

					{#if editableContent}
						<button
							class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200"
							onclick={copyToClipboard}
							title="Copy content"
						>
							<Icon name="lucide:copy" class="w-4 h-4" />
						</button>
					{/if}

					<button
						class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200"
						onclick={downloadFile}
						title="Download file"
					>
						<Icon name="lucide:download" class="w-4 h-4" />
					</button>
				{:else if file && file.type === 'file'}
					<!-- Non-editable file actions -->
					<button
						class="flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200"
						onclick={downloadFile}
						title="Download file"
					>
						<Icon name="lucide:download" class="w-4 h-4" />
					</button>
				{/if}
			</div>
		</div>
		{/if}

		<!-- Content -->
		<div class="flex-1 overflow-hidden">
			{#if isLoading}
				<div class="flex items-center justify-center h-full">
					<LoadingSpinner size="lg" />
				</div>
			{:else if error}
				<div class="flex flex-col items-center justify-center h-full p-8">
					<Icon name="lucide:triangle-alert" class="w-16 h-16 text-red-400 mb-4" />
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
						Unable to load file
					</h3>
					<p class="text-sm text-slate-500 dark:text-slate-400 text-center">
						{error}
					</p>
				</div>
			{:else if file.type === 'directory'}
				<div class="flex flex-col items-center justify-center h-full p-8">
					<Icon name="lucide:folder" class="w-16 h-16 text-slate-400 mb-4" />
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
						Directory Selected
					</h3>
					<p class="text-sm text-slate-500 dark:text-slate-400 text-center">
						This is a directory. Select a file to view its content.
					</p>
				</div>
			{:else if isSvgFile(file.name)}
				{#if svgViewMode === 'visual'}
					<MediaPreview fileName={file.name} filePath={file.path} svgContent={content} />
				{:else}
					<!-- SVG code view (editable) -->
					<div class="h-full flex flex-col bg-slate-50 dark:bg-slate-950">
						<div class="flex-1 relative overflow-hidden">
							<div class="absolute inset-0">
								{#key themeKey}
								<MonacoEditor
									bind:this={monacoEditorRef}
									bind:value={editableContent}
									language="xml"
									readonly={false}
									onChange={handleContentChange}
									options={{
										minimap: { enabled: false },
										wordWrap: 'off',
										renderWhitespace: 'none',
										mouseWheelZoom: false
									}}
								/>
								{/key}
							</div>
						</div>

						{#if hasChanges}
							<div class="flex-shrink-0 p-4 bg-amber-50 dark:bg-amber-900/30 border-t border-amber-200 dark:border-amber-800">
								<div class="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
									<Icon name="lucide:circle-alert" class="w-3 h-3" />
									Unsaved changes
								</div>
							</div>
						{/if}
					</div>
				{/if}
			{:else if isPreviewableFile(file.name)}
				<MediaPreview fileName={file.name} filePath={file.path} />
			{:else if isBinary || isBinaryFile(file.name) || isBinaryContent(content)}
				<div class="flex flex-col items-center justify-center h-full p-8">
					<Icon name="lucide:file-text" class="w-16 h-16 text-slate-400 mb-4" />
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">
						Binary File
					</h3>
					<p class="text-sm text-slate-500 dark:text-slate-400 text-center mb-4">
						This file cannot be previewed in the browser.
					</p>
					<button
						class="px-6 py-2.5 bg-violet-600 text-white rounded-xl hover:bg-violet-700 transition-all duration-200"
						onclick={downloadFile}
					>
						Download File
					</button>
				</div>
			{:else}
				<!-- Code content (always in edit mode) -->
				<div class="h-full relative bg-slate-50 dark:bg-slate-950">
					<div class="absolute inset-0">
						{#key themeKey}
						<MonacoEditor
							bind:this={monacoEditorRef}
							bind:value={editableContent}
							language={getDetectedLanguage()}
							readonly={false}
							onChange={handleContentChange}
							options={{
								minimap: { enabled: false },
								wordWrap: wordWrap ? 'on' : 'off',
								renderWhitespace: 'none',
								mouseWheelZoom: false
							}}
						/>
						{/key}
					</div>
				</div>
			{/if}
		</div>
	</div>
{:else}
	<div class="h-full flex items-center justify-center">
		<div class="text-center p-12">
			<div class="bg-slate-100 dark:bg-slate-800 rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6">
				<Icon name="lucide:file-text" class="w-10 h-10 text-slate-400" />
			</div>
			<h3 class="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2">
				No File Selected
			</h3>
			<p class="text-sm text-slate-600 dark:text-slate-400">
				Select a file from the explorer to view its content.
			</p>
		</div>
	</div>
{/if}

<style>
	:global(.line-highlight) {
		background-color: rgba(255, 235, 59, 0.3) !important;
		animation: fade-out 3s ease-out forwards;
	}

	:global(.line-highlight-margin) {
		background-color: rgba(255, 235, 59, 0.5) !important;
	}

	:global(.monaco-editor.vs-dark .line-highlight) {
		background-color: rgba(255, 235, 59, 0.15) !important;
	}

	:global(.monaco-editor.vs-dark .line-highlight-margin) {
		background-color: rgba(255, 235, 59, 0.25) !important;
	}

	@keyframes fade-out {
		0% {
			background-color: rgba(255, 235, 59, 0.5);
		}
		100% {
			background-color: transparent;
		}
	}

	:global(.monaco-editor.vs-dark) {
		@keyframes fade-out {
			0% {
				background-color: rgba(255, 235, 59, 0.15);
			}
			100% {
				background-color: transparent;
			}
		}
	}
</style>

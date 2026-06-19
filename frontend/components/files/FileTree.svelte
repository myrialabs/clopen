<script module lang="ts">
	import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';

	// Persistent state that survives component destruction (mobile/desktop switch)
	const projectSearchStates = new Map<string, any>();

	function cleanupFileTreeSearchState(projectId: string): void {
		projectSearchStates.delete(projectId);
	}

	// Register once at module load to avoid duplicate closures on remount.
	registerProjectCleanup(cleanupFileTreeSearchState);
</script>

<script lang="ts">
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import type { FileNode as FileNodeType } from '$shared/types/filesystem';
	import FileNode from './FileNode.svelte';
	import SearchResults from './SearchResults.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { triggerCollapseAll } from '$frontend/stores/core/files.svelte';
	import { normalizePath } from '$shared/utils/path';
	import { onDestroy, untrack } from 'svelte';
	import {
		setFileSearchSnapshotProvider,
		loadFileSearchSlice,
		markFileSearchDirty,
		type FileSearchSlice
	} from '$frontend/stores/features/files-search-workspace.svelte';

	interface Props {
		files: FileNodeType[];
		onFileSelect?: (file: FileNodeType) => void;
		onFileAction?: (action: string, file: FileNodeType) => void;
		onPasteToRoot?: () => void;
		onNewFileInRoot?: () => void;
		onNewFolderInRoot?: () => void;
		onUploadToRoot?: () => void;
		selectedFile?: FileNodeType | null;
		expandedFolders?: Set<string>;
		onToggle?: (folderPath: string) => void;
		hasClipboard?: boolean;
		onFileOpen?: (path: string, target?: { line: number; column?: number; length?: number }) => void;
		onRefresh?: () => void;
		modifiedFiles?: Set<string>;
		activeFilePath?: string | null;
		gitStatusMap?: Map<string, string>;
		gitFolderStatusMap?: Map<string, string>;
		selectedPaths?: Set<string>;
		onNodeClick?: (file: FileNodeType, event: MouseEvent | KeyboardEvent) => void;
		onNodeDragStart?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDragOver?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDragLeave?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDrop?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDragEnd?: (file: FileNodeType, event: DragEvent) => void;
		dropTargetPath?: string | null;
		onRootDragOver?: (event: DragEvent) => void;
		onRootDragLeave?: (event: DragEvent) => void;
		onRootDrop?: (event: DragEvent) => void;
		onClearSelection?: () => void;
		isRootDropTarget?: boolean;
		/** Paths currently in a long-running operation (zip, extract, upload, …). */
		busyPaths?: Set<string>;
		/** Root-level operation in progress (e.g. upload to project root). */
		isRootBusy?: boolean;
	}

	let {
		files = [],
		onFileSelect,
		onFileAction,
		onPasteToRoot,
		onNewFileInRoot,
		onNewFolderInRoot,
		onUploadToRoot,
		selectedFile = null,
		expandedFolders,
		onToggle,
		hasClipboard = false,
		onFileOpen,
		onRefresh,
		modifiedFiles = new Set(),
		activeFilePath = null,
		gitStatusMap = new Map(),
		gitFolderStatusMap = new Map(),
		selectedPaths = new Set<string>(),
		onNodeClick,
		onNodeDragStart,
		onNodeDragOver,
		onNodeDragLeave,
		onNodeDrop,
		onNodeDragEnd,
		dropTargetPath = null,
		onRootDragOver,
		onRootDragLeave,
		onRootDrop,
		onClearSelection,
		isRootDropTarget = false,
		busyPaths = new Set<string>(),
		isRootBusy = false
	}: Props = $props();

	// Create local state if expandedFolders is not provided
	let localState = $state(new Set<string>());

	// Use provided expandedFolders or local state (computed)
	const localExpandedFolders = $derived(expandedFolders || localState);

	// State to track which menu is currently open (only one menu at a time)
	let openMenuPath = $state<string | null>(null);

	// Search visibility
	let searchVisible = $state(false);

	// Search state
	let searchQuery = $state('');
	let submittedQuery = $state('');
	let searchMode = $state<'files' | 'code'>('files');
	let isSearching = $state(false);
	let fileSearchResults = $state<any[]>([]);
	let codeSearchResults = $state<any[]>([]);
	let searchInputRef = $state<HTMLInputElement>();

	// Search options
	let caseSensitive = $state(false);
	let wholeWord = $state(false);
	let useRegex = $state(false);

	// File filter state
	let filesToInclude = $state('');
	let filesToExclude = $state('');
	let showFilters = $state(false);

	// Replace state
	let replaceQuery = $state('');
	let showReplace = $state(false);
	let isReplacing = $state(false);

	// Abort controller for cancelling search
	let searchAbortController: AbortController | null = null;

	// projectSearchStates is at module level to survive component destruction (mobile/desktop switch)
	let lastProjectId = $state('');
	// Gate the persist effect so applying a restored slice doesn't echo back a save.
	let searchHydrated = $state(false);

	/** Serializable slice of the search view (results excluded — re-run on restore). */
	function buildSearchSlice(): FileSearchSlice {
		return {
			searchVisible,
			searchQuery,
			submittedQuery,
			searchMode,
			caseSensitive,
			wholeWord,
			useRegex,
			filesToInclude,
			filesToExclude,
			showFilters,
			showReplace,
			replaceQuery
		};
	}

	function applySearchSlice(slice: FileSearchSlice): void {
		searchVisible = slice.searchVisible;
		searchQuery = slice.searchQuery;
		submittedQuery = slice.submittedQuery;
		searchMode = slice.searchMode;
		caseSensitive = slice.caseSensitive;
		wholeWord = slice.wholeWord;
		useRegex = slice.useRegex;
		filesToInclude = slice.filesToInclude;
		filesToExclude = slice.filesToExclude;
		showFilters = slice.showFilters;
		showReplace = slice.showReplace;
		replaceQuery = slice.replaceQuery;
	}

	function resetSearchState(): void {
		searchVisible = false;
		searchQuery = '';
		submittedQuery = '';
		searchMode = 'files';
		fileSearchResults = [];
		codeSearchResults = [];
		caseSensitive = false;
		wholeWord = false;
		useRegex = false;
		filesToInclude = '';
		filesToExclude = '';
		showFilters = false;
		showReplace = false;
		replaceQuery = '';
	}

	// Save/restore search state per project. The in-memory `projectSearchStates`
	// map gives instant same-session A→B→A restore (and keeps results); the
	// server-persisted slice (via the workspace coordinator) is the source of
	// truth across a refresh / other devices, where the map is empty.
	$effect(() => {
		const currentProjectId = projectState.currentProject?.id || '';
		if (currentProjectId === lastProjectId) return;

		untrack(() => {
			// Save current state for old project (in-memory; DB save flows through
			// the coordinator's snapshot provider + flush-before-switch).
			if (lastProjectId) {
				projectSearchStates.set(lastProjectId, {
					...buildSearchSlice(),
					fileSearchResults,
					codeSearchResults
				});
			}

			searchHydrated = false;
			const saved = projectSearchStates.get(currentProjectId);
			if (saved) {
				// Same-session cache hit — restore everything including results.
				applySearchSlice(saved);
				fileSearchResults = saved.fileSearchResults ?? [];
				codeSearchResults = saved.codeSearchResults ?? [];
			} else {
				// Cache miss (refresh / cross-device) — restore the server slice and
				// re-run the search so results repopulate fresh.
				const slice = currentProjectId ? loadFileSearchSlice(currentProjectId) : null;
				if (slice) {
					applySearchSlice(slice);
					fileSearchResults = [];
					codeSearchResults = [];
					if (slice.searchVisible && slice.searchQuery.trim()) {
						// Defer so projectState.currentProject.path is settled.
						setTimeout(() => performSearch(), 0);
					}
				} else {
					resetSearchState();
				}
			}
			lastProjectId = currentProjectId;
			searchHydrated = true;
		});
	});

	// Persist search view changes (server, via the coordinator). Gated on
	// `searchHydrated` so applying a restored slice above doesn't trigger a save.
	$effect(() => {
		// Track the persistable fields so any change schedules a save.
		void buildSearchSlice();
		if (!searchHydrated) return;
		markFileSearchDirty();
	});

	// Hand the coordinator a live snapshot of the search view for server saves.
	$effect(() => {
		setFileSearchSnapshotProvider(() => buildSearchSlice());
		return () => setFileSearchSnapshotProvider(null);
	});

	// Save search state to persistent storage on component destruction (mobile/desktop switch)
	onDestroy(() => {
		const currentProjectId = projectState.currentProject?.id || '';
		if (currentProjectId) {
			projectSearchStates.set(currentProjectId, {
				searchVisible,
				searchQuery,
				submittedQuery,
				searchMode,
				fileSearchResults,
				codeSearchResults,
				caseSensitive,
				wholeWord,
				useRegex,
				filesToInclude,
				filesToExclude,
				showFilters,
				showReplace,
				replaceQuery
			});
		}
	});

	function handleMenuToggle(filePath: string) {
		openMenuPath = openMenuPath === filePath ? null : filePath;
	}

	function handleFileSelect(file: FileNodeType) {
		onFileSelect?.(file);
	}

	function handleFileAction(action: string, file: FileNodeType) {
		if (action === 'find-in-folder') {
			const projectPath = projectState.currentProject?.path || '';
			let relativePath = file.path;
			if (projectPath && relativePath.startsWith(projectPath)) {
				relativePath = relativePath.slice(projectPath.length);
				if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
					relativePath = relativePath.slice(1);
				}
			}
			searchVisible = true;
			searchMode = 'code';
			filesToInclude = relativePath;
			showFilters = true;
			setTimeout(() => searchInputRef?.focus(), 100);
			return;
		}
		onFileAction?.(action, file);
	}

	function toggleFolder(folderPath: string) {
		if (onToggle) {
			onToggle(folderPath);
		} else if (expandedFolders) {
			if (expandedFolders.has(folderPath)) {
				expandedFolders.delete(folderPath);
			} else {
				expandedFolders.add(folderPath);
			}
			expandedFolders = new Set(expandedFolders);
		} else {
			if (localState.has(folderPath)) {
				localState.delete(folderPath);
			} else {
				localState.add(folderPath);
			}
			localState = new Set(localState);
		}
	}

	function switchToSearch() {
		searchVisible = true;
		setTimeout(() => {
			searchInputRef?.focus();
			if (searchQuery.trim()) {
				performSearch();
			}
		}, 100);
	}

	// Search functions
	async function performSearch() {
		if (!searchQuery.trim()) {
			fileSearchResults = [];
			codeSearchResults = [];
			submittedQuery = '';
			return;
		}

		const projectPath = projectState.currentProject?.path;
		if (!projectPath) return;

		submittedQuery = searchQuery.trim();
		isSearching = true;

		searchAbortController = new AbortController();

		try {
			if (searchMode === 'files') {
				const results = await ws.http('files:search-files', {
					project_path: projectPath,
					query: submittedQuery
				});

				fileSearchResults = results || [];
			} else {
				// Only apply filters when the filter panel is visible
				const includePattern = showFilters ? (filesToInclude || undefined) : undefined;
				const excludePattern = showFilters ? (filesToExclude || undefined) : undefined;
				const data = await ws.http('files:search-code', {
					project_path: projectPath,
					query: submittedQuery,
					case_sensitive: caseSensitive,
					whole_word: wholeWord,
					use_regex: useRegex,
					include_pattern: includePattern,
					exclude_pattern: excludePattern
				});

				codeSearchResults = data || [];
			}
		} catch (error) {
			if (searchAbortController?.signal.aborted) {
				return;
			}
			addNotification({
				type: 'error',
				title: 'Search Failed',
				message: error instanceof Error ? error.message : 'Search failed',
				duration: 3000
			});
		} finally {
			isSearching = false;
			searchAbortController = null;
		}
	}

	function cancelSearch() {
		if (searchAbortController) {
			searchAbortController.abort();
			searchAbortController = null;
		}
		isSearching = false;
	}

	async function handleReplaceAll() {
		if (!submittedQuery) return;

		const projectPath = projectState.currentProject?.path;
		if (!projectPath) return;

		const confirmed = await showConfirm({
			title: 'Replace All',
			message: `Replace all occurrences of "${submittedQuery}" with "${replaceQuery}" across all matching files? This action cannot be undone.`,
			type: 'warning',
			confirmText: 'Replace All',
			cancelText: 'Cancel'
		});

		if (!confirmed) return;

		// Respect showFilters state - same as search
		const includePattern = showFilters ? (filesToInclude || undefined) : undefined;
		const excludePattern = showFilters ? (filesToExclude || undefined) : undefined;

		isReplacing = true;
		try {
			const result = await ws.http('files:replace-in-files', {
				project_path: projectPath,
				search_query: submittedQuery,
				replace_with: replaceQuery,
				case_sensitive: caseSensitive,
				whole_word: wholeWord,
				use_regex: useRegex,
				include_pattern: includePattern,
				exclude_pattern: excludePattern
			});

			addNotification({
				type: 'success',
				title: 'Replace Complete',
				message: `Replaced ${result.totalReplacements} occurrences in ${result.totalFiles} files`,
				duration: 5000
			});

			onRefresh?.();
			await performSearch();
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Replace Failed',
				message: error instanceof Error ? error.message : 'Replace failed',
				duration: 5000
			});
		} finally {
			isReplacing = false;
		}
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			performSearch();
		} else if (e.key === 'Escape') {
			clearSearch();
		}
	}

	function clearSearch() {
		searchQuery = '';
		submittedQuery = '';
		fileSearchResults = [];
		codeSearchResults = [];
	}

	function switchSearchMode(mode: 'files' | 'code') {
		searchMode = mode;
		// Clear results but keep query, then auto-search
		fileSearchResults = [];
		codeSearchResults = [];
		submittedQuery = '';
		if (searchQuery.trim()) {
			performSearch();
		}
	}

	// Search result handlers
	function handleFileClick(result: any) {
		if (onFileOpen) {
			onFileOpen(result.path);
		}
	}

	function handleCodeMatchClick(result: any, match: any) {
		const projectPath = projectState.currentProject?.path || '';
		const separator = projectPath.includes('\\') ? '\\' : '/';
		// Normalize relativePath to use the OS-appropriate separator
		const relPath = separator === '\\'
			? result.relativePath.replace(/\//g, '\\')
			: result.relativePath.replace(/\\/g, '/');
		const fullPath = `${projectPath}${separator}${relPath}`;

		if (onFileOpen) {
			onFileOpen(fullPath, {
				line: match.line,
				column: match.column,
				length: match.length
			});
		}
	}

	// Public method for search toggle
	export function focusSearch(mode?: 'files' | 'code') {
		searchVisible = true;
		if (mode) {
			searchMode = mode;
		}
		setTimeout(() => searchInputRef?.focus(), 100);
	}

	// Public method for "Find in Folder"
	export function openFindInFolder(folderRelativePath: string) {
		searchVisible = true;
		searchMode = 'code';
		filesToInclude = folderRelativePath;
		showFilters = true;
		setTimeout(() => searchInputRef?.focus(), 100);
	}
</script>

<div class="relative flex flex-col h-full overflow-hidden">
	<!-- Modern Header -->
	<div class="px-5 py-2.5 border-b border-slate-200 dark:border-slate-700">
		<div class="flex items-start justify-between gap-2">
			<div class="flex-1 min-w-0" title={projectState.currentProject?.path}>
				<h3 class="text-sm font-bold text-slate-900 dark:text-slate-100">
					{projectState.currentProject?.name}
				</h3>
				<p class="text-xs text-slate-600 dark:text-slate-400 mt-0.5 font-mono truncate">
					{projectState.currentProject?.path}
				</p>
			</div>
			<div class="flex items-center gap-1">
				{#if localExpandedFolders.size > 0}
					<button
						class="flex flex-shrink-0 p-1.5 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-md transition-colors"
						onclick={triggerCollapseAll}
						title="Collapse All Folders"
					>
						<Icon name="lucide:fold-vertical" class="w-4 h-4" />
					</button>
				{/if}
				{#if onNewFileInRoot}
					<button
						class="flex flex-shrink-0 p-1.5 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-md transition-colors"
						onclick={onNewFileInRoot}
						title="New File"
					>
						<Icon name="lucide:file-plus" class="w-4 h-4" />
					</button>
				{/if}
				{#if onNewFolderInRoot}
					<button
						class="flex flex-shrink-0 p-1.5 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-md transition-colors"
						onclick={onNewFolderInRoot}
						title="New Folder"
					>
						<Icon name="lucide:folder-plus" class="w-4 h-4" />
					</button>
				{/if}
				{#if onUploadToRoot}
					<button
						class="flex flex-shrink-0 p-1.5 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-md transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
						onclick={onUploadToRoot}
						disabled={isRootBusy}
						title={isRootBusy ? 'Uploading…' : 'Upload File'}
					>
						{#if isRootBusy}
							<span class="w-4 h-4 inline-flex items-center justify-center">
								<span class="w-3.5 h-3.5 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin"></span>
							</span>
						{:else}
							<Icon name="lucide:upload" class="w-4 h-4" />
						{/if}
					</button>
				{/if}
				{#if hasClipboard && onPasteToRoot}
					<button
						class="flex flex-shrink-0 p-1.5 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-md transition-colors"
						onclick={onPasteToRoot}
						title="Paste to root"
					>
						<Icon name="lucide:clipboard" class="w-4 h-4" />
					</button>
				{/if}
			</div>
		</div>
	</div>

	<!-- Tab Navigation -->
	<div class="relative flex border-b border-slate-200 dark:border-slate-700">
		<button
			onclick={() => { searchVisible = false; }}
			class="relative flex-1 flex items-center justify-center px-3 py-2 text-xs font-medium transition-colors {!searchVisible ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
		>
			Explorer
			{#if !searchVisible}
				<span class="absolute bottom-0 inset-x-0 h-px bg-violet-600 dark:bg-violet-400"></span>
			{/if}
		</button>
		<button
			onclick={switchToSearch}
			class="relative flex-1 flex items-center justify-center px-3 py-2 text-xs font-medium transition-colors {searchVisible ? 'text-violet-600 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'}"
		>
			Search
			{#if searchVisible}
				<span class="absolute bottom-0 inset-x-0 h-px bg-violet-600 dark:bg-violet-400"></span>
			{/if}
		</button>
	</div>

	<!-- Search Bar -->
	{#if searchVisible}
		<div class="px-3 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
			<!-- Search Input -->
			<div class="relative mb-2">
				<input
					bind:this={searchInputRef}
					bind:value={searchQuery}
					onkeydown={handleSearchKeydown}
					type="text"
					placeholder="Search {searchMode === 'files' ? 'files...' : 'code...'}"
					class="w-full pl-3 pr-16 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring focus:ring-violet-500 dark:focus:ring-violet-400 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
				/>
				<div class="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
					{#if submittedQuery}
						<button
							onclick={clearSearch}
							class="p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
							title="Clear search"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					{/if}
					{#if isSearching}
						<button
							onclick={cancelSearch}
							class="px-1.5 py-0.5 text-xs font-medium rounded transition-colors bg-red-600 text-white hover:bg-red-700"
							title="Cancel search"
						>
							<Icon name="lucide:circle-stop" class="w-3.5 h-3.5" />
						</button>
					{:else}
						<button
							onclick={performSearch}
							disabled={!searchQuery.trim()}
							class="px-1.5 py-0.5 text-xs font-medium rounded transition-colors {searchQuery.trim() ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-slate-300 dark:bg-slate-700 text-slate-500 dark:text-slate-400 cursor-not-allowed'}"
							title="Search (Enter)"
						>
							<Icon name="lucide:arrow-right" class="w-3.5 h-3.5" />
						</button>
					{/if}
				</div>
			</div>

			<!-- Replace input (code mode only) -->
			{#if searchMode === 'code' && showReplace}
				<div class="relative mb-2">
					<input
						bind:value={replaceQuery}
						type="text"
						placeholder="Replace with..."
						class="w-full pl-3 pr-16 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring focus:ring-violet-500 dark:focus:ring-violet-400 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
					/>
					<div class="absolute right-2 top-1/2 -translate-y-1/2">
						<button
							onclick={handleReplaceAll}
							disabled={!submittedQuery || isReplacing}
							class="p-0.5 rounded transition-colors {submittedQuery && !isReplacing ? 'text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-900/30' : 'text-slate-400 dark:text-slate-600 cursor-not-allowed'}"
							title="Replace All"
						>
							{#if isReplacing}
								<div class="w-3.5 h-3.5 border-2 border-orange-600 border-t-transparent rounded-full animate-spin"></div>
							{:else}
								<Icon name="lucide:replace-all" class="w-3.5 h-3.5" />
							{/if}
						</button>
					</div>
				</div>
			{/if}

			<!-- Search Mode Toggle & Options -->
			<div class="flex items-center gap-2">
				<div class="flex bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden">
					<button
						onclick={() => switchSearchMode('files')}
						class="px-3 py-1 text-xs font-medium transition-colors {searchMode === 'files' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					>
						Files
					</button>
					<button
						onclick={() => switchSearchMode('code')}
						class="px-3 py-1 text-xs font-medium transition-colors {searchMode === 'code' ? 'bg-violet-600 text-white' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					>
						Code
					</button>
				</div>

				{#if searchMode === 'code'}
					<div class="flex items-center gap-1 ml-auto">
						<button
							onclick={() => { caseSensitive = !caseSensitive; }}
							class="font-medium text-xs w-6 flex p-1 rounded transition-colors {caseSensitive ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
							title="Match Case"
						>
							Aa
						</button>
						<button
							onclick={() => { wholeWord = !wholeWord; }}
							class="underline underline-offset-2 font-medium text-xs w-6 flex p-1 rounded transition-colors {wholeWord ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
							title="Match Whole Word"
						>
							Ab
						</button>
						<button
							onclick={() => { useRegex = !useRegex; }}
							class="flex p-1 rounded transition-colors {useRegex ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
							title="Use Regular Expression"
						>
							<Icon name="lucide:regex" class="w-3.5 h-3.5" />
						</button>
						<button
							onclick={() => { showReplace = !showReplace; }}
							class="flex p-1 rounded transition-colors {showReplace ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
							title="Toggle Replace"
						>
							<Icon name="lucide:replace" class="w-3.5 h-3.5" />
						</button>
						<button
							onclick={() => { showFilters = !showFilters; }}
							class="flex p-1 rounded transition-colors {showFilters ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
							title="Toggle File Filters"
						>
							<Icon name="lucide:filter" class="w-3.5 h-3.5" />
						</button>
					</div>
				{/if}
			</div>

			<!-- File filters (code mode only) - use hidden to preserve input values -->
			<div class="mt-2 space-y-1.5" class:hidden={!(searchMode === 'code' && showFilters)}>
				<input
					bind:value={filesToInclude}
					type="text"
					placeholder="files to include (e.g. *.ts, src/)"
					class="w-full px-2.5 py-1 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-1 focus:ring-violet-500 dark:focus:ring-violet-400 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
				/>
				<input
					bind:value={filesToExclude}
					type="text"
					placeholder="files to exclude (e.g. *.min.js, *.map)"
					class="w-full px-2.5 py-1 text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md focus:outline-none focus:ring-1 focus:ring-violet-500 dark:focus:ring-violet-400 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
				/>
			</div>
		</div>
	{/if}

	<!-- Search Results OR File Tree -->
	{#if searchVisible}
		<!-- When search is visible, always show search area (no file tree) -->
		{#if submittedQuery || isSearching}
			<div class="flex-1 overflow-hidden">
				<SearchResults
					mode={searchMode}
					query={submittedQuery}
					fileResults={fileSearchResults}
					codeResults={codeSearchResults}
					isLoading={isSearching}
					{useRegex}
					onFileClick={handleFileClick}
					onCodeMatchClick={handleCodeMatchClick}
				/>
			</div>
		{:else}
			<div class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400 px-6">
				<Icon name="lucide:search" class="w-8 h-8 opacity-40" />
				<p class="text-sm text-center">Enter a search query to find {searchMode === 'files' ? 'files' : 'code'}</p>
			</div>
		{/if}
	{:else}
		<div
			class="overflow-auto flex-1 p-2 select-none {isRootDropTarget ? 'ring-2 ring-violet-500/40 ring-inset' : ''}"
			ondragover={onRootDragOver ? (e) => onRootDragOver(e) : undefined}
			ondragleave={onRootDragLeave ? (e) => onRootDragLeave(e) : undefined}
			ondrop={onRootDrop ? (e) => onRootDrop(e) : undefined}
			onclick={(e) => {
				if (e.target === e.currentTarget && onClearSelection) onClearSelection();
			}}
			role="tree"
			tabindex="-1"
		>
			{#if files.length === 0}
				<div class="text-center py-12">
					<div class="bg-slate-100 dark:bg-slate-800 rounded-full w-16 h-16 flex items-center justify-center mx-auto mb-4">
						<Icon name="lucide:file-text" class="w-8 h-8 text-slate-400" />
					</div>
					<p class="text-sm font-semibold text-slate-600 dark:text-slate-300">No files in project</p>
					<p class="text-xs text-slate-500 dark:text-slate-400 mt-1">
						Create a file or folder to get started
					</p>
				</div>
			{:else}
				<div class="space-y-1 h-0">
					{#each files as file (file.path)}
						<FileNode
							{file}
							isSelected={activeFilePath ? file.path === activeFilePath : selectedFile?.path === file.path}
							isExpanded={localExpandedFolders.has(file.path)}
							isModified={modifiedFiles.has(file.path)}
							{openMenuPath}
							expandedFolders={localExpandedFolders}
							onSelect={handleFileSelect}
							onAction={handleFileAction}
							onToggle={toggleFolder}
							onMenuToggle={handleMenuToggle}
							{hasClipboard}
							{modifiedFiles}
							{activeFilePath}
							{gitStatusMap}
							{gitFolderStatusMap}
							{selectedPaths}
							onClick={onNodeClick}
							{onNodeDragStart}
							{onNodeDragOver}
							{onNodeDragLeave}
							{onNodeDrop}
							{onNodeDragEnd}
							{dropTargetPath}
							{busyPaths}
						/>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

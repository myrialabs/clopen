<script module lang="ts">
	// Persistent state that survives component destruction (mobile/desktop switch)
	const projectSearchStates = new Map<string, any>();
</script>

<script lang="ts">
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import type { FileNode as FileNodeType } from '$shared/types/filesystem';
	import FileNode from './FileNode.svelte';
	import SearchResults from './SearchResults.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import ws from '$frontend/lib/utils/ws';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import { showConfirm } from '$frontend/lib/stores/ui/dialog.svelte';
	import { normalizePath } from '$shared/utils/path';
	import { onDestroy } from 'svelte';

	interface Props {
		files: FileNodeType[];
		onFileSelect?: (file: FileNodeType) => void;
		onFileAction?: (action: string, file: FileNodeType) => void;
		onPasteToRoot?: () => void;
		onNewFileInRoot?: () => void;
		onNewFolderInRoot?: () => void;
		selectedFile?: FileNodeType | null;
		expandedFolders?: Set<string>;
		onToggle?: (folderPath: string) => void;
		hasClipboard?: boolean;
		onFileOpen?: (path: string, lineNumber?: number) => void;
		onRefresh?: () => void;
		modifiedFiles?: Set<string>;
		activeFilePath?: string | null;
	}

	let {
		files = [],
		onFileSelect,
		onFileAction,
		onPasteToRoot,
		onNewFileInRoot,
		onNewFolderInRoot,
		selectedFile = null,
		expandedFolders,
		onToggle,
		hasClipboard = false,
		onFileOpen,
		onRefresh,
		modifiedFiles = new Set(),
		activeFilePath = null
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

	// Save/restore search state per project
	$effect(() => {
		const currentProjectId = projectState.currentProject?.id || '';
		if (currentProjectId !== lastProjectId) {
			// Save current state for old project
			if (lastProjectId) {
				projectSearchStates.set(lastProjectId, {
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
			// Restore or reset for new project
			const saved = projectSearchStates.get(currentProjectId);
			if (saved) {
				searchVisible = saved.searchVisible;
				searchQuery = saved.searchQuery;
				submittedQuery = saved.submittedQuery;
				searchMode = saved.searchMode;
				fileSearchResults = saved.fileSearchResults;
				codeSearchResults = saved.codeSearchResults;
				caseSensitive = saved.caseSensitive;
				wholeWord = saved.wholeWord;
				useRegex = saved.useRegex;
				filesToInclude = saved.filesToInclude;
				filesToExclude = saved.filesToExclude;
				showFilters = saved.showFilters;
				showReplace = saved.showReplace;
				replaceQuery = saved.replaceQuery;
			} else {
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
			lastProjectId = currentProjectId;
		}
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

	// Toggle search visibility (preserve inputs, auto-submit on re-open)
	function toggleSearch() {
		searchVisible = !searchVisible;
		if (searchVisible) {
			setTimeout(() => {
				searchInputRef?.focus();
				// Auto-submit if there's already a query
				if (searchQuery.trim()) {
					performSearch();
				}
			}, 100);
		}
		// Don't clear search state on close - preserve inputs
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
			onFileOpen(fullPath, match.line);
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
	<div class="px-5 py-3 border-b border-slate-200 dark:border-slate-700">
		<div class="flex items-start justify-between gap-2">
			<div class="flex-1 min-w-0">
				<h3 class="text-sm font-bold text-slate-900 dark:text-slate-100">
					{projectState.currentProject?.name}
				</h3>
				<p class="text-xs text-slate-600 dark:text-slate-400 mt-0.5 font-mono truncate">
					{projectState.currentProject?.path}
				</p>
			</div>
			<div class="flex items-center gap-1">
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
				<!-- Search toggle button -->
				<button
					class="flex flex-shrink-0 p-1.5 rounded-md transition-colors {searchVisible ? 'text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30' : 'text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30'}"
					onclick={toggleSearch}
					title="Search"
				>
					<Icon name="lucide:search" class="w-4 h-4" />
				</button>
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

	<!-- Search Bar (toggle) -->
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
		<div class="overflow-auto flex-1 p-2 select-none">
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
						/>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

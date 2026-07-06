<script lang="ts">
	import type { FileNode as FileNodeType } from '$shared/types/filesystem';
	import FileNode from './FileNode.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/utils/folder-icon-mappings';
	import { getGitStatusColor, getGitStatusBadgeLabel, getGitStatusLabel } from '$frontend/utils/git-status';
	import { onMount } from 'svelte';
	import { isLocalConnection, isMac, isWindows, isLinux } from '$frontend/utils/platform';
	import { isExtractableArchive } from '$frontend/utils/archive';

	const {
		file,
		isSelected = false,
		isExpanded = false,
		isModified = false,
		openMenuPath = null,
		depth = 0,
		onSelect,
		onAction,
		onToggle,
		onMenuToggle,
		expandedFolders,
		hasClipboard = false,
		modifiedFiles = new Set<string>(),
		activeFilePath = null,
		gitStatusMap = new Map<string, string>(),
		gitFolderStatusMap = new Map<string, string>(),
		selectedPaths = new Set<string>(),
		onClick,
		onNodeDragStart,
		onNodeDragOver,
		onNodeDragLeave,
		onNodeDrop,
		onNodeDragEnd,
		dropTargetPath = null,
		busyPaths = new Set<string>()
	}: {
		file: FileNodeType;
		isSelected?: boolean;
		isExpanded?: boolean;
		isModified?: boolean;
		openMenuPath?: string | null;
		depth?: number;
		onSelect?: (file: FileNodeType) => void;
		onAction?: (action: string, file: FileNodeType) => void;
		onToggle?: (folderPath: string) => void;
		onMenuToggle?: (filePath: string) => void;
		expandedFolders?: Set<string>;
		hasClipboard?: boolean;
		modifiedFiles?: Set<string>;
		activeFilePath?: string | null;
		gitStatusMap?: Map<string, string>;
		gitFolderStatusMap?: Map<string, string>;
		selectedPaths?: Set<string>;
		onClick?: (file: FileNodeType, event: MouseEvent | KeyboardEvent) => void;
		onNodeDragStart?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDragOver?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDragLeave?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDrop?: (file: FileNodeType, event: DragEvent) => void;
		onNodeDragEnd?: (file: FileNodeType, event: DragEvent) => void;
		dropTargetPath?: string | null;
		busyPaths?: Set<string>;
	} = $props();

	const revealLabel = $derived(
		isMac() ? 'Reveal in Finder' :
		isWindows() ? 'Show in Explorer' :
		isLinux() ? 'Show in Files' :
		'Show in File Manager'
	);



	const isBusy = $derived(busyPaths.has(file.path));

	// Determine if this node is the active file
	const isActiveFile = $derived(
		activeFilePath ? file.path === activeFilePath : isSelected
	);

	// Multi-selection membership (separate from the single active-file highlight).
	const isInSelection = $derived(selectedPaths.has(file.path));
	const isDropTarget = $derived(
		file.type === 'directory' && dropTargetPath !== null && dropTargetPath === file.path
	);

	// Compute if this node's menu is open
	const isMenuOpen = $derived(openMenuPath === file.path);

	// Check if any descendant is modified (for folder indicator)
	function hasModifiedDescendant(node: FileNodeType, mFiles: Set<string>): boolean {
		if (node.type !== 'directory' || !node.children) return false;
		for (const child of node.children) {
			if (mFiles.has(child.path)) return true;
			if (child.type === 'directory' && hasModifiedDescendant(child, mFiles)) return true;
		}
		return false;
	}
	const showModifiedIndicator = $derived(
		isModified || (file.type === 'directory' && hasModifiedDescendant(file, modifiedFiles))
	);

	// Git status code for this node — files lookup direct, folders use aggregated map
	const gitStatusCode = $derived(
		file.type === 'directory'
			? gitFolderStatusMap.get(file.path) || ''
			: gitStatusMap.get(file.path) || ''
	);
	const gitStatusLetter = $derived(
		gitStatusCode ? getGitStatusLabel(gitStatusCode) : ''
	);
	const gitStatusTextColor = $derived(
		gitStatusCode ? getGitStatusColor(gitStatusCode) : ''
	);
	const gitStatusTitle = $derived(
		gitStatusCode ? getGitStatusBadgeLabel(gitStatusCode) : ''
	);

	let nodeElement: HTMLDivElement;
	let menuButtonElement: HTMLButtonElement;
	let menuStyle = $state('');

	function computeMenuStyle(x: number, y: number, alignRight: boolean): string {
		const menuHeight = 200;
		const isAbove = y + menuHeight > window.innerHeight && y > menuHeight;
		const verticalStyle = isAbove
			? `bottom: ${window.innerHeight - y}px;`
			: `top: ${y}px;`;
		const horizontalStyle = alignRight ? `right: ${x}px;` : `left: ${x}px;`;
		return `${horizontalStyle} ${verticalStyle}`;
	}

	function toggleMenu(event: Event) {
		event.stopPropagation();
		if (!isMenuOpen) {
			const rect = menuButtonElement.getBoundingClientRect();
			menuStyle = computeMenuStyle(window.innerWidth - rect.right, rect.bottom, true);
		}
		onMenuToggle?.(file.path);
	}

	function closeMenu() {
		onMenuToggle?.(file.path);
	}

	function getDisplayIcon(fileName: string, isDirectory: boolean): IconName {
		if (isDirectory) {
			return getFolderIcon(fileName, isExpanded);
		}
		
		return getFileIcon(fileName);
	}

	function handleClick(event: MouseEvent | KeyboardEvent) {
		if (isBusy) return;
		if (onClick) {
			onClick(file, event);
			return;
		}
		if (file.type === 'directory') {
			onToggle?.(file.path);
		} else {
			onSelect?.(file);
		}
	}

	function handleContextMenu(event: MouseEvent) {
		event.preventDefault();
		if (isBusy) return;
		if (!isMenuOpen) {
			menuStyle = computeMenuStyle(event.clientX, event.clientY, false);
		}
		onMenuToggle?.(file.path);
	}

	function handleAction(action: string, event: Event) {
		event.stopPropagation();
		if (isBusy) return;
		onAction?.(action, file);
	}

	// Close menu when clicking outside
	onMount(() => {
		function handleClickOutside(event: MouseEvent) {
			if (isMenuOpen && nodeElement && !nodeElement.contains(event.target as Node)) {
				closeMenu();
			}
		}

		document.addEventListener('click', handleClickOutside);
		return () => {
			document.removeEventListener('click', handleClickOutside);
		};
	});
</script>

<div
	bind:this={nodeElement}
	class="group relative flex items-center space-x-2 px-2 py-1.5 rounded-md transition-colors {isActiveFile
		? 'bg-violet-500/10 dark:bg-violet-500/15 text-slate-900 dark:text-slate-100'
		: isInSelection
			? 'bg-violet-500/5 dark:bg-violet-500/10 text-slate-900 dark:text-slate-100'
			: 'hover:bg-slate-100/50 dark:hover:bg-slate-800/50'} {isDropTarget ? 'ring-2 ring-violet-500/60 ring-inset' : ''} {isBusy ? 'opacity-60 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}"
	class:selected={isActiveFile}
	class:directory={file.type === 'directory'}
	title={file.name}
	style="padding-left: {(depth * 12 + 6) / 16}rem"
	aria-busy={isBusy ? 'true' : undefined}
	onclick={handleClick}
	oncontextmenu={handleContextMenu}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleClick(e);
		}
	}}
	role="button"
	tabindex="0"
	aria-label="{file.type === 'directory' ? 'Folder' : 'File'}: {file.name}"
	draggable={onNodeDragStart && !isBusy ? true : undefined}
	ondragstart={onNodeDragStart && !isBusy ? (e) => onNodeDragStart(file, e) : undefined}
	ondragover={onNodeDragOver && !isBusy ? (e) => onNodeDragOver(file, e) : undefined}
	ondragleave={onNodeDragLeave && !isBusy ? (e) => onNodeDragLeave(file, e) : undefined}
	ondrop={onNodeDrop && !isBusy ? (e) => onNodeDrop(file, e) : undefined}
	ondragend={onNodeDragEnd && !isBusy ? (e) => onNodeDragEnd(file, e) : undefined}
>
	<!-- Expand/collapse arrow for directories -->
	{#if file.type === 'directory'}
		<span class="flex-shrink-0 w-4 h-4 flex items-center justify-center text-slate-400">
			{#if isExpanded}
				<Icon name="lucide:chevron-down" class="w-3 h-3" />
			{:else}
				<Icon name="lucide:chevron-right" class="w-3 h-3" />
			{/if}
		</span>
	{:else}
		<span class="w-4"></span>
	{/if}

	<!-- File/folder icon (or spinner while busy) -->
	<span class="flex-shrink-0 inline-flex items-center justify-center w-4 h-4">
		{#if isBusy}
			<span
				class="w-3.5 h-3.5 border-2 border-violet-500/30 border-t-violet-500 rounded-full animate-spin"
				title="Working…"
				aria-label="Working"
			></span>
		{:else}
			<Icon name={getDisplayIcon(file.name, file.type === 'directory')} />
		{/if}
	</span>

	<!-- File/folder name -->
	<span class="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300 truncate min-w-0">
		{file.name}
	</span>

	<!-- Status indicators (unsaved dot + git status letter) -->
	{#if showModifiedIndicator || gitStatusCode}
		<span class="flex items-center gap-1 flex-shrink-0">
			{#if showModifiedIndicator}
				<span
					class="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-600"
					title="Unsaved changes"
				></span>
			{/if}
			{#if gitStatusCode}
				<span
					class="text-xs font-bold {gitStatusTextColor}"
					title={gitStatusTitle}
				>{gitStatusLetter}</span>
			{/if}
		</span>
	{/if}

	<!-- Actions menu (always visible, triggered by click) -->
	<div class="flex-shrink-0">
		<div class="relative">
			<button
				bind:this={menuButtonElement}
				class="flex p-1.5 -my-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors rounded-md hover:bg-slate-200/50 dark:hover:bg-slate-700/50 {isMenuOpen ? 'bg-slate-200/50 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300' : ''}"
				onclick={toggleMenu}
				title="Actions"
				aria-label="File actions"
			>
				<Icon name="lucide:ellipsis" class="w-3 h-3" />
			</button>

			{#if isMenuOpen}
			<div
				role="menu"
				tabindex="-1"
				class="fixed bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg py-1 w-44 max-h-80 overflow-y-auto z-50 shadow-lg"
				style={menuStyle}
				onclick={(e) => e.stopPropagation()}
			>
				<!-- New File & New Folder (hanya untuk directory) -->
				{#if file.type === 'directory'}
					<button
						class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
						onclick={(e) => { handleAction('new-file', e); closeMenu(); }}
					>
						<Icon name="lucide:file-plus" class="w-3 h-3" />
						New File
					</button>

					<button
						class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
						onclick={(e) => { handleAction('new-folder', e); closeMenu(); }}
					>
						<Icon name="lucide:folder-plus" class="w-3 h-3" />
						New Folder
					</button>

					<button
						class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
						onclick={(e) => { handleAction('upload', e); closeMenu(); }}
					>
						<Icon name="lucide:upload" class="w-3 h-3" />
						Upload File...
					</button>

					<button
						class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
						onclick={(e) => { handleAction('find-in-folder', e); closeMenu(); }}
					>
						<Icon name="lucide:search" class="w-3 h-3" />
						Find in Folder
					</button>

					<div class="border-t border-slate-200 dark:border-slate-700 my-1"></div>
				{/if}

				<!-- Cut, Copy, Paste -->
				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('cut', e); closeMenu(); }}
				>
					<Icon name="lucide:scissors" class="w-3 h-3" />
					Cut
				</button>

				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('copy', e); closeMenu(); }}
				>
					<Icon name="lucide:copy" class="w-3 h-3" />
					Copy
				</button>

				{#if hasClipboard && file.type === 'directory'}
					<button
						class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
						onclick={(e) => { handleAction('paste', e); closeMenu(); }}
					>
						<Icon name="lucide:clipboard" class="w-3 h-3" />
						Paste
					</button>
				{/if}

				<div class="border-t border-slate-200 dark:border-slate-700 my-1"></div>

				<!-- Copy Path, Copy Relative Path -->
				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('copy-path', e); closeMenu(); }}
				>
					<Icon name="lucide:copy" class="w-3 h-3" />
					Copy Path
				</button>

				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('copy-relative-path', e); closeMenu(); }}
				>
					<Icon name="lucide:link" class="w-3 h-3" />
					Copy Relative Path
				</button>

				{#if isLocalConnection()}
				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('reveal-in-file-manager', e); closeMenu(); }}
				>
					<Icon name="lucide:folder-open" class="w-3 h-3" />
					{revealLabel}
				</button>
			{/if}

				<div class="border-t border-slate-200 dark:border-slate-700 my-1"></div>

				<!-- Archive actions -->
				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('zip', e); closeMenu(); }}
				>
					<Icon name="lucide:file-archive" class="w-3 h-3" />
					Compress…
				</button>

				{#if file.type === 'file' && isExtractableArchive(file.name)}
					<button
						class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
						onclick={(e) => { handleAction('extract', e); closeMenu(); }}
					>
						<Icon name="lucide:archive-restore" class="w-3 h-3" />
						Extract Here
					</button>
				{/if}

				<div class="border-t border-slate-200 dark:border-slate-700 my-1"></div>

				<!-- Duplicate, Rename, Delete -->
				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('duplicate', e); closeMenu(); }}
				>
					<Icon name="lucide:copy-plus" class="w-3 h-3" />
					Duplicate
				</button>

				<button
					class="w-full px-3 py-1.5 text-xs text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
					onclick={(e) => { handleAction('rename', e); closeMenu(); }}
				>
					<Icon name="lucide:pencil" class="w-3 h-3" />
					Rename
				</button>

				<button
					class="w-full px-3 py-1.5 text-xs text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
					onclick={(e) => { handleAction('delete', e); closeMenu(); }}
				>
					<Icon name="lucide:trash-2" class="w-3 h-3" />
					Delete
				</button>
			</div>
			{/if}
		</div>
	</div>
</div>

<!-- Show children if directory is expanded -->
{#if file.type === 'directory' && isExpanded && file.children}
	{#each file.children as child (child.path)}
		<FileNode
			file={child}
			isSelected={false}
			isExpanded={expandedFolders?.has(child.path) || false}
			isModified={modifiedFiles.has(child.path)}
			{openMenuPath}
			depth={depth + 1}
			{onSelect}
			{onAction}
			{onToggle}
			{onMenuToggle}
			{expandedFolders}
			{hasClipboard}
			{modifiedFiles}
			{activeFilePath}
			{gitStatusMap}
			{gitFolderStatusMap}
			{selectedPaths}
			{onClick}
			{onNodeDragStart}
			{onNodeDragOver}
			{onNodeDragLeave}
			{onNodeDrop}
			{onNodeDragEnd}
			{dropTargetPath}
			{busyPaths}
		/>
	{/each}
{/if}

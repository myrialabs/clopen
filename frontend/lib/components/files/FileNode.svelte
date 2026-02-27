<script lang="ts">
	import type { FileNode as FileNodeType } from '$shared/types/filesystem';
	import FileNode from './FileNode.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import { getFolderIcon } from '$frontend/lib/utils/folder-icon-mappings';
	import { onMount } from 'svelte';

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
		activeFilePath = null
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
	} = $props();

	// Determine if this node is the active file
	const isActiveFile = $derived(
		activeFilePath ? file.path === activeFilePath : isSelected
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

	let nodeElement: HTMLDivElement;
	let menuButtonElement: HTMLButtonElement;
	let showAbove = $state(false);

	// Context menu positioning
	let menuOpenedViaContextMenu = $state(false);
	let contextMenuX = $state(0);
	let contextMenuY = $state(0);

	function checkMenuPosition() {
		if (!menuButtonElement) return;

		const rect = menuButtonElement.getBoundingClientRect();
		const dockContainer = nodeElement?.closest('.overflow-auto');

		if (!dockContainer) {
			// Fallback ke viewport jika tidak ada container
			const viewportHeight = window.innerHeight;
			const menuHeight = 100;
			showAbove = rect.bottom + menuHeight > viewportHeight && rect.top > menuHeight;
			return;
		}

		const dockRect = dockContainer.getBoundingClientRect();
		const menuHeight = 100; // Estimasi tinggi menu dropdown

		// Hitung ruang yang tersedia di bawah dan di atas dalam dock container
		const spaceBelow = dockRect.bottom - rect.bottom;
		const spaceAbove = rect.top - dockRect.top;

		// Jika tidak cukup ruang di bawah untuk menu dan ada cukup ruang di atas, tampilkan di atas
		showAbove = spaceBelow < menuHeight && spaceAbove > menuHeight;
	}

	function toggleMenu(event: Event) {
		event.stopPropagation();
		if (!isMenuOpen) {
			checkMenuPosition();
			menuOpenedViaContextMenu = false; // Opened via button click
		}
		onMenuToggle?.(file.path);
	}

	function closeMenu() {
		onMenuToggle?.(file.path); // Toggle to close
		menuOpenedViaContextMenu = false;
	}

	function getDisplayIcon(fileName: string, isDirectory: boolean): IconName {
		if (isDirectory) {
			return getFolderIcon(fileName, isExpanded);
		}
		
		return getFileIcon(fileName);
	}

	function handleClick() {
		if (file.type === 'directory') {
			onToggle?.(file.path);
		} else {
			onSelect?.(file);
		}
	}

	function handleContextMenu(event: MouseEvent) {
		event.preventDefault();
		if (!isMenuOpen) {
			// Save mouse position for context menu positioning
			contextMenuX = event.clientX;
			contextMenuY = event.clientY;
			menuOpenedViaContextMenu = true;
			// Check position based on mouse Y relative to dock container
			checkContextMenuPosition(event.clientY);
		}
		onMenuToggle?.(file.path);
	}

	function checkContextMenuPosition(mouseY: number) {
		const dockContainer = nodeElement?.closest('.overflow-auto');
		const menuHeight = 100;

		if (!dockContainer) {
			const viewportHeight = window.innerHeight;
			showAbove = mouseY + menuHeight > viewportHeight && mouseY > menuHeight;
			return;
		}

		const dockRect = dockContainer.getBoundingClientRect();
		const spaceBelow = dockRect.bottom - mouseY;
		const spaceAbove = mouseY - dockRect.top;
		showAbove = spaceBelow < menuHeight && spaceAbove > menuHeight;
	}

	function handleAction(action: string, event: Event) {
		event.stopPropagation();
		onAction?.(action, file);
	}

	function formatFileSize(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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
	class="{isActiveFile ? '!bg-violet-100 dark:!bg-violet-900/50' : ''} group relative flex items-center space-x-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors hover:bg-slate-100/50 dark:hover:bg-slate-800/50"
	class:selected={isActiveFile}
	class:directory={file.type === 'directory'}
	title={file.name}
	style="padding-left: {(depth * 12 + 6) / 16}rem"
	onclick={handleClick}
	oncontextmenu={handleContextMenu}
	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleClick();
		}
	}}
	role="button"
	tabindex="0"
	aria-label="{file.type === 'directory' ? 'Folder' : 'File'}: {file.name}"
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

	<!-- File/folder icon -->
	<span class="flex-shrink-0">
		<Icon name={getDisplayIcon(file.name, file.type === 'directory')} />
	</span>

	<!-- File/folder name -->
	<span class="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300 truncate min-w-0">
		{file.name}
		{#if showModifiedIndicator}
			<span class="inline-flex w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-600 ml-1"></span>
		{/if}
	</span>

	<!-- File metadata -->
	{#if file.type === 'file'}
		<span class="flex-shrink-0 text-xs text-slate-400 dark:text-slate-500 lg:group-hover:hidden">
			{formatFileSize(file.size || 0)}
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
				class="{menuOpenedViaContextMenu ? 'fixed' : 'absolute right-0'} {showAbove && !menuOpenedViaContextMenu ? 'bottom-full -mb-5' : !menuOpenedViaContextMenu ? 'top-full -mt-5' : ''} bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg py-1 w-44 max-h-80 overflow-y-auto z-50 shadow-lg"
				style={menuOpenedViaContextMenu ? `left: ${contextMenuX}px; ${showAbove ? `bottom: ${window.innerHeight - contextMenuY}px;` : `top: ${contextMenuY}px;`}` : ''}
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
		/>
	{/each}
{/if}
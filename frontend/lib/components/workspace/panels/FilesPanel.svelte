<script module lang="ts">
	// Persistent state that survives component destruction (mobile/desktop switch)
	const projectFileStates = new Map<string, any>();
</script>

<script lang="ts">
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import FileTree from '$frontend/lib/components/files/FileTree.svelte';
	import FileViewer from '$frontend/lib/components/files/FileViewer.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import Alert from '$frontend/lib/components/common/Alert.svelte';
	import Dialog from '$frontend/lib/components/common/Dialog.svelte';
	import type { FileNode } from '$shared/types/filesystem';
	import { debug } from '$shared/utils/logger';
	import { onMount, onDestroy } from 'svelte';
	import ws from '$frontend/lib/utils/ws';
	import { showConfirm } from '$frontend/lib/stores/ui/dialog.svelte';
	import { getFileIcon } from '$frontend/lib/utils/file-icon-mappings';
	import type { IconName } from '$shared/types/ui/icons';

	// Props
	interface Props {
		showMobileHeader?: boolean;
	}

	const { showMobileHeader = false }: Props = $props();

	// State
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectPath = $derived(projectState.currentProject?.path || '');
	const projectId = $derived(projectState.currentProject?.id || '');

	// File watcher state
	let isWatching = $state(false);
	let watchDebounceTimer = $state<ReturnType<typeof setTimeout> | null>(null);

	let projectFiles = $state<FileNode[]>([]);
	let isLoading = $state(false);
	let isInitialLoad = $state(true);
	let error = $state('');
	let expandedFolders = $state(new Set<string>());
	let viewMode = $state<'tree' | 'viewer'>('tree');

	// ============================
	// Tab System
	// ============================
	interface EditorTab {
		file: FileNode;
		currentContent: string;
		savedContent: string;
		isLoading: boolean;
		externallyChanged?: boolean;
	}

	let openTabs = $state<EditorTab[]>([]);
	let activeTabPath = $state<string | null>(null);
	let wordWrapEnabled = $state(false);

	const activeTab = $derived(openTabs.find(t => t.file.path === activeTabPath) || null);
	const modifiedFilePaths = $derived(new Set(
		openTabs.filter(t => t.currentContent !== t.savedContent).map(t => t.file.path)
	));

	// Display content for FileViewer (only updated on tab switch/load, not on every keystroke)
	let displayContent = $state('');
	let displaySavedContent = $state('');
	let displayFile = $state<FileNode | null>(null);
	let displayLoading = $state(false);
	let displayTargetLine = $state<number | undefined>(undefined);
	let displayExternallyChanged = $state(false);

	// Sync display state when active tab changes
	$effect(() => {
		if (activeTab) {
			displayFile = activeTab.file;
			displayContent = activeTab.currentContent;
			displaySavedContent = activeTab.savedContent;
			displayLoading = activeTab.isLoading;
			displayExternallyChanged = activeTab.externallyChanged || false;
		} else {
			displayFile = null;
			displayContent = '';
			displaySavedContent = '';
			displayLoading = false;
			displayExternallyChanged = false;
		}
	});

	// Dialog state (replaces manual modals)
	let dialogOpen = $state(false);
	let dialogType = $state<'rename' | 'new-file' | 'new-folder'>('rename');
	let dialogValue = $state('');
	let dialogTargetFile = $state<FileNode | null>(null);
	let dialogParentPath = $state<string | null>(null);

	const dialogConfig = $derived.by(() => {
		switch (dialogType) {
			case 'rename':
				return {
					title: `Rename ${dialogTargetFile?.type === 'directory' ? 'Folder' : 'File'}`,
					message: 'Enter the new name:',
					placeholder: dialogTargetFile?.name || '',
					confirmText: 'Rename'
				};
			case 'new-file':
				return {
					title: 'Create New File',
					message: 'Enter the name for the new file:',
					placeholder: 'filename.txt',
					confirmText: 'Create'
				};
			case 'new-folder':
				return {
					title: 'Create New Folder',
					message: 'Enter the name for the new folder:',
					placeholder: 'folder-name',
					confirmText: 'Create'
				};
			default:
				return {
					title: 'Input',
					message: 'Enter value:',
					placeholder: '',
					confirmText: 'OK'
				};
		}
	});

	// Alert state
	let showAlert = $state(false);
	let alertMessage = $state('');
	let alertTitle = $state('Error');
	let alertType = $state<'info' | 'success' | 'warning' | 'error'>('error');

	// projectFileStates is at module level to survive component destruction (mobile/desktop switch)
	let lastProjectPath = $state<string>('');

	// Container width detection for 2-column layout
	let containerRef = $state<HTMLDivElement | null>(null);
	let containerWidth = $state(0);
	const TWO_COLUMN_THRESHOLD = 800;

	// FileTree ref
	let fileTreeRef = $state<any>(null);
	const isTwoColumnMode = $derived(containerWidth >= TWO_COLUMN_THRESHOLD);

	// Tree state preservation
	let treeScrollContainer = $state<HTMLElement | null>(null);
	let savedScrollPosition = 0;

	// Cache key for sessionStorage
	const getCacheKey = (path: string) => `files_cache_${path}`;

	function saveFilesToCache(path: string, files: FileNode[]) {
		try {
			const cacheData = { files, timestamp: Date.now() };
			sessionStorage.setItem(getCacheKey(path), JSON.stringify(cacheData));
		} catch (err) {
			debug.error('file', 'Failed to save files cache:', err);
		}
	}

	function loadFilesFromCache(path: string): FileNode[] | null {
		try {
			const cached = sessionStorage.getItem(getCacheKey(path));
			if (!cached) return null;
			const cacheData = JSON.parse(cached);
			if (Date.now() - cacheData.timestamp > 3600000) {
				sessionStorage.removeItem(getCacheKey(path));
				return null;
			}
			const convertDates = (file: any): FileNode => ({
				...file,
				modified: new Date(file.modified),
				children: file.children?.map(convertDates)
			});
			return cacheData.files.map(convertDates);
		} catch (err) {
			debug.error('file', 'Failed to load files cache:', err);
			return null;
		}
	}

	// ============================
	// File Loading
	// ============================

	async function loadProjectFiles(preserveState = false) {
		if (!hasActiveProject) {
			projectFiles = [];
			return;
		}

		if (isInitialLoad && !preserveState) {
			const cachedFiles = loadFilesFromCache(projectPath);
			if (cachedFiles) {
				projectFiles = cachedFiles;
				debug.log('file', 'Loaded files from cache, fetching fresh data...');
				isLoading = false;
			} else {
				isLoading = true;
			}
		} else {
			if (!preserveState) {
				isLoading = true;
			}
		}

		let savedExpandedFolders: Set<string> | null = null;
		if (preserveState) {
			savedExpandedFolders = new Set(expandedFolders);
			if (treeScrollContainer) {
				savedScrollPosition = treeScrollContainer.scrollTop;
			}
		}

		error = '';

		try {
			const requestData: any = { project_path: projectPath };
			if (preserveState && savedExpandedFolders && savedExpandedFolders.size > 0) {
				requestData.expanded = Array.from(savedExpandedFolders).join(',');
			}

			const data = await ws.http('files:list-tree', requestData);

			const convertToFileNode = (apiFile: unknown): FileNode => {
				if (typeof apiFile !== 'object' || apiFile === null) {
					throw new Error('Invalid file object');
				}
				const file = apiFile as Record<string, unknown>;
				return {
					name: String(file.name || ''),
					path: String(file.path || ''),
					type: file.type === 'directory' ? 'directory' : 'file',
					size: typeof file.size === 'number' ? file.size : 0,
					modified: file.modified ? new Date(String(file.modified)) : new Date(),
					children: Array.isArray(file.children) ? file.children.map(convertToFileNode) : undefined
				};
			};

			const rootFile = convertToFileNode(data);
			projectFiles = rootFile.type === 'directory' && rootFile.children ? rootFile.children : [rootFile];

			saveFilesToCache(projectPath, projectFiles);

			if (isInitialLoad) {
				isInitialLoad = false;
			}

			if (preserveState && savedExpandedFolders) {
				expandedFolders = savedExpandedFolders;
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (treeScrollContainer) {
							treeScrollContainer.scrollTop = savedScrollPosition;
						}
					});
				});
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load files';
			projectFiles = [];
		} finally {
			isLoading = false;
		}
	}

	async function loadDirectoryContents(dirPath: string): Promise<FileNode[]> {
		try {
			const data = await ws.http('files:list-directory', { dir_path: dirPath });
			if (Array.isArray(data)) {
				return data.map((item: any) => ({
					...item,
					modified: new Date(item.modified)
				}));
			}
			return [];
		} catch (error) {
			return [];
		}
	}

	function updateFileTreeChildren(files: FileNode[], targetPath: string, newChildren: FileNode[]): FileNode[] {
		return files.map((file) => {
			if (file.path === targetPath) return { ...file, children: newChildren };
			if (file.type === 'directory' && file.children) {
				return { ...file, children: updateFileTreeChildren(file.children, targetPath, newChildren) };
			}
			return file;
		});
	}

	function findFileInTree(files: FileNode[], targetPath: string): FileNode | null {
		for (const file of files) {
			if (file.path === targetPath) return file;
			if (file.type === 'directory' && file.children) {
				const found = findFileInTree(file.children, targetPath);
				if (found) return found;
			}
		}
		return null;
	}

	// ============================
	// Tab Operations
	// ============================

	function openFileInTab(file: FileNode, targetLine?: number) {
		if (file.type === 'directory') return;

		// Check if tab already exists
		const existingTab = openTabs.find(t => t.file.path === file.path);
		if (existingTab) {
			activeTabPath = file.path;
			displayTargetLine = targetLine;
			if (!isTwoColumnMode) viewMode = 'viewer';
			return;
		}

		// Create new tab
		const newTab: EditorTab = {
			file,
			currentContent: '',
			savedContent: '',
			isLoading: true
		};
		openTabs = [...openTabs, newTab];
		activeTabPath = file.path;
		displayTargetLine = targetLine;
		if (!isTwoColumnMode) viewMode = 'viewer';

		// Load content
		loadTabContent(file.path);
	}

	async function loadTabContent(filePath: string): Promise<boolean> {
		try {
			const data = await ws.http('files:read-file', { file_path: filePath });
			const content = data.content || '';
			openTabs = openTabs.map(t =>
				t.file.path === filePath
					? { ...t, currentContent: content, savedContent: content, isLoading: false }
					: t
			);
			// Update display if this is the active tab
			if (filePath === activeTabPath) {
				displayContent = content;
				displaySavedContent = content;
				displayLoading = false;
			}
			return true;
		} catch (err) {
			openTabs = openTabs.map(t =>
				t.file.path === filePath
					? { ...t, isLoading: false }
					: t
			);
			if (filePath === activeTabPath) {
				displayLoading = false;
			}
			return false;
		}
	}

	function selectTab(path: string) {
		activeTabPath = path;
		displayTargetLine = undefined;

		// Directly sync display state for immediate editor update
		const tab = openTabs.find(t => t.file.path === path);
		if (tab) {
			displayFile = tab.file;
			displayContent = tab.currentContent;
			displaySavedContent = tab.savedContent;
			displayLoading = tab.isLoading;
		}
	}

	// Scroll to active file in tree (without auto-expanding parent folders)
	function scrollToActiveFile(filePath: string) {
		if (!filePath || !projectPath) return;

		// Auto-scroll to the selected file in the tree after DOM update (only if visible)
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const selectedEl = treeScrollContainer?.querySelector('.selected');
				if (selectedEl && treeScrollContainer) {
					const containerRect = treeScrollContainer.getBoundingClientRect();
					const elRect = selectedEl.getBoundingClientRect();
					const padding = 40;

					if (elRect.top < containerRect.top + padding) {
						treeScrollContainer.scrollTop -= (containerRect.top + padding - elRect.top);
					} else if (elRect.bottom > containerRect.bottom - padding) {
						treeScrollContainer.scrollTop += (elRect.bottom - containerRect.bottom + padding);
					}
				}
			});
		});
	}

	function closeTab(path: string) {
		const idx = openTabs.findIndex(t => t.file.path === path);
		if (idx === -1) return;

		openTabs = openTabs.filter(t => t.file.path !== path);

		if (activeTabPath === path) {
			if (openTabs.length > 0) {
				// Activate the nearest tab
				const newIdx = Math.min(idx, openTabs.length - 1);
				activeTabPath = openTabs[newIdx].file.path;
			} else {
				activeTabPath = null;
				if (!isTwoColumnMode) viewMode = 'tree';
			}
		}
	}

	function handleEditorContentChange(newContent: string) {
		if (!activeTabPath) return;
		openTabs = openTabs.map(t =>
			t.file.path === activeTabPath
				? { ...t, currentContent: newContent }
				: t
		);
	}

	// ============================
	// Tree Manipulation Helpers (Optimistic UI)
	// ============================

	function updateNodePathInTree(files: FileNode[], oldPath: string, newPath: string): FileNode[] {
		return files.map((file) => {
			if (file.path === oldPath) {
				const newName = newPath.split(/[\\/]/).pop() || file.name;
				return { ...file, path: newPath, name: newName };
			} else if (file.type === 'directory' && file.children) {
				return { ...file, children: updateNodePathInTree(file.children, oldPath, newPath) };
			}
			return file;
		});
	}

	function removeNodeFromTree(files: FileNode[], targetPath: string): FileNode[] {
		return files
			.filter((file) => file.path !== targetPath)
			.map((file) => {
				if (file.type === 'directory' && file.children) {
					return { ...file, children: removeNodeFromTree(file.children, targetPath) };
				}
				return file;
			});
	}

	function addNodeToTree(files: FileNode[], parentPath: string | null, newNode: FileNode): FileNode[] {
		if (!parentPath) {
			return sortFileNodes([...files, newNode]);
		}
		return files.map((file) => {
			if (file.path === parentPath && file.type === 'directory') {
				return { ...file, children: sortFileNodes([...(file.children || []), newNode]) };
			} else if (file.type === 'directory' && file.children) {
				return { ...file, children: addNodeToTree(file.children, parentPath, newNode) };
			}
			return file;
		});
	}

	function duplicateNodeInTree(files: FileNode[], sourcePath: string, targetPath: string): FileNode[] {
		const sourceNode = findFileInTree(files, sourcePath);
		if (!sourceNode) return files;
		const newName = targetPath.split(/[\\/]/).pop() || sourceNode.name;
		const duplicateNode: FileNode = { ...sourceNode, path: targetPath, name: newName };
		const pathParts = targetPath.split(/[\\/]/);
		pathParts.pop();
		const parentPath = pathParts.length > 0 ? pathParts.join(targetPath.includes('\\') ? '\\' : '/') : null;
		return addNodeToTree(files, parentPath, duplicateNode);
	}

	function moveNodeInTree(files: FileNode[], sourcePath: string, targetPath: string): FileNode[] {
		const sourceNode = findFileInTree(files, sourcePath);
		if (!sourceNode) return files;
		const newTree = removeNodeFromTree(files, sourcePath);
		const newName = targetPath.split(/[\\/]/).pop() || sourceNode.name;
		const movedNode: FileNode = { ...sourceNode, path: targetPath, name: newName };
		const pathParts = targetPath.split(/[\\/]/);
		pathParts.pop();
		const parentPath = pathParts.length > 0 ? pathParts.join(targetPath.includes('\\') ? '\\' : '/') : null;
		return addNodeToTree(newTree, parentPath, movedNode);
	}

	function sortFileNodes(nodes: FileNode[]): FileNode[] {
		return nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	function generateUniqueFilename(basePath: string, filename: string): string {
		const separator = basePath.includes('\\') ? '\\' : '/';
		let targetPath = `${basePath}${separator}${filename}`;
		const existingFile = findFileInTree(projectFiles, targetPath);
		if (!existingFile) return targetPath;
		const lastDotIndex = filename.lastIndexOf('.');
		const name = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;
		const extension = lastDotIndex > 0 ? filename.substring(lastDotIndex) : '';
		let counter = 1;
		while (true) {
			const numberedFilename = `${name} (${counter})${extension}`;
			targetPath = `${basePath}${separator}${numberedFilename}`;
			if (!findFileInTree(projectFiles, targetPath)) return targetPath;
			counter++;
		}
	}

	// ============================
	// Alert/Dialog Helpers
	// ============================

	function showErrorAlert(message: string, title = 'Error') {
		alertType = 'error';
		alertTitle = title;
		alertMessage = message;
		showAlert = true;
	}

	function openDialog(type: 'rename' | 'new-file' | 'new-folder', file?: FileNode, parentPath?: string | null) {
		dialogType = type;
		dialogTargetFile = file || null;
		dialogParentPath = parentPath ?? null;
		dialogValue = type === 'rename' ? (file?.name || '') : '';
		dialogOpen = true;
	}

	function closeDialog() {
		dialogOpen = false;
		dialogValue = '';
		dialogTargetFile = null;
		dialogParentPath = null;
	}

	async function handleDialogConfirm(value?: string) {
		const trimmedValue = (value || dialogValue || '').trim();
		if (!trimmedValue) {
			closeDialog();
			return;
		}

		switch (dialogType) {
			case 'rename':
				await performRename(trimmedValue);
				break;
			case 'new-file':
				await performCreateNew('file', trimmedValue);
				break;
			case 'new-folder':
				await performCreateNew('folder', trimmedValue);
				break;
		}
		closeDialog();
	}

	async function performRename(newName: string) {
		const file = dialogTargetFile;
		if (!file || newName === file.name) return;

		try {
			const pathParts = file.path.split(/[\\/]/);
			pathParts[pathParts.length - 1] = newName;
			const newPath = pathParts.join(file.path.includes('\\') ? '\\' : '/');
			const oldPath = file.path;

			const existingFile = findFileInTree(projectFiles, newPath);
			if (existingFile) {
				showErrorAlert('A file or folder with this name already exists.', 'Rename Failed');
				return;
			}

			// Optimistic UI
			projectFiles = updateNodePathInTree(projectFiles, oldPath, newPath);

			// Update tab if open
			openTabs = openTabs.map(t => {
				if (t.file.path === oldPath) {
					return { ...t, file: { ...t.file, path: newPath, name: newName } };
				}
				return t;
			});
			if (activeTabPath === oldPath) {
				activeTabPath = newPath;
			}

			await ws.http('files:rename', { oldPath, newPath });
		} catch (error) {
			debug.error('file', 'Failed to rename file:', error);
			showErrorAlert(error instanceof Error ? error.message : 'Unknown error', 'Rename Failed');
		}
	}

	async function performCreateNew(type: 'file' | 'folder', name: string) {
		try {
			const parentPath = dialogParentPath;
			const separator = (parentPath || projectPath).includes('\\') ? '\\' : '/';
			const fullPath = parentPath
				? `${parentPath}${separator}${name}`
				: `${projectPath}${separator}${name}`;

			const newNode: FileNode = {
				name,
				path: fullPath,
				type: type === 'folder' ? 'directory' : 'file',
				size: 0,
				modified: new Date(),
				children: type === 'folder' ? [] : undefined
			};

			// Optimistic UI
			projectFiles = addNodeToTree(projectFiles, parentPath, newNode);

			if (parentPath && !expandedFolders.has(parentPath)) {
				expandedFolders.add(parentPath);
				expandedFolders = new Set(expandedFolders);
			}

			if (type === 'file') {
				await ws.http('files:create-file', { filePath: fullPath, content: '' });
			} else {
				await ws.http('files:create-directory', { dirPath: fullPath });
			}
		} catch (error) {
			debug.error('file', 'Failed to create new item:', error);
			showErrorAlert(error instanceof Error ? error.message : 'Unknown error', 'Create Failed');
		}
	}

	// ============================
	// Clipboard
	// ============================

	let clipboard = $state<{ file: FileNode; operation: 'copy' | 'cut' } | null>(null);

	async function pasteFile(targetFolder: FileNode) {
		if (!clipboard) return;
		try {
			const { file: sourceFile, operation } = clipboard;
			let basePath: string;
			if (targetFolder.type === 'directory') {
				basePath = targetFolder.path;
			} else {
				const pathParts = targetFolder.path.split(/[\\/]/);
				pathParts.pop();
				basePath = pathParts.join(targetFolder.path.includes('\\') ? '\\' : '/');
			}
			const targetPath = generateUniqueFilename(basePath, sourceFile.name);

			if (operation === 'copy') {
				projectFiles = duplicateNodeInTree(projectFiles, sourceFile.path, targetPath);
				if (targetFolder.type === 'directory' && !expandedFolders.has(targetFolder.path)) {
					expandedFolders.add(targetFolder.path);
					expandedFolders = new Set(expandedFolders);
				}
				await ws.http('files:duplicate', { sourcePath: sourceFile.path, targetPath });
			} else if (operation === 'cut') {
				projectFiles = moveNodeInTree(projectFiles, sourceFile.path, targetPath);
				if (targetFolder.type === 'directory' && !expandedFolders.has(targetFolder.path)) {
					expandedFolders.add(targetFolder.path);
					expandedFolders = new Set(expandedFolders);
				}
				const savedClipboard = clipboard;
				clipboard = null;
				try {
					await ws.http('files:rename', { oldPath: sourceFile.path, newPath: targetPath });
				} catch (err) {
					projectFiles = moveNodeInTree(projectFiles, targetPath, sourceFile.path);
					clipboard = savedClipboard;
					throw err;
				}
			}
		} catch (error) {
			debug.error('file', 'Failed to paste file:', error);
			showErrorAlert(error instanceof Error ? error.message : 'Unknown error', 'Paste Failed');
		}
	}

	async function pasteToRoot() {
		if (!clipboard || !projectPath) return;
		try {
			const { file: sourceFile, operation } = clipboard;
			const targetPath = generateUniqueFilename(projectPath, sourceFile.name);

			if (operation === 'copy') {
				projectFiles = duplicateNodeInTree(projectFiles, sourceFile.path, targetPath);
				await ws.http('files:duplicate', { sourcePath: sourceFile.path, targetPath });
			} else if (operation === 'cut') {
				projectFiles = moveNodeInTree(projectFiles, sourceFile.path, targetPath);
				const savedClipboard = clipboard;
				clipboard = null;
				try {
					await ws.http('files:rename', { oldPath: sourceFile.path, newPath: targetPath });
				} catch (err) {
					projectFiles = moveNodeInTree(projectFiles, targetPath, sourceFile.path);
					clipboard = savedClipboard;
					throw err;
				}
			}
		} catch (error) {
			debug.error('file', 'Failed to paste to root:', error);
			showErrorAlert(error instanceof Error ? error.message : 'Unknown error', 'Paste Failed');
		}
	}

	// ============================
	// File Actions
	// ============================

	async function handleFolderToggle(folderPath: string) {
		if (expandedFolders.has(folderPath)) {
			expandedFolders.delete(folderPath);
		} else {
			expandedFolders.add(folderPath);
			const folder = findFileInTree(projectFiles, folderPath);
			if (folder && folder.type === 'directory' && (!folder.children || folder.children.length === 0)) {
				const children = await loadDirectoryContents(folderPath);
				projectFiles = updateFileTreeChildren(projectFiles, folderPath, children);
			}
		}
		expandedFolders = new Set(expandedFolders);
	}

	function handleFileSelect(file: FileNode) {
		if (file.type === 'file') {
			openFileInTab(file);
		}
	}

	async function handleFileOpen(filePath: string, lineNumber?: number) {
		let file = findFileInTree(projectFiles, filePath);
		if (!file) {
			const fileName = filePath.split(/[/\\]/).pop() || 'Untitled';
			file = { name: fileName, path: filePath, type: 'file', size: 0, modified: new Date() };
		}
		openFileInTab(file, lineNumber);
	}

	async function handleFileAction(action: string, file: FileNode) {
		switch (action) {
			case 'copy-path':
				navigator.clipboard.writeText(file.path);
				break;
			case 'copy-relative-path': {
				let relativePath = file.path;
				if (projectPath && file.path.startsWith(projectPath)) {
					relativePath = file.path.substring(projectPath.length);
					if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
						relativePath = relativePath.substring(1);
					}
				}
				navigator.clipboard.writeText(relativePath);
				break;
			}
			case 'rename':
				openDialog('rename', file);
				break;
			case 'copy':
				clipboard = { file, operation: 'copy' };
				break;
			case 'cut':
				clipboard = { file, operation: 'cut' };
				break;
			case 'paste':
				if (clipboard) await pasteFile(file);
				break;
			case 'new-file':
				openDialog('new-file', undefined, file.type === 'directory' ? file.path : null);
				break;
			case 'new-folder':
				openDialog('new-folder', undefined, file.type === 'directory' ? file.path : null);
				break;
			case 'duplicate':
				await duplicateFile(file);
				break;
			case 'delete':
				await deleteFile(file);
				break;
			case 'refresh':
				await refreshAll();
				break;
		}
	}

	async function deleteFile(file: FileNode) {
		const confirmMessage = file.type === 'directory'
			? `Are you sure you want to delete the folder "${file.name}" and all its contents?`
			: `Are you sure you want to delete "${file.name}"?`;

		const confirmed = await showConfirm({
			title: file.type === 'directory' ? 'Delete Folder' : 'Delete File',
			message: confirmMessage,
			type: 'error',
			confirmText: 'Delete',
			cancelText: 'Cancel'
		});
		if (!confirmed) return;

		try {
			const deletedNode = findFileInTree(projectFiles, file.path);
			projectFiles = removeNodeFromTree(projectFiles, file.path);

			// Close tab if open
			closeTab(file.path);

			try {
				await ws.http('files:delete', { filePath: file.path, force: file.type === 'directory' });
			} catch (err) {
				if (deletedNode) {
					const pathParts = file.path.split(/[\\/]/);
					pathParts.pop();
					const parentPath = pathParts.length > 0 ? pathParts.join(file.path.includes('\\') ? '\\' : '/') : null;
					projectFiles = addNodeToTree(projectFiles, parentPath, deletedNode);
				}
				throw err;
			}
		} catch (error) {
			debug.error('file', 'Failed to delete file:', error);
			showErrorAlert(error instanceof Error ? error.message : 'Unknown error', 'Delete Failed');
		}
	}

	async function duplicateFile(file: FileNode) {
		try {
			const pathParts = file.path.split(/[\\/]/);
			const fileName = pathParts.pop() || file.name;
			const parentPath = pathParts.join(file.path.includes('\\') ? '\\' : '/');
			const targetPath = generateUniqueFilename(parentPath, fileName);

			// Optimistic UI
			projectFiles = duplicateNodeInTree(projectFiles, file.path, targetPath);

			await ws.http('files:duplicate', { sourcePath: file.path, targetPath });
		} catch (error) {
			debug.error('file', 'Failed to duplicate file:', error);
			showErrorAlert(error instanceof Error ? error.message : 'Unknown error', 'Duplicate Failed');
			// Reload to revert optimistic update
			await loadProjectFiles(true);
		}
	}

	function createNewFileInRoot() {
		openDialog('new-file', undefined, null);
	}

	function createNewFolderInRoot() {
		openDialog('new-folder', undefined, null);
	}

	// Save file
	async function saveFile(filePath: string, content: string) {
		await ws.http('files:write-file', { filePath, content });
		// Update tab's savedContent and clear external change flag
		openTabs = openTabs.map(t =>
			t.file.path === filePath
				? { ...t, savedContent: content, externallyChanged: false }
				: t
		);
		// Update display if active tab
		if (filePath === activeTabPath) {
			displaySavedContent = content;
			displayExternallyChanged = false;
		}
	}

	// Force reload active tab from server (discard local changes)
	async function forceReloadTab() {
		if (!activeTabPath) return;
		const success = await loadTabContent(activeTabPath);
		if (success) {
			openTabs = openTabs.map(t =>
				t.file.path === activeTabPath
					? { ...t, externallyChanged: false }
					: t
			);
			displayExternallyChanged = false;
		}
	}

	// Refresh all
	async function refreshAll(preserveState = false) {
		await loadProjectFiles(preserveState);
	}

	// ============================
	// Effects
	// ============================

	// Load files when project changes
	$effect(() => {
		if (hasActiveProject) {
			// Save current project state before switching
			if (lastProjectPath && lastProjectPath !== projectPath) {
				projectFileStates.set(lastProjectPath, {
					openTabs: [...openTabs],
					activeTabPath,
					expandedFolders: new Set(expandedFolders),
					viewMode
				});
			}

			if (lastProjectPath !== projectPath) {
				isInitialLoad = true;
			}

			loadProjectFiles();

			// Restore previous state for this project
			if (projectPath) {
				const savedState = projectFileStates.get(projectPath);
				if (savedState) {
					openTabs = savedState.openTabs;
					activeTabPath = savedState.activeTabPath;
					expandedFolders = savedState.expandedFolders;
					viewMode = savedState.viewMode;
				} else {
					openTabs = [];
					activeTabPath = null;
					viewMode = 'tree';
				}
				lastProjectPath = projectPath;
			}
		} else {
			openTabs = [];
			activeTabPath = null;
			viewMode = 'tree';
			lastProjectPath = '';
			isInitialLoad = true;
		}
	});

	// Start/stop file watcher when project changes
	$effect(() => {
		if (hasActiveProject && projectId && projectPath) {
			ws.emit('files:watch', { projectPath });
			debug.log('file', `Started watching project: ${projectId}`);

			return () => {
				ws.emit('files:unwatch', {});
				isWatching = false;
				debug.log('file', `Stopped watching project: ${projectId}`);
			};
		}
	});

	// Listen for file change events
	$effect(() => {
		if (!hasActiveProject || !projectId) return;

		// Accumulate changes across multiple events within the debounce window
		let accumulatedChanges: Array<{ path: string; type: 'created' | 'modified' | 'deleted'; timestamp: string }> = [];

		const unsubChanges = ws.on('files:changed', (payload) => {
			if (payload.projectId !== projectId) return;

			// Accumulate changes from all events before debounce fires
			accumulatedChanges.push(...payload.changes);

			if (watchDebounceTimer) clearTimeout(watchDebounceTimer);

			watchDebounceTimer = setTimeout(async () => {
				const changes = [...accumulatedChanges];
				accumulatedChanges = [];

				// Reload file tree
				await loadProjectFiles(true);

				// Refresh all open tabs after tree reload
				const tabsSnapshot = [...openTabs];
				for (const tab of tabsSnapshot) {
					const hasUnsavedChanges = tab.currentContent !== tab.savedContent;

					if (hasUnsavedChanges) {
						// Tab has unsaved changes — check if file changed externally
						try {
							const data = await ws.http('files:read-file', { file_path: tab.file.path });
							const serverContent = data.content || '';
							if (serverContent !== tab.savedContent) {
								openTabs = openTabs.map(t =>
									t.file.path === tab.file.path
										? { ...t, externallyChanged: true }
										: t
								);
								if (tab.file.path === activeTabPath) {
									displayExternallyChanged = true;
								}
							}
						} catch {
							// File deleted/renamed while user has unsaved changes — keep tab open
						}
						continue;
					}

					// Tab has no unsaved changes — auto-sync
					const success = await loadTabContent(tab.file.path);
					if (!success) {
						// File no longer exists — try to detect rename
						const tabDir = tab.file.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');

						// Find a 'created' change in the same parent directory
						const renameTarget = changes.find(c => {
							if (c.type !== 'created') return false;
							const cDir = c.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
							return cDir === tabDir;
						});

						if (renameTarget) {
							const newPath = renameTarget.path;
							const newName = newPath.split(/[\\/]/).pop() || tab.file.name;
							const oldPath = tab.file.path;

							// Update tab path and name
							openTabs = openTabs.map(t =>
								t.file.path === oldPath
									? { ...t, file: { ...t.file, path: newPath, name: newName } }
									: t
							);
							if (activeTabPath === oldPath) {
								activeTabPath = newPath;
							}

							// Load content from new path
							await loadTabContent(newPath);
						} else {
							// No rename target found — file was truly deleted
							closeTab(tab.file.path);
						}
					}
				}

				watchDebounceTimer = null;
			}, 500);
		});

		const unsubWatching = ws.on('files:watching', (payload) => {
			if (payload.projectId !== projectId) return;
			isWatching = payload.watching;
		});

		const unsubError = ws.on('files:watch-error', (payload) => {
			if (payload.projectId !== projectId) return;
			debug.error('file', `Watch error: ${payload.error}`);
		});

		return () => {
			unsubChanges();
			unsubWatching();
			unsubError();
			if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
		};
	});

	// Scroll to active file in tree when active tab changes
	$effect(() => {
		if (activeTabPath) {
			scrollToActiveFile(activeTabPath);
		}
	});

	// Sync view state when switching between 1-column and 2-column modes
	let prevTwoColumnMode = $state<boolean | null>(null);
	$effect(() => {
		if (prevTwoColumnMode !== null && prevTwoColumnMode !== isTwoColumnMode) {
			if (!isTwoColumnMode) {
				// Switching from 2-column to 1-column:
				// If there's an active tab, show the viewer; otherwise show tree
				if (activeTabPath && openTabs.length > 0) {
					viewMode = 'viewer';
				} else {
					viewMode = 'tree';
				}
			}
			// Switching from 1-column to 2-column: both are shown, no action needed
		}
		prevTwoColumnMode = isTwoColumnMode;
	});

	// Save state to persistent storage on component destruction (mobile/desktop switch)
	onDestroy(() => {
		if (projectPath) {
			// When in 2-column mode, compute correct viewMode for 1-column restoration
			let savedViewMode = viewMode;
			if (isTwoColumnMode) {
				savedViewMode = (activeTabPath && openTabs.length > 0) ? 'viewer' : 'tree';
			}
			projectFileStates.set(projectPath, {
				openTabs: [...openTabs],
				activeTabPath,
				expandedFolders: new Set(expandedFolders),
				viewMode: savedViewMode
			});
		}
	});

	// Monitor container width for responsive layout
	onMount(() => {
		if (containerRef && typeof ResizeObserver !== 'undefined') {
			const resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					containerWidth = entry.contentRect.width;
				}
			});
			resizeObserver.observe(containerRef);
			return () => resizeObserver.disconnect();
		}
	});

	// ============================
	// Panel Actions Export
	// ============================

	export const panelActions = {
		setViewMode: (mode: 'tree' | 'viewer') => {
			if (!isTwoColumnMode) viewMode = mode;
		},
		getViewMode: () => viewMode,
		canShowViewer: () => openTabs.length > 0,
		isTwoColumnMode: () => isTwoColumnMode
	};
</script>

<!-- Tab Bar Snippet -->
{#snippet tabBar()}
	{#if openTabs.length > 0}
		<div class="flex items-center border-b border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 overflow-x-auto flex-shrink-0">
			{#each openTabs as tab (tab.file.path)}
				{@const isActive = tab.file.path === activeTabPath}
				{@const isModified = tab.currentContent !== tab.savedContent}
				<div
					class="flex items-center gap-1.5 px-3 py-2 text-xs border-r border-slate-200/50 dark:border-slate-700/50 whitespace-nowrap transition-colors flex-shrink-0 cursor-pointer {isActive
						? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
						: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300'}"
					onclick={() => selectTab(tab.file.path)}
				>
					<Icon name={getFileIcon(tab.file.name) as IconName} class="w-3.5 h-3.5 flex-shrink-0" />
					<span class="truncate max-w-28">{tab.file.name}</span>
					{#if isModified}
						<span class="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-600 flex-shrink-0"></span>
					{/if}
					<button
						class="flex p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded flex-shrink-0 opacity-60 hover:opacity-100"
						onclick={(e) => { e.stopPropagation(); closeTab(tab.file.path); }}
						title="Close tab"
					>
						<Icon name="lucide:x" class="w-3 h-3" />
					</button>
				</div>
			{/each}
		</div>
	{/if}
{/snippet}

<div class="h-full flex flex-col bg-transparent" bind:this={containerRef}>
	{#if !hasActiveProject}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600 dark:text-slate-500 text-sm">
			<Icon name="lucide:folder" class="w-10 h-10 opacity-30" />
			<span>No project selected</span>
		</div>
	{:else if isLoading && projectFiles.length === 0}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-600 dark:text-slate-500 text-sm">
			<div class="w-6 h-6 border-2 border-slate-200 dark:border-slate-800 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Loading files...</span>
		</div>
	{:else if error}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-red-500 text-sm">
			<Icon name="lucide:circle-x" class="w-8 h-8" />
			<span>{error}</span>
			<button
				onclick={() => loadProjectFiles()}
				class="py-1.5 px-3.5 bg-violet-500/10 dark:bg-violet-500/15 border border-violet-500/20 rounded-md text-violet-600 text-xs cursor-pointer transition-all duration-150 hover:bg-violet-500/20 dark:hover:bg-violet-500/25"
			>Retry</button>
		</div>
	{:else}
		<div class="flex-1 overflow-hidden">
			<!-- Unified layout: always render both Tree and Viewer to preserve internal state -->
			<div class="h-full flex">
				<!-- Tree panel: always rendered, hidden via CSS in 1-column viewer mode -->
				<div
					class={isTwoColumnMode
						? 'w-80 flex-shrink-0 h-full overflow-hidden border-r border-slate-200 dark:border-slate-700'
						: (viewMode === 'tree' ? 'w-full h-full overflow-hidden' : 'hidden')}
				>
					<div class="h-full overflow-auto" bind:this={treeScrollContainer}>
						<FileTree
							bind:this={fileTreeRef}
							files={projectFiles}
							selectedFile={displayFile}
							activeFilePath={activeTabPath}
							{expandedFolders}
							onFileSelect={handleFileSelect}
							onFileAction={handleFileAction}
							onFileOpen={handleFileOpen}
							onToggle={handleFolderToggle}
							hasClipboard={clipboard !== null}
							onPasteToRoot={pasteToRoot}
							onNewFileInRoot={createNewFileInRoot}
							onNewFolderInRoot={createNewFolderInRoot}
							onRefresh={refreshAll}
							modifiedFiles={modifiedFilePaths}
						/>
					</div>
				</div>

				<!-- Editor panel: always rendered, hidden via CSS in 1-column tree mode -->
				<div
					class={isTwoColumnMode
						? 'flex-1 h-full overflow-hidden flex flex-col'
						: (viewMode === 'viewer' ? 'w-full h-full flex flex-col' : 'hidden')}
				>
					{@render tabBar()}
					<div class="flex-1 overflow-hidden">
						<FileViewer
							file={displayFile}
							content={displayContent}
							savedContent={displaySavedContent}
							isLoading={displayLoading}
							error=""
							onSave={saveFile}
							targetLine={displayTargetLine}
							onContentChange={handleEditorContentChange}
							wordWrap={wordWrapEnabled}
							onToggleWordWrap={() => { wordWrapEnabled = !wordWrapEnabled; }}
							externallyChanged={displayExternallyChanged}
							onForceReload={forceReloadTab}
						/>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Dialog for Rename / Create -->
	<Dialog
		bind:isOpen={dialogOpen}
		type="info"
		title={dialogConfig.title}
		message={dialogConfig.message}
		bind:inputValue={dialogValue}
		inputPlaceholder={dialogConfig.placeholder}
		confirmText={dialogConfig.confirmText}
		onConfirm={handleDialogConfirm}
		onClose={closeDialog}
	/>

	<!-- Alert Component -->
	<Alert
		bind:isOpen={showAlert}
		title={alertTitle}
		message={alertMessage}
		type={alertType}
		onClose={() => { showAlert = false; }}
	/>
</div>

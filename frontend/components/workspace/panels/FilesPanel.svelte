<script module lang="ts">
	import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';

	// In-memory snapshot survives component destruction within the same SPA
	// session (e.g. mobile/desktop layout switch). DB remains the source of
	// truth for cross-device persistence.
	const projectFileStates = new Map<string, PersistedPanelState>();

	export interface PersistedPanelState {
		v: number;
		expandedFolders: string[]; // relative to projectPath
		openTabs: { path: string; scrollTop: number }[]; // relative to projectPath
		activeTabPath: string | null; // relative to projectPath
		treeScrollTop: number;
		viewMode: 'tree' | 'viewer';
	}

	const PANEL_STATE_VERSION = 1;

	/**
	 * Clean up persisted state for a specific project.
	 * Called when a project is removed to prevent memory leaks.
	 */
	export function cleanupProjectState(projectPath: string): void {
		projectFileStates.delete(projectPath);
	}

	function cleanupProjectFilePanelState(_projectId: string, projectPath?: string): void {
		if (projectPath) {
			cleanupProjectState(projectPath);
		}
	}

	// Register once at module load to avoid duplicate closures on remount.
	registerProjectCleanup(cleanupProjectFilePanelState);
</script>

<script lang="ts">
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import FileTree from '$frontend/components/files/FileTree.svelte';
	import FileViewer from '$frontend/components/files/FileViewer.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Alert from '$frontend/components/common/feedback/Alert.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import type { FileNode } from '$shared/types/filesystem';
	import { debug } from '$shared/utils/logger';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { onMount, onDestroy } from 'svelte';
	import ws from '$frontend/utils/ws';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getGitStatusLabel, getGitStatusColor } from '$frontend/utils/git-status';
	import type { IconName } from '$shared/types/ui/icons';
	import { fileState, clearRevealRequest } from '$frontend/stores/core/files.svelte';
	import {
		gitStatusState,
		initGitStatus,
		refreshGitStatus,
		syncGitStatusForProject
	} from '$frontend/stores/features/git-status.svelte';

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
		isBinary?: boolean;
		scrollTop: number;
	}

	let openTabs = $state<EditorTab[]>([]);
	let activeTabPath = $state<string | null>(null);
	let wordWrapEnabled = $state(false);
	let tabsScrollContainer = $state<HTMLDivElement | null>(null);

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
	let displayIsBinary = $state(false);
	let displayExternallyChanged = $state(false);

	// Sync display state when active tab changes
	$effect(() => {
		if (activeTab) {
			displayFile = activeTab.file;
			displayContent = activeTab.currentContent;
			displaySavedContent = activeTab.savedContent;
			displayLoading = activeTab.isLoading;
			displayExternallyChanged = activeTab.externallyChanged || false;
			displayIsBinary = activeTab.isBinary || false;
		} else {
			displayFile = null;
			displayContent = '';
			displaySavedContent = '';
			displayLoading = false;
			displayExternallyChanged = false;
			displayIsBinary = false;
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
	let lastProjectId = $state<string>('');

	// Container width detection for 2-column layout
	let containerRef = $state<HTMLDivElement | null>(null);
	let containerWidth = $state(0);
	let leftPanelWidth = $state(256); // default w-64
	let isResizing = $state(false);
	const TWO_COLUMN_THRESHOLD = $derived(Math.round(600 * (settings.fontSize / 13)));

	// FileTree ref + FileViewer ref (for editor scroll save/restore)
	let fileTreeRef = $state<any>(null);
	let fileViewerRef = $state<any>(null);
	const isTwoColumnMode = $derived(containerWidth >= TWO_COLUMN_THRESHOLD);

	// Tree state preservation
	let treeScrollContainer = $state<HTMLElement | null>(null);
	let treeScrollTop = $state(0);
	let pendingTreeScrollRestore = $state<number | null>(null);
	let panelStateLoaded = $state(false);

	// Path conversion helpers
	function toRelative(absolute: string): string {
		if (!projectPath || !absolute) return absolute;
		if (!absolute.startsWith(projectPath)) return absolute;
		return absolute.slice(projectPath.length).replace(/^[/\\]/, '');
	}

	function toAbsolute(relative: string): string {
		if (!projectPath || !relative) return relative;
		const sep = projectPath.includes('\\') ? '\\' : '/';
		const normalized = sep === '\\' ? relative.replace(/\//g, '\\') : relative.replace(/\\/g, '/');
		return `${projectPath}${sep}${normalized}`;
	}

	function readActiveEditorScrollTop(): number {
		const top = fileViewerRef?.getEditorScrollTop?.();
		return typeof top === 'number' ? top : 0;
	}

	function snapshotActiveTabScroll() {
		if (!activeTabPath) return;
		const top = readActiveEditorScrollTop();
		openTabs = openTabs.map(t =>
			t.file.path === activeTabPath ? { ...t, scrollTop: top } : t
		);
	}

	function buildPersistedStateFor(basePath: string): PersistedPanelState {
		const sep = basePath.includes('\\') ? '\\' : '/';
		const toRel = (absolute: string): string => {
			if (!basePath || !absolute) return absolute;
			if (!absolute.startsWith(basePath)) return absolute;
			return absolute.slice(basePath.length).replace(/^[/\\]/, '');
		};
		// Read current scroll positions live (tree from DOM, editor from Monaco)
		const liveTreeScroll = treeScrollContainer ? treeScrollContainer.scrollTop : treeScrollTop;
		const liveEditorScroll = activeTabPath ? readActiveEditorScrollTop() : 0;
		void sep; // separator implicit in toRel
		return {
			v: PANEL_STATE_VERSION,
			expandedFolders: Array.from(expandedFolders).map(toRel),
			openTabs: openTabs.map(t => ({
				path: toRel(t.file.path),
				scrollTop: t.file.path === activeTabPath ? liveEditorScroll : t.scrollTop
			})),
			activeTabPath: activeTabPath ? toRel(activeTabPath) : null,
			treeScrollTop: liveTreeScroll,
			viewMode: isTwoColumnMode
				? (activeTabPath && openTabs.length > 0 ? 'viewer' : 'tree')
				: viewMode
		};
	}

	let panelStateSaveTimer: ReturnType<typeof setTimeout> | null = null;
	function schedulePanelStateSave() {
		if (!projectId || !panelStateLoaded) return;
		if (panelStateSaveTimer) clearTimeout(panelStateSaveTimer);
		panelStateSaveTimer = setTimeout(() => {
			panelStateSaveTimer = null;
			persistPanelStateNow();
		}, 500);
	}

	function persistPanelStateNow() {
		persistStateForProject(projectId, projectPath);
	}

	// Persist using explicit project refs — required when switching projects
	// because $derived projectId/projectPath have already advanced to the new
	// project by the time the change-effect fires.
	function persistStateForProject(targetId: string, targetPath: string) {
		if (!targetId || !targetPath) return;
		const state = buildPersistedStateFor(targetPath);
		projectFileStates.set(targetPath, state);
		ws.http('files:set-panel-state', {
			projectId: targetId,
			state: JSON.stringify(state)
		}).catch((err) => debug.error('file', 'Failed to persist panel state:', err));
	}

	// ============================
	// File Loading
	// ============================

	async function loadProjectFiles(preserveState = false) {
		if (!hasActiveProject) {
			projectFiles = [];
			return;
		}

		// Use the current expandedFolders set as the source for `expanded` —
		// this works both for refreshes (preserveState=true) and for the
		// initial load after restoring state from DB (expandedFolders has
		// already been populated from PersistedPanelState).
		const savedExpandedFolders = new Set(expandedFolders);
		const savedTreeScrollTop = treeScrollContainer
			? treeScrollContainer.scrollTop
			: pendingTreeScrollRestore ?? treeScrollTop;

		if (!preserveState) {
			isLoading = true;
		}
		error = '';

		try {
			const requestData: { project_path: string; expanded?: string } = {
				project_path: projectPath
			};
			if (savedExpandedFolders.size > 0) {
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

			if (isInitialLoad) {
				isInitialLoad = false;
			}

			// Restore expanded folders set (in case any were trimmed during load)
			if (savedExpandedFolders.size > 0) {
				expandedFolders = savedExpandedFolders;
			}

			// Restore tree scroll after the DOM has rendered the (possibly deeper) tree
			const targetScroll = preserveState ? savedTreeScrollTop : (pendingTreeScrollRestore ?? null);
			if (targetScroll !== null) {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						if (treeScrollContainer) {
							treeScrollContainer.scrollTop = targetScroll;
							treeScrollTop = targetScroll;
						}
						pendingTreeScrollRestore = null;
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

		// Snapshot current active tab's editor scroll before switching
		snapshotActiveTabScroll();

		// Check if tab already exists
		const existingTab = openTabs.find(t => t.file.path === file.path);
		if (existingTab) {
			activeTabPath = file.path;
			displayTargetLine = targetLine;
			if (!isTwoColumnMode) viewMode = 'viewer';
			schedulePanelStateSave();
			return;
		}

		// Create new tab
		const newTab: EditorTab = {
			file,
			currentContent: '',
			savedContent: '',
			isLoading: true,
			scrollTop: 0
		};
		openTabs = [...openTabs, newTab];
		activeTabPath = file.path;
		displayTargetLine = targetLine;
		if (!isTwoColumnMode) viewMode = 'viewer';

		// Load content
		loadTabContent(file.path);
		schedulePanelStateSave();
	}

	async function loadTabContent(filePath: string): Promise<boolean> {
		try {
			const data = await ws.http('files:read-file', { file_path: filePath });
			const content = data.content || '';
			const isBinary = data.isBinary || false;
			openTabs = openTabs.map(t =>
				t.file.path === filePath
					? { ...t, currentContent: content, savedContent: content, isLoading: false, isBinary }
					: t
			);
			// Update display if this is the active tab
			if (filePath === activeTabPath) {
				displayContent = content;
				displaySavedContent = content;
				displayLoading = false;
				displayIsBinary = isBinary;
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
		// Snapshot current active tab's editor scroll before switching away
		snapshotActiveTabScroll();

		activeTabPath = path;
		displayTargetLine = undefined;

		// Directly sync display state for immediate editor update
		const tab = openTabs.find(t => t.file.path === path);
		if (tab) {
			displayFile = tab.file;
			displayContent = tab.currentContent;
			displaySavedContent = tab.savedContent;
			displayLoading = tab.isLoading;
			displayIsBinary = tab.isBinary || false;
		}
		schedulePanelStateSave();
	}

	// Keep the active editor tab visible inside the horizontally-scrollable tab strip.
	$effect(() => {
		const path = activeTabPath;
		const container = tabsScrollContainer;
		if (!path || !container) return;
		requestAnimationFrame(() => {
			const el = container.querySelector(
				`[data-tab-path="${CSS.escape(path)}"]`
			) as HTMLElement | null;
			if (!el) return;
			const cRect = container.getBoundingClientRect();
			const eRect = el.getBoundingClientRect();
			if (eRect.left < cRect.left) {
				container.scrollBy({ left: eRect.left - cRect.left, behavior: 'smooth' });
			} else if (eRect.right > cRect.right) {
				container.scrollBy({ left: eRect.right - cRect.right, behavior: 'smooth' });
			}
		});
	});

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

		// Snapshot scroll of the tab being closed if it's active (in case the
		// user reopens it later via reveal or recent files)
		if (activeTabPath === path) snapshotActiveTabScroll();

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
		schedulePanelStateSave();
	}

	function closeAllTabs() {
		if (activeTabPath) snapshotActiveTabScroll();
		openTabs = [];
		activeTabPath = null;
		if (!isTwoColumnMode) viewMode = 'tree';
		schedulePanelStateSave();
	}

	// Drag-and-drop reorder state
	let dragSrcIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);

	function onTabDragStart(e: DragEvent, index: number) {
		dragSrcIndex = index;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		}
	}

	function onTabDragOver(e: DragEvent, index: number) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dragOverIndex = index;
	}

	function onTabDragLeave() {
		dragOverIndex = null;
	}

	function onTabDrop(e: DragEvent, targetIndex: number) {
		e.preventDefault();
		const srcIdx = dragSrcIndex;
		dragSrcIndex = null;
		dragOverIndex = null;
		if (srcIdx === null || srcIdx === targetIndex) return;
		const newTabs = [...openTabs];
		const [moved] = newTabs.splice(srcIdx, 1);
		newTabs.splice(targetIndex, 0, moved);
		openTabs = newTabs;
		schedulePanelStateSave();
	}

	function onTabDragEnd() {
		dragSrcIndex = null;
		dragOverIndex = null;
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
		schedulePanelStateSave();
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

	// Load files when project changes — restore persisted state first, then
	// fetch tree with the correct `expanded` paths so children are populated.
	$effect(() => {
		const currentProjectId = projectId;
		const currentProjectPath = projectPath;

		if (!hasActiveProject) {
			openTabs = [];
			activeTabPath = null;
			viewMode = 'tree';
			lastProjectPath = '';
			lastProjectId = '';
			isInitialLoad = true;
			panelStateLoaded = false;
			return;
		}

		// Persist outgoing project's state (best effort) before switching —
		// must use the OLD project's id/path because $derived projectPath has
		// already advanced and openTabs still contain absolute paths under it.
		if (lastProjectPath && lastProjectPath !== currentProjectPath) {
			snapshotActiveTabScroll();
			if (panelStateSaveTimer) {
				clearTimeout(panelStateSaveTimer);
				panelStateSaveTimer = null;
			}
			persistStateForProject(lastProjectId, lastProjectPath);
		}

		if (lastProjectPath !== currentProjectPath) {
			isInitialLoad = true;
			panelStateLoaded = false;
			// Reset transient state — restore() will repopulate
			openTabs = [];
			activeTabPath = null;
			expandedFolders = new Set();
			viewMode = 'tree';
		}

		lastProjectPath = currentProjectPath;
		lastProjectId = currentProjectId;

		// Sync git status for the new project
		syncGitStatusForProject();

		// Restore from DB then load the tree
		restoreAndLoad(currentProjectId, currentProjectPath);
	});

	async function restoreAndLoad(targetProjectId: string, targetProjectPath: string) {
		// Try in-memory snapshot first (instant for same-session mobile/desktop switch)
		const inMem = projectFileStates.get(targetProjectPath);
		let restored = false;

		if (inMem) {
			applyPersistedState(inMem, targetProjectPath);
			restored = true;
		}

		// Always fetch DB state too — it may be newer (cross-device, refresh)
		try {
			const result = await ws.http('files:get-panel-state', { projectId: targetProjectId });
			if (projectId !== targetProjectId) return; // race: project changed mid-fetch
			if (result?.state) {
				try {
					const parsed: PersistedPanelState = JSON.parse(result.state);
					applyPersistedState(parsed, targetProjectPath);
					restored = true;
				} catch (err) {
					debug.error('file', 'Failed to parse panel state JSON:', err);
				}
			}
		} catch (err) {
			debug.error('file', 'Failed to fetch panel state:', err);
		}

		// Mark as loaded BEFORE loadProjectFiles so any post-load saves are kept
		panelStateLoaded = true;

		await loadProjectFiles(restored);

		// After tree load, hydrate tab content for any restored tabs that
		// don't yet have content (their loadTabContent was triggered in
		// applyPersistedState but may still be in flight)
	}

	function applyPersistedState(state: PersistedPanelState, basePath: string) {
		const sep = basePath.includes('\\') ? '\\' : '/';
		const toAbs = (rel: string) => {
			const normalized = sep === '\\' ? rel.replace(/\//g, '\\') : rel.replace(/\\/g, '/');
			return `${basePath}${sep}${normalized}`;
		};

		expandedFolders = new Set((state.expandedFolders || []).map(toAbs));
		viewMode = state.viewMode || 'tree';
		treeScrollTop = state.treeScrollTop || 0;
		pendingTreeScrollRestore = treeScrollTop;

		// Rebuild tabs as placeholders; loadTabContent will populate content
		const restoredTabs: EditorTab[] = (state.openTabs || []).map((t) => {
			const absPath = toAbs(t.path);
			const fileName = absPath.split(/[\\/]/).pop() || 'Untitled';
			return {
				file: {
					name: fileName,
					path: absPath,
					type: 'file',
					size: 0,
					modified: new Date()
				},
				currentContent: '',
				savedContent: '',
				isLoading: true,
				scrollTop: t.scrollTop || 0
			};
		});
		openTabs = restoredTabs;
		activeTabPath = state.activeTabPath ? toAbs(state.activeTabPath) : null;

		// Trigger content fetch for each restored tab; closeTab() if it fails
		for (const tab of restoredTabs) {
			loadTabContent(tab.file.path).then((ok) => {
				if (!ok) closeTab(tab.file.path);
			});
		}
	}

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

	// Reveal and open file in editor when requested from external components (e.g. chat tools)
	$effect(() => {
		const revealPath = fileState.revealRequest;
		if (!revealPath || !projectPath) return;

		clearRevealRequest();

		// Expand all parent directories in the tree
		const relativePath = revealPath.startsWith(projectPath)
			? revealPath.slice(projectPath.length).replace(/^[/\\]/, '')
			: '';
		if (relativePath) {
			const parts = relativePath.split(/[/\\]/);
			let currentPath = projectPath;
			for (let i = 0; i < parts.length - 1; i++) {
				currentPath += '/' + parts[i];
				expandedFolders.add(currentPath);
			}
			expandedFolders = new Set(expandedFolders);
		}

		// Open file in editor tab (handleFileOpen also handles missing tree nodes)
		revealAndOpenFile(revealPath);
	});

	async function revealAndOpenFile(filePath: string) {
		const existingTab = openTabs.find(t => t.file.path === filePath);
		if (existingTab) {
			// Tab already open — just activate it
			activeTabPath = filePath;
			if (!isTwoColumnMode) viewMode = 'viewer';
			scrollToActiveFile(filePath);
			return;
		}

		// Create new tab
		let file = findFileInTree(projectFiles, filePath);
		if (!file) {
			const fileName = filePath.split(/[/\\]/).pop() || 'Untitled';
			file = { name: fileName, path: filePath, type: 'file', size: 0, modified: new Date() };
		}
		const newTab: EditorTab = {
			file,
			currentContent: '',
			savedContent: '',
			isLoading: true,
			scrollTop: 0
		};
		openTabs = [...openTabs, newTab];
		activeTabPath = filePath;
		if (!isTwoColumnMode) viewMode = 'viewer';

		// Load content and verify file exists on disk
		const success = await loadTabContent(filePath);
		if (!success) {
			openTabs = openTabs.filter(t => t.file.path !== filePath);
			if (activeTabPath === filePath) {
				activeTabPath = openTabs.length > 0 ? openTabs[openTabs.length - 1].file.path : null;
				if (!activeTabPath && !isTwoColumnMode) viewMode = 'tree';
			}
			showErrorAlert('File no longer exists on disk.', 'File Not Found');
			return;
		}

		scrollToActiveFile(filePath);
	}

	// Save state on component destruction (mobile/desktop switch / panel close)
	onDestroy(() => {
		if (panelStateSaveTimer) {
			clearTimeout(panelStateSaveTimer);
			panelStateSaveTimer = null;
		}
		if (treeScrollSaveTimer) {
			clearTimeout(treeScrollSaveTimer);
			treeScrollSaveTimer = null;
		}
		if (projectPath && projectId) {
			snapshotActiveTabScroll();
			persistPanelStateNow();
		}
	});

	function startColumnResize(e: MouseEvent) {
		isResizing = true;
		const startX = e.clientX;
		const startWidth = leftPanelWidth;

		function onMouseMove(e: MouseEvent) {
			const delta = e.clientX - startX;
			leftPanelWidth = Math.max(120, Math.min(startWidth + delta, containerWidth - 120));
		}

		function onMouseUp() {
			isResizing = false;
			window.removeEventListener('mousemove', onMouseMove);
			window.removeEventListener('mouseup', onMouseUp);
		}

		window.addEventListener('mousemove', onMouseMove);
		window.addEventListener('mouseup', onMouseUp);
	}

	// Monitor container width for responsive layout
	onMount(() => {
		// Subscribe git status to file change events (idempotent)
		initGitStatus();

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

	// Tree scroll persistence — debounced on scroll, immediate on tab/etc
	let treeScrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
	function handleTreeScroll() {
		if (!treeScrollContainer) return;
		treeScrollTop = treeScrollContainer.scrollTop;
		if (treeScrollSaveTimer) clearTimeout(treeScrollSaveTimer);
		treeScrollSaveTimer = setTimeout(() => {
			treeScrollSaveTimer = null;
			schedulePanelStateSave();
		}, 750);
	}

	function handleEditorScroll(scrollTop: number) {
		if (!activeTabPath) return;
		// Mutate in place to avoid triggering re-render of the tab list
		const tab = openTabs.find(t => t.file.path === activeTabPath);
		if (tab) tab.scrollTop = scrollTop;
		schedulePanelStateSave();
	}

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
		<div class="flex items-stretch border-b border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 flex-shrink-0">
			<div bind:this={tabsScrollContainer} class="flex items-center overflow-x-auto flex-1 min-w-0">
				{#each openTabs as tab, index (tab.file.path)}
					{@const isActive = tab.file.path === activeTabPath}
					{@const isModified = tab.currentContent !== tab.savedContent}
					{@const gitStatusCode = gitStatusState.map.get(tab.file.path) || ''}
					{@const isDragOver = dragOverIndex === index && dragSrcIndex !== null && dragSrcIndex !== index}
					<div
						data-tab-path={tab.file.path}
						class="flex items-center gap-1.5 px-3 py-2 text-xs border-r border-slate-200/50 dark:border-slate-700/50 whitespace-nowrap transition-colors flex-shrink-0 cursor-pointer {isActive
							? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
							: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-300'} {isDragOver ? 'ring-2 ring-violet-500/40 ring-inset' : ''}"
						draggable="true"
						ondragstart={(e) => onTabDragStart(e, index)}
						ondragover={(e) => onTabDragOver(e, index)}
						ondragleave={onTabDragLeave}
						ondrop={(e) => onTabDrop(e, index)}
						ondragend={onTabDragEnd}
						onclick={() => selectTab(tab.file.path)}
					>
						<Icon name={getFileIcon(tab.file.name) as IconName} class="w-3.5 h-3.5 flex-shrink-0" />
						<span class="truncate max-w-28">{tab.file.name}</span>
						{#if gitStatusCode}
							<span class="text-xs font-bold {getGitStatusColor(gitStatusCode)} flex-shrink-0">{getGitStatusLabel(gitStatusCode)}</span>
						{/if}
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
			<button
				type="button"
				class="flex items-center justify-center px-2.5 border-l border-slate-200/50 dark:border-slate-700/50 text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors bg-transparent cursor-pointer flex-shrink-0"
				onclick={closeAllTabs}
				title="Close all tabs"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
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
			<div class="h-full flex" class:select-none={isResizing} class:cursor-col-resize={isResizing}>
				<!-- Tree panel: always rendered, hidden via CSS in 1-column viewer mode -->
				<div
					class={isTwoColumnMode
						? 'flex-shrink-0 h-full overflow-hidden'
						: (viewMode === 'tree' ? 'w-full h-full overflow-hidden' : 'hidden')}
					style={isTwoColumnMode ? `width: ${leftPanelWidth}px` : undefined}
				>
					<div class="h-full overflow-auto" bind:this={treeScrollContainer} onscroll={handleTreeScroll}>
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
							gitStatusMap={gitStatusState.map}
							gitFolderStatusMap={gitStatusState.folderMap}
						/>
					</div>
				</div>

				{#if isTwoColumnMode}
				<!-- Column resize handle -->
				<div
					class="relative flex-shrink-0 h-full w-px cursor-col-resize group"
					role="separator"
					aria-orientation="vertical"
					onmousedown={startColumnResize}
				>
					<!-- Invisible extended hit area (6px each side) -->
					<div class="absolute inset-y-0 -left-1.5 -right-1.5 cursor-col-resize z-10"></div>
					<!-- Visual line: 1px default, expands to 4px on hover -->
					<div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px group-hover:w-1 bg-slate-200 dark:bg-slate-700 group-hover:bg-blue-400 dark:group-hover:bg-blue-500 transition-all duration-150"></div>
				</div>
			{/if}

			<!-- Editor panel: always rendered, hidden via CSS in 1-column tree mode -->
				<div
					class={isTwoColumnMode
						? 'flex-1 h-full overflow-hidden flex flex-col'
						: (viewMode === 'viewer' ? 'w-full h-full flex flex-col' : 'hidden')}
				>
					{@render tabBar()}
					<div class="flex-1 overflow-hidden">
						<FileViewer
							bind:this={fileViewerRef}
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
							isBinary={displayIsBinary}
							projectPath={projectPath}
							projectId={projectId}
							editorScrollTop={activeTab?.scrollTop ?? 0}
							onEditorScroll={handleEditorScroll}
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

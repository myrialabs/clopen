<script module lang="ts">
	import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';

	// In-memory snapshot survives component destruction within the same SPA
	// session (e.g. mobile/desktop layout switch). DB remains the source of
	// truth for cross-device persistence.
	const projectFileStates = new Map<string, PersistedPanelState>();

	// Unsaved (dirty) editor buffers, keyed by `${projectPath} ${absFilePath}`.
	// Preserved across project switches so unsaved edits aren't silently lost when
	// the user navigates to another project and back. In-memory only.
	const unsavedBuffers = new Map<string, string>();

	function unsavedBufferKey(projectPath: string, filePath: string): string {
		return `${projectPath} ${filePath}`;
	}
	function getUnsavedBuffer(projectPath: string, filePath: string): string | undefined {
		return unsavedBuffers.get(unsavedBufferKey(projectPath, filePath));
	}
	function setUnsavedBuffer(projectPath: string, filePath: string, content: string): void {
		unsavedBuffers.set(unsavedBufferKey(projectPath, filePath), content);
	}
	function clearUnsavedBuffer(projectPath: string, filePath: string): void {
		unsavedBuffers.delete(unsavedBufferKey(projectPath, filePath));
	}

	export interface PersistedPanelState {
		v: number;
		expandedFolders: string[]; // relative to projectPath
		openTabs: { path: string; scrollTop: number; unsaved?: string }[]; // relative to projectPath; `unsaved` = dirty buffer
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
		// Drop any unsaved buffers belonging to this project path.
		const prefix = `${projectPath} `;
		for (const key of [...unsavedBuffers.keys()]) {
			if (key.startsWith(prefix)) unsavedBuffers.delete(key);
		}
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
	import { currentScopeKey } from '$frontend/stores/features/worktrees.svelte';
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
	import CompressDialog from '$frontend/components/files/CompressDialog.svelte';
	import { stripArchiveExtension, extensionFor, type ArchiveFormat, type ZipMethod } from '$frontend/utils/archive';
	import { acquireFileWatch } from '$frontend/utils/file-watch';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { fetchFileBlob, isAbortError, saveBlob } from '$frontend/utils/file-download';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { showSuccess, showError, showWarning } from '$frontend/stores/ui/notification.svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { getGitStatusLabel, getGitStatusColor } from '$frontend/utils/git-status';
	import type { IconName } from '$shared/types/ui/icons';
	import { fileState, clearRevealRequest, collapseAllTrigger } from '$frontend/stores/core/files.svelte';
	import { onAiFilesChange } from '$frontend/utils/ai-changes';
	import {
		gitStatusState,
		initGitStatus,
		refreshGitStatus,
		syncGitStatusForProject
	} from '$frontend/stores/features/git-status.svelte';
	import {
		ignoredPathsState,
		initIgnoredPaths,
		refreshIgnoredPaths
	} from '$frontend/stores/features/ignored-paths.svelte';
	import { beginPanelLoad } from '$frontend/stores/ui/project-workspace.svelte';
	import {
		getExplorerShortcutLabels,
		isExplorerMod,
		isLocalConnection,
		isMac,
		nativeFileManagerName
	} from '$frontend/utils/platform';

	// Props
	interface Props {
		showMobileHeader?: boolean;
	}

	const { showMobileHeader = false }: Props = $props();

	// State
	const hasActiveProject = $derived(projectState.currentProject !== null);
	const projectPath = $derived(projectState.currentProject?.path || '');
	const projectId = $derived(projectState.currentProject?.id || '');
	// File-watch events are keyed by workspace, so a worktree's changes never
	// reach a panel viewing the main tree.
	const watchScope = $derived(currentScopeKey() || projectId);

	// File watcher state
	let isWatching = $state(false);
	let watchDebounceTimer = $state<ReturnType<typeof setTimeout> | null>(null);

	let projectFiles = $state<FileNode[]>([]);
	let isLoading = $state(false);
	let isInitialLoad = $state(true);
	let error = $state('');
	let expandedFolders = $state(new Set<string>());

	// AI changes set for explorer dot indicators
	let aiChangesSet = $state(new Set<string>());

	// Watch global collapse-all signal
	$effect(() => {
		collapseAllTrigger.count; // track changes
		expandedFolders = new Set();
	});
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
		// Disk mtime of the content we last read/wrote — used as an optimistic
		// concurrency token so a save can't silently clobber a newer on-disk
		// version that arrived while the tab held stale content.
		savedMtime?: string;
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
	let displayTarget = $state<{ line: number; column?: number; length?: number } | undefined>(undefined);
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

	// Compress dialog (format / method / level / password) — opened from the tree.
	let compressDialogOpen = $state(false);
	let compressTargets = $state<FileNode[]>([]);

	// Password prompt shown when extracting an encrypted archive.
	let passwordDialogOpen = $state(false);
	let passwordDialogValue = $state('');
	let passwordDialogWrong = $state(false);
	let passwordResolve: ((value: string | undefined) => void) | null = null;

	function promptPassword(wrong: boolean): Promise<string | undefined> {
		passwordDialogWrong = wrong;
		passwordDialogValue = '';
		passwordDialogOpen = true;
		return new Promise((resolve) => { passwordResolve = resolve; });
	}

	function resolvePassword(value: string | undefined) {
		passwordDialogOpen = false;
		const resolve = passwordResolve;
		passwordResolve = null;
		resolve?.(value);
	}

	// "Unsaved Changes" prompt shown when closing all tabs while some are dirty.
	let closeAllUnsavedDialogOpen = $state(false);
	let closeAllUnsavedMessage = $state('');

	function closeCloseAllUnsavedDialog() {
		closeAllUnsavedDialogOpen = false;
		closeAllUnsavedMessage = '';
	}

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
	// Workspace the panel last persisted for; the outgoing state must be written
	// under it, not under the scope the panel has already advanced to.
	let lastProjectScope = $state<string>('');

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
				scrollTop: t.file.path === activeTabPath ? liveEditorScroll : t.scrollTop,
				// Persist dirty buffers so unsaved edits survive a refresh (content +
				// scroll only — Monaco can't serialize its undo/redo stack).
				...(t.currentContent !== t.savedContent ? { unsaved: t.currentContent } : {})
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
	function persistStateForProject(targetId: string, targetPath: string, targetScope = watchScope) {
		if (!targetId || !targetPath) return;
		// Capture unsaved editor buffers for this project so dirty edits survive a
		// switch (openTabs still holds this project's tabs when called on switch).
		for (const tab of openTabs) {
			if (tab.currentContent !== tab.savedContent) {
				setUnsavedBuffer(targetPath, tab.file.path, tab.currentContent);
			} else {
				clearUnsavedBuffer(targetPath, tab.file.path);
			}
		}
		const state = buildPersistedStateFor(targetPath);
		projectFileStates.set(targetPath, state);
		ws.http('files:set-panel-state', {
			projectId: targetId,
			scopeKey: targetScope,
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
		const requestPath = projectPath;

		// `preserveState` is about scroll/expansion, NOT about the loading flag —
		// conflating the two is what made a project switch render the tree's empty
		// state ("No files in project") while the tree was still being fetched, since
		// a switch that restored panel state always passed preserveState=true. The
		// flag is always set; the template only shows the spinner when there is
		// nothing to show yet, so a background refresh still never blanks the tree.
		isLoading = true;
		error = '';

		try {
			const requestData: { project_path: string; expanded?: string } = {
				project_path: projectPath
			};
			if (savedExpandedFolders.size > 0) {
				requestData.expanded = Array.from(savedExpandedFolders).join(',');
			}

			const data = await ws.http('files:list-tree', requestData);

			// The project may have changed while this was in flight — dropping the
			// response is the only way to stop the previous project's tree from
			// landing in the new project's panel.
			if (requestPath !== projectPath) return;

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
			if (requestPath !== projectPath) return;
			error = err instanceof Error ? err.message : 'Failed to load files';
			projectFiles = [];
		} finally {
			if (requestPath === projectPath) isLoading = false;
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

	function openFileInTab(file: FileNode, target?: { line: number; column?: number; length?: number }) {
		if (file.type === 'directory') return;

		// Reset active AI reveal filter on normal file tree/tab navigation
		fileViewerRef?.resetRevealFilter?.();

		// Snapshot current active tab's editor scroll before switching
		snapshotActiveTabScroll();

		// Check if tab already exists
		const existingTab = openTabs.find(t => t.file.path === file.path);
		if (existingTab) {
			activeTabPath = file.path;
			displayTarget = target;
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
		displayTarget = target;
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
			const savedMtime = data.modified;
			// Restore an unsaved buffer (e.g. user edited then switched projects):
			// keep it as the live content while disk content becomes savedContent so
			// the tab still shows as modified.
			const unsaved = isBinary ? undefined : getUnsavedBuffer(projectPath, filePath);
			const liveContent = unsaved !== undefined && unsaved !== content ? unsaved : content;
			openTabs = openTabs.map(t =>
				t.file.path === filePath
					? { ...t, currentContent: liveContent, savedContent: content, isLoading: false, isBinary, savedMtime, externallyChanged: false, file: { ...t.file, size: data.size } }
					: t
			);
			// Update display if this is the active tab
			if (filePath === activeTabPath) {
				displayContent = liveContent;
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
		// Reset active AI reveal filter on normal file tree/tab navigation
		fileViewerRef?.resetRevealFilter?.();

		// Snapshot current active tab's editor scroll before switching away
		snapshotActiveTabScroll();

		activeTabPath = path;
		displayTarget = undefined;

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

		// Auto-scroll to the selected file/folder in the tree after DOM update (only if visible)
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				const selectedEl = treeScrollContainer?.querySelector(`[data-path="${CSS.escape(filePath)}"]`) || treeScrollContainer?.querySelector('.selected');
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

		// Explicitly closing a tab discards its unsaved buffer.
		clearUnsavedBuffer(projectPath, path);

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
		const unsavedTabs = openTabs.filter(t => t.currentContent !== t.savedContent);
		if (unsavedTabs.length > 0) {
			const names = unsavedTabs.map(t => `"${t.file.name}"`).join(', ');
			closeAllUnsavedMessage = `${unsavedTabs.length === 1 ? `${names} has` : `${names} have`} unsaved changes.`;
			closeAllUnsavedDialogOpen = true;
			return;
		}
		performCloseAllTabs();
	}

	function performCloseAllTabs() {
		if (activeTabPath) snapshotActiveTabScroll();
		// Mirrors closeTab(): discard each tab's unsaved buffer so a later
		// reopen doesn't resurrect content the user just discarded/saved.
		for (const tab of openTabs) {
			clearUnsavedBuffer(projectPath, tab.file.path);
		}
		openTabs = [];
		activeTabPath = null;
		if (!isTwoColumnMode) viewMode = 'tree';
		schedulePanelStateSave();
	}

	function discardAllAndCloseTabs() {
		performCloseAllTabs();
	}

	async function saveAllAndCloseTabs() {
		const unsavedTabs = openTabs.filter(t => t.currentContent !== t.savedContent);
		try {
			for (const tab of unsavedTabs) {
				await saveFile(tab.file.path, tab.currentContent);
			}
			performCloseAllTabs();
		} catch (err) {
			showErrorAlert(err instanceof Error ? err.message : 'Failed to save all files', 'Save Failed');
		}
	}

	async function handleCloseTab(path: string) {
		const tab = openTabs.find(t => t.file.path === path);
		if (!tab) return;

		if (tab.currentContent !== tab.savedContent) {
			const confirmed = await showConfirm({
				title: 'Unsaved Changes',
				message: `"${tab.file.name}" has unsaved changes. Discard changes?`,
				type: 'warning',
				confirmText: 'Discard',
				cancelText: 'Cancel'
			});
			if (!confirmed) return;
		}

		closeTab(path);
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
				// SSOT: rename folder harus rebase seluruh subtree agar
				// children tidak tertinggal dengan path lama (hilang/duplikat).
				return { ...rebaseSubtree(file, newPath), name: newName };
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
		// SSOT guard: jangan pernah menambah path yang sama dua kali
		// (optimistic + retry/reload race = duplikat di tree).
		if (findFileInTree(files, newNode.path)) return files;
		if (!parentPath) {
			return sortFileNodes([...files, newNode]);
		}
		return files.map((file) => {
			if (file.path === parentPath && file.type === 'directory') {
				// Parent mungkin belum punya children (lazy load) — tetap
				// beri array baru agar item langsung muncul tanpa refresh.
				if ((file.children || []).some((c) => c.path === newNode.path)) return file;
				return { ...file, children: sortFileNodes([...(file.children || []), newNode]) };
			} else if (file.type === 'directory') {
				return { ...file, children: addNodeToTree(file.children || [], parentPath, newNode) };
			}
			return file;
		});
	}

	function duplicateNodeInTree(files: FileNode[], sourcePath: string, targetPath: string): FileNode[] {
		const sourceNode = findFileInTree(files, sourcePath);
		if (!sourceNode) return files;
		const newName = targetPath.split(/[\\/]/).pop() || sourceNode.name;
		const duplicateNode: FileNode = { ...rebaseSubtree(sourceNode, targetPath), name: newName };
		// Sama seperti moveNodeInTree: root nodes disimpan top-level, bukan di
		// bawah node path === projectPath. Tanpa mapping ini paste file ke
		// root gagal masuk state (optimistic hilang) walau backend sukses.
		// Type dipertahankan dari sourceNode (file tetap file via rebaseSubtree).
		return addNodeToTree(files, parentForAdd(targetPath), duplicateNode);
	}

	function moveNodeInTree(files: FileNode[], sourcePath: string, targetPath: string): FileNode[] {
		const sourceNode = findFileInTree(files, sourcePath);
		if (!sourceNode) return files;
		const newTree = removeNodeFromTree(files, sourcePath);
		const newName = targetPath.split(/[\\/]/).pop() || sourceNode.name;
		const movedNode: FileNode = { ...rebaseSubtree(sourceNode, targetPath), name: newName };
		// Root nodes are stored at the top of the tree, not under a node whose
		// path === projectPath. Map that case to `null` so addNodeToTree appends.
		return addNodeToTree(newTree, parentForAdd(targetPath), movedNode);
	}

	// Rewrite a moved/copied subtree so every descendant keeps its name but
	// points under the new root path. Without this, pasting/moving a folder
	// leaves nested children with STALE source paths (wrong open/actions,
	// phantom structure) until a refresh rebuilds the tree.
	function rebaseSubtree(node: FileNode, newPath: string): FileNode {
		const sep = newPath.includes('\\') ? '\\' : '/';
		const children = node.children?.map((c) => rebaseSubtree(c, `${newPath}${sep}${c.name}`));
		return { ...node, path: newPath, children };
	}

	// Optimistic copy node built directly from a source FileNode (fresh tree
	// node when available, otherwise the clipboard entry itself). Unlike
	// duplicateNodeInTree() this needs no tree lookup, so entries adopted
	// from the native OS clipboard (paths outside the project tree) still
	// render optimistically with the correct FILE/FOLDER type.
	function addCopiedNodeToTree(sourceNode: FileNode, targetPath: string): void {
		const newName = targetPath.split(/[\\/]/).pop() || sourceNode.name;
		const optimisticNode: FileNode = { ...rebaseSubtree(sourceNode, targetPath), name: newName };
		projectFiles = addNodeToTree(projectFiles, parentForAdd(targetPath), optimisticNode);
	}

	// ============================
	// SSOT: path-based state sync (single source of truth)
	// ============================
	// Every move/rename/delete MUST go through these helpers so tree,
	// open tabs, expanded folders, selection, and clipboard never diverge
	// (no manual refresh, no hilang/duplikat). Direct ad-hoc updates to
	// expandedFolders/selectedPaths/clipboard outside these helpers are
	// forbidden — add the case here instead.
	let pendingFsMutations = 0;

	function isSameOrDescendant(p: string | null, base: string): boolean {
		if (!p) return false;
		if (p === base) return true;
		const sep = base.includes('\\') ? '\\' : '/';
		return p.startsWith(`${base}${sep}`);
	}

	function rebaseSinglePath(p: string | null, oldPath: string, newPath: string): string | null {
		if (!p) return p;
		if (p === oldPath) return newPath;
		const sep = oldPath.includes('\\') ? '\\' : '/';
		if (p.startsWith(`${oldPath}${sep}`)) {
			return `${newPath}${sep}${p.slice(oldPath.length + 1)}`;
		}
		return p;
	}

	function leafNameOf(path: string, fallback: string): string {
		return path.split(/[\\/]/).pop() || fallback;
	}

	// Root nodes live top-level (never under a node with path === projectPath).
	function parentForAdd(targetAbs: string): string | null {
		const parts = targetAbs.split(/[\\/]/);
		parts.pop();
		if (parts.length === 0) return null;
		const computed = parts.join(targetAbs.includes('\\') ? '\\' : '/');
		if (!computed || computed === projectPath) return null;
		return computed;
	}

	// Rebase ALL path-keyed state for a move/rename (tree excluded — caller
	// already applied updateNodePathInTree/moveNodeInTree). Covers folder
	// descendants so children tabs/expansion/selection follow the new path.
	function rebaseAllPathState(oldPath: string, newPath: string): void {
		openTabs = openTabs.map((t) => {
			const next = rebaseSinglePath(t.file.path, oldPath, newPath);
			if (!next || next === t.file.path) return t;
			return { ...t, file: { ...t.file, path: next, name: leafNameOf(next, t.file.name) } };
		});
		if (activeTabPath) activeTabPath = rebaseSinglePath(activeTabPath, oldPath, newPath) ?? activeTabPath;
		if (expandedFolders.size > 0) {
			const next = new Set<string>();
			for (const p of expandedFolders) next.add(rebaseSinglePath(p, oldPath, newPath) ?? p);
			expandedFolders = next;
		}
		if (selectedPaths.size > 0) {
			selectedPaths = new Set(Array.from(selectedPaths).map((p) => rebaseSinglePath(p, oldPath, newPath) ?? p));
		}
		if (selectionAnchor) selectionAnchor = rebaseSinglePath(selectionAnchor, oldPath, newPath) ?? selectionAnchor;
		if (clipboard) {
			clipboard = {
				...clipboard,
				files: clipboard.files.map((f) => {
					const next = rebaseSinglePath(f.path, oldPath, newPath);
					if (!next || next === f.path) return f;
					return { ...f, path: next, name: leafNameOf(next, f.name) };
				})
			};
		}
	}

	// Prune ALL path-keyed state for a delete (target + descendants).
	// Tabs are closed here (exact + descendants) so no stale tab survives.
	function pruneAllPathStateForDelete(targetPath: string): void {
		const pathsToClose = openTabs.filter((t) => isSameOrDescendant(t.file.path, targetPath)).map((t) => t.file.path);
		for (const p of pathsToClose) closeTab(p);
		if (expandedFolders.size > 0) {
			expandedFolders = new Set(Array.from(expandedFolders).filter((p) => !isSameOrDescendant(p, targetPath)));
		}
		if (selectedPaths.size > 0) {
			selectedPaths = new Set(Array.from(selectedPaths).filter((p) => !isSameOrDescendant(p, targetPath)));
		}
		if (selectionAnchor && isSameOrDescendant(selectionAnchor, targetPath)) selectionAnchor = null;
		if (clipboard) {
			const remaining = clipboard.files.filter((f) => !isSameOrDescendant(f.path, targetPath));
			clipboard = remaining.length === 0 ? null : { ...clipboard, files: remaining };
		}
	}

	// Background disk-truth sync after structural changes whose optimistic
	// subtree may be shallow (collapsed-folder copy/move/duplicate). The
	// optimistic node already renders instantly; this only fills missing
	// children so no refresh manual is ever needed. Never throws.
	function syncTreeWithDisk(): void {
		void loadProjectFiles(true).catch((err) => debug.error('file', 'Background tree sync failed:', err));
	}

	// Resync yang ditunda saat mutasi optimistis berjalan — dipanggil oleh
	// watcher resync agar echo tidak menimpa tampilan langsung.
	function syncTreeWithDiskDeferred(): void {
		setTimeout(() => {
			if (pendingFsMutations > 0) {
				syncTreeWithDiskDeferred();
				return;
			}
			void loadProjectFiles(true).catch((err) => debug.error('file', 'Deferred tree sync failed:', err));
		}, 500);
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

	// ============================
	// Unified Explorer notifications
	// ============================
	// Every mutating explorer action — whether triggered from the context
	// menu, a keyboard shortcut, drag-and-drop, or an OS paste — emits
	// EXACTLY ONE toast via notifyExplorer(): success and failure alike,
	// always in English. The modal showErrorAlert() above stays reserved for
	// editor flows (save, open) and is never used for explorer file actions,
	// so a single action can never produce two notifications (toast + modal).
	type ExplorerNoticeKind = 'success' | 'warning' | 'error';

	function notifyExplorer(kind: ExplorerNoticeKind, title: string, message: string): void {
		if (kind === 'success') showSuccess(title, message);
		else if (kind === 'warning') showWarning(title, message);
		else showError(title, message);
	}

	function describeTargets(targets: FileNode[]): string {
		return targets.length === 1 ? targets[0].name : `${targets.length} items`;
	}

	function errorMessage(error: unknown, fallback: string): string {
		return error instanceof Error ? error.message : fallback;
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

	// Shared rename entry: opens the rename dialog for the given node, or —
	// for keyboard triggers with no clicked node — for the single selected
	// item (falling back to the selection anchor). Called by the context-menu
	// item AND the F2 shortcut: one logic, one dialog, one toast on confirm.
	function startRename(file: FileNode | null): void {
		if (file) {
			openDialog('rename', file);
			return;
		}
		const paths = Array.from(selectedPaths);
		const targetPath = paths.length === 1 ? paths[0] : (selectionAnchor ?? null);
		if (!targetPath) return;
		const node = findFileInTree(projectFiles, targetPath);
		if (!node) return;
		openDialog('rename', node);
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

		const pathParts = file.path.split(/[\\/]/);
		pathParts[pathParts.length - 1] = newName;
		const newPath = pathParts.join(file.path.includes('\\') ? '\\' : '/');
		const oldPath = file.path;

		try {
			const existingFile = findFileInTree(projectFiles, newPath);
			if (existingFile) {
				notifyExplorer('error', 'Rename Failed', 'A file or folder with this name already exists.');
				return;
			}

			// Optimistic UI — SSOT: tree + semua state ber-path via helper yang sama.
			pendingFsMutations += 1;
			projectFiles = updateNodePathInTree(projectFiles, oldPath, newPath);
			rebaseAllPathState(oldPath, newPath);

			try {
				await ws.http('files:rename', { oldPath, newPath });
			} finally {
				pendingFsMutations = Math.max(0, pendingFsMutations - 1);
			}
			notifyExplorer('success', 'Renamed', `Renamed "${file.name}" to "${newName}".`);
		} catch (error) {
			debug.error('file', 'Failed to rename file:', error);
			// Roll back via SSOT yang sama agar tree + tabs + expanded +
			// selection + clipboard kembali utuh (no hilang/duplikat).
			projectFiles = updateNodePathInTree(projectFiles, newPath, oldPath);
			rebaseAllPathState(newPath, oldPath);
			notifyExplorer('error', 'Rename Failed', errorMessage(error, 'Unknown error'));
		}
	}

	async function performCreateNew(type: 'file' | 'folder', name: string) {
		const parentPath = dialogParentPath;
		const separator = (parentPath || projectPath).includes('\\') ? '\\' : '/';
		const fullPath = parentPath
			? `${parentPath}${separator}${name}`
			: `${projectPath}${separator}${name}`;
		try {
			const newNode: FileNode = {
				name,
				path: fullPath,
				type: type === 'folder' ? 'directory' : 'file',
				size: 0,
				modified: new Date(),
				children: type === 'folder' ? [] : undefined
			};

			// Optimistic UI — langsung muncul tanpa refresh (SSOT addNodeToTree).
			pendingFsMutations += 1;
			projectFiles = addNodeToTree(projectFiles, parentPath, newNode);

			if (parentPath && !expandedFolders.has(parentPath)) {
				expandedFolders.add(parentPath);
				expandedFolders = new Set(expandedFolders);
			}

			try {
				if (type === 'file') {
					await ws.http('files:create-file', { filePath: fullPath, content: '' });
				} else {
					await ws.http('files:create-directory', { dirPath: fullPath });
				}
			} finally {
				pendingFsMutations = Math.max(0, pendingFsMutations - 1);
			}
			notifyExplorer(
				'success',
				type === 'file' ? 'File Created' : 'Folder Created',
				`Created ${type === 'file' ? 'file' : 'folder'} "${name}".`
			);
		} catch (error) {
			debug.error('file', 'Failed to create new item:', error);
			// Roll back the optimistic node so a failed create leaves no ghost entry.
			projectFiles = removeNodeFromTree(projectFiles, fullPath);
			notifyExplorer('error', 'Create Failed', errorMessage(error, 'Unknown error'));
		}
	}

	// ============================
	// Multi-Selection
	// ============================

	let selectedPaths = $state<Set<string>>(new Set());
	let selectionAnchor = $state<string | null>(null);

	// Flatten the tree into the order rows are rendered (DFS, only expanded
	// folders' children), so shift-range can compute a contiguous slice.
	function getVisiblePaths(): string[] {
		const out: string[] = [];
		const walk = (nodes: FileNode[]) => {
			for (const n of nodes) {
				out.push(n.path);
				if (n.type === 'directory' && expandedFolders.has(n.path) && n.children) {
					walk(n.children);
				}
			}
		};
		walk(projectFiles);
		return out;
	}

	function selectRange(anchor: string, target: string) {
		const visible = getVisiblePaths();
		const i1 = visible.indexOf(anchor);
		const i2 = visible.indexOf(target);
		if (i1 === -1 || i2 === -1) {
			selectedPaths = new Set([target]);
			return;
		}
		const [a, b] = i1 < i2 ? [i1, i2] : [i2, i1];
		selectedPaths = new Set(visible.slice(a, b + 1));
	}

	function handleNodeClick(file: FileNode, event: MouseEvent | KeyboardEvent) {
		// Keep keyboard focus inside the tree so Ctrl/Cmd+C/X/V (handled by
		// handleExplorerKeydown) keeps working after a mouse click. Without
		// this, focus stays on <body> and the shortcut guard rejects the keys.
		// This never steals focus from the editor/terminal: it only focuses
		// the row the user just clicked inside the tree.
		const row = event.currentTarget as HTMLElement | null;
		if (row && typeof row.focus === 'function' && document.activeElement !== row) {
			row.focus({ preventScroll: true });
		}

		const ctrl = event.ctrlKey || event.metaKey;
		const shift = event.shiftKey;

		if (shift && selectionAnchor) {
			selectRange(selectionAnchor, file.path);
			return;
		}
		if (ctrl) {
			const next = new Set(selectedPaths);
			if (next.has(file.path)) {
				next.delete(file.path);
			} else {
				next.add(file.path);
			}
			selectedPaths = next;
			selectionAnchor = file.path;
			return;
		}

		// Plain click: replace selection, then continue with normal open/toggle.
		selectedPaths = new Set([file.path]);
		selectionAnchor = file.path;
		if (file.type === 'directory') {
			handleFolderToggle(file.path);
		} else {
			handleFileSelect(file);
		}
	}

	function clearSelection() {
		selectedPaths = new Set();
		selectionAnchor = null;
	}

	// Context-menu open (single handler for every row): native file-manager
	// behavior — right-clicking outside the current selection re-targets the
	// selection to the clicked row, so a subsequent single-file COPY copies
	// ONLY that file even right after a multi-file COPY. Right-clicking
	// inside an existing multi-selection keeps it, so multi-copy via
	// right-click still works. Also refreshes OS clipboard affordance.
	function handleMenuOpen(filePath: string): void {
		if (!selectedPaths.has(filePath)) {
			selectedPaths = new Set([filePath]);
			selectionAnchor = filePath;
		}
		void refreshOsClipboardState();
	}

	// Shared select-all: every visible row becomes the selection, like
	// Ctrl+A / ⌘A in the native manager. Called by the keyboard shortcut AND
	// the context-menu item — one logic, one state update, no toast
	// (selection change is not a mutating action).
	function selectAllVisible(): void {
		const visible = getVisiblePaths();
		if (visible.length === 0) return;
		selectedPaths = new Set(visible);
		if (!selectionAnchor || !selectedPaths.has(selectionAnchor)) {
			selectionAnchor = visible[0];
		}
	}

	// Collect FileNodes for an action — operate on the multi-selection when
	// the clicked node is part of a >1 selection, otherwise just the clicked
	// node.
	function getActionTargets(file: FileNode): FileNode[] {
		if (selectedPaths.has(file.path) && selectedPaths.size > 1) {
			return Array.from(selectedPaths)
				.map((p) => findFileInTree(projectFiles, p))
				.filter((n): n is FileNode => n !== null);
		}
		return [file];
	}

	// ============================
	// Clipboard
	// ============================

	// OS-aware shortcut labels + file-manager name (Ctrl on Windows/Linux,
	// ⌘ on macOS; File Explorer vs Finder). Used by tooltips and
	// notification hints so the displayed shortcut always matches what the
	// keyboard handler listens for on this OS.
	const explorerKeys = getExplorerShortcutLabels();
	const explorerIsMac = isMac();
	const fileManagerName = nativeFileManagerName();

	let clipboard = $state<{ files: FileNode[]; operation: 'copy' | 'cut'; origin: 'internal' | 'os' } | null>(null);
	// Monotonic revision: every COPY/CUT/OS-adopt bumps it synchronously, so
	// the newest source always wins and no async continuation can resurrect a
	// stale clipboard. The OS publish queue below is ordered by the same
	// sequence — a superseded publish is skipped instead of overwriting the
	// OS clipboard with stale paths.
	let clipboardRev = 0;
	let osPublishSeq = 0;
	let osPublishTail: Promise<void> = Promise.resolve();
	// When the last in-Clopen COPY happened, and whether its async OS publish
	// is still in flight. The publish runs in the background while the
	// internal clipboard is already set, so during this brief window the
	// native clipboard may still hold the PREVIOUS Explorer content. Paste
	// protects the newer internal copy only inside that window — afterwards
	// a differing native content is genuinely newer (user copied again in
	// Explorer) and wins. No OS content is ever cached: every paste reads
	// the native clipboard fresh (see tryReadOsClipboardItems).
	let lastInternalCopyAt = 0;
	let pendingPublishSeq = 0;
	// Grace window covering the async OS publish round-trip. Kept short so a
	// real follow-up Explorer copy is never shadowed for long.
	const INTERNAL_COPY_GRACE_MS = 2000;

	// Folders in the current multi-selection, in selection order. Used to
	// fan paste out to every chosen destination instead of just the first.
	function selectedDirectoryPaths(): string[] {
		const out: string[] = [];
		for (const p of selectedPaths) {
			const node = findFileInTree(projectFiles, p);
			if (node && node.type === 'directory' && !out.includes(node.path)) out.push(node.path);
		}
		return out;
	}

	// Publish Copy/Cut targets to the native OS clipboard (best-effort) so
	// they can be pasted with Ctrl+V in the native file manager. Ordered
	// through osPublishTail: concurrent publishes are serialized and a
	// superseded (older) request is skipped, so the OS clipboard always ends
	// up with the LATEST action — never a stale one finishing late.
	// The internal clipboard is always set first (synchronously in
	// doCopy/doCut), so in-app paste works instantly even while the OS
	// bridge is in flight. COPY publishes DROPEFFECT_COPY (sources stay);
	// CUT publishes DROPEFFECT_MOVE (Explorer itself performs the move).
	// Failures are swallowed deliberately and must never break copy/cut.
	function publishCopyToOsClipboardOrdered(paths: string[], seq: number, effect: 'copy' | 'move'): Promise<boolean> {
		const run = osPublishTail.then(async (): Promise<boolean> => {
			if (seq !== osPublishSeq) return false;
			try {
				await ws.http('files:copy-to-os-clipboard', { paths, effect });
				return true;
			} catch (error) {
				debug.debug('file', 'OS clipboard copy unavailable:', error);
				return false;
			}
		});
		// Keep the chain alive for the next COPY even if this one rejects.
		osPublishTail = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	// Shared copy/cut executors — the ONLY copy/cut logic. Both the context
	// menu (handleFileAction) and the keyboard shortcuts (Ctrl/Cmd+C/X) call
	// these, so both triggers behave identically and emit exactly one toast.
	// Clipboard assignment is SYNCHRONOUS so the very next paste always reads
	// the latest source — never a stale one. The OS bridge publish is async
	// and fires in the background (best-effort, failures swallowed).
	function doCopy(targets: FileNode[]): void {
		if (targets.length === 0) return;
		clipboardRev += 1;
		clipboard = { files: targets, operation: 'copy', origin: 'internal' };
		// Fire-and-forget: publish to native OS clipboard in the background.
		// The internal clipboard (used by in-app paste) is already set above.
		lastInternalCopyAt = Date.now();
		const seq = ++osPublishSeq;
		pendingPublishSeq = seq;
		void publishCopyToOsClipboardOrdered(
			targets.map((t) => t.path),
			seq,
			'copy'
		).then((osReady) => {
			// Only the latest COPY clears the in-flight flag: a superseded
			// publish must never mark a newer copy as done.
			if (seq === osPublishSeq) pendingPublishSeq = 0;
			const label = describeTargets(targets);
			notifyExplorer(
				'success',
				'Copied',
				osReady
					? `${label} — press ${explorerKeys.paste} in ${fileManagerName}`
					: `${label} copied to clipboard (${explorerKeys.copy})`
			);
		});
	}

	function doCut(targets: FileNode[]): void {
		if (targets.length === 0) return;
		clipboardRev += 1;
		clipboard = { files: targets, operation: 'cut', origin: 'internal' };
		// Fire-and-forget: publish with DROPEFFECT_MOVE in the background so
		// pasting in the native file manager performs a real move. Clopen
		// itself NEVER deletes the sources here — Explorer does the move, and
		// the file watcher then reflects the deletion. Exactly one toast,
		// like doCopy.
		const seq = ++osPublishSeq;
		pendingPublishSeq = seq;
		void publishCopyToOsClipboardOrdered(
			targets.map((t) => t.path),
			seq,
			'move'
		).then((osReady) => {
			if (seq === osPublishSeq) pendingPublishSeq = 0;
			notifyExplorer(
				'success',
				'Cut',
				osReady
					? `${describeTargets(targets)} — press ${explorerKeys.paste} in ${fileManagerName} to move`
					: `${describeTargets(targets)} cut to clipboard (${explorerKeys.cut})`
			);
		});
	}

	// Paste from the NATIVE file-manager clipboard (File Explorer / Finder).
	// A context-menu click carries no DataTransfer, and browsers cannot read
	// CF_HDROP / file URLs from script, so the backend reads the native
	// file-drop list on our behalf. Adopted entries become the internal
	// clipboard (COPY semantics — manager sources are never moved/deleted)
	// and flow through the shared pasteToDestinations(), so a paste from
	// outside Clopen behaves exactly like an internal paste: same
	// destinations, same "(1)" renaming, FILE stays FILE / FOLDER stays
	// FOLDER, and exactly one toast. Both the context-menu Paste and the
	// keyboard Ctrl+V/⌘V use the same adoption below for native
	// file-manager copies, so both triggers give identical results.
	function osClipboardItemsToStubs(items: { path: string; isDirectory: boolean }[]): FileNode[] {
		return items.map((item) => ({
			name: item.path.split(/[\\/]/).pop() || item.path,
			path: item.path,
			type: item.isDirectory ? 'directory' : 'file',
			size: 0,
			modified: new Date(),
			children: item.isDirectory ? [] : undefined
		}));
	}

	// Silent OS probe: same backend source as menu paste, but NEVER any
	// toast — callers decide whether empty means "warn" (explicit menu
	// paste) or "stay silent" (keyboard, where the DOM `paste` event still
	// owns screenshots/DataTransfer).
	async function tryReadOsClipboardItems(): Promise<{ path: string; isDirectory: boolean }[]> {
		if (!isLocalConnection()) return [];
		try {
			const res = await ws.http('files:read-os-clipboard', {});
			return res.items ?? [];
		} catch {
			return [];
		}
	}

	function normalizeOsPath(p: string): string {
		return p.replace(/\//g, '\\').toLowerCase();
	}

	// True when the native clipboard holds file paths that are NOT what the
	// internal clipboard already represents. CUT intent always wins (doCut
	// never publishes to the OS, so the OS content is unrelated to the
	// pending move and must not shadow it).
	function osItemsDifferFromClipboard(items: { path: string; isDirectory: boolean }[]): boolean {
		if (!clipboard || items.length === 0) return false;
		if (clipboard.operation !== 'copy') return false;
		if (clipboard.files.length !== items.length) return true;
		const current = new Set(clipboard.files.map((f) => normalizeOsPath(f.path)));
		for (const it of items) {
			if (!current.has(normalizeOsPath(it.path))) return true;
		}
		return false;
	}
	// Adopt a FRESH native-clipboard read as the paste source (COPY semantics).
	// The stored value is only ever a per-paste copy: the next paste re-reads
	// the native clipboard again, so a newer Explorer Ctrl+C is never
	// shadowed by a previous adoption. No OS content is cached here.
	function adoptOsItems(items: { path: string; isDirectory: boolean }[]): void {
		clipboardRev += 1;
		clipboard = { files: osClipboardItemsToStubs(items), operation: 'copy', origin: 'os' };
	}
	// Fresh native content vs an in-Clopen COPY that differs: the native side
	// wins UNLESS our own async OS publish is still in flight (or the COPY
	// just happened) — in that brief window the native side still holds the
	// PREVIOUS Explorer content, which must not shadow the newer copy.
	function shouldPreferInternalOverFreshOs(): boolean {
		if (pendingPublishSeq !== 0) return true;
		return Date.now() - lastInternalCopyAt < INTERNAL_COPY_GRACE_MS;
	}
	async function pasteFromOsClipboard(dests: string[]): Promise<void> {
		if (dests.length === 0 || !projectPath) return;
		let items: { path: string; isDirectory: boolean }[];
		try {
			const res = await ws.http('files:read-os-clipboard', {});
			items = res.items ?? [];
		} catch (error) {
			debug.error('file', 'Failed to read OS clipboard:', error);
			notifyExplorer('error', 'Paste Failed', errorMessage(error, 'Unknown error'));
			return;
		}
		if (items.length === 0) {
			notifyExplorer(
				'warning',
				'Clipboard Empty',
				`Copy files first in ${fileManagerName} (${explorerKeys.copy}), then paste here.`
			);
			return;
		}
		adoptOsItems(items);
		await pasteToDestinations(dests.map((base) => ({ base, expand: true })));
	}

	// ============================
	// Paste availability (single condition source)
	// ============================
	// isPasteAvailable() is the ONLY condition driving every Paste affordance
	// (context-menu row, paste-to-root button). Paste is offered when the
	// internal clipboard holds items OR the native OS clipboard holds
	// files/folders. Text/URL/image-only clipboards yield [] from the backend
	// reader, so Paste stays hidden for unsupported data. The OS side is
	// never cached stale: it refreshes on window focus / tab-visible (the
	// Explorer-Ctrl+C → back-to-Clopen flow) and on every context-menu open.
	let osClipboardHasFiles = $state(false);
	let osClipboardProbeId = 0;

	function isPasteAvailable(): boolean {
		return clipboard !== null || osClipboardHasFiles;
	}

	async function refreshOsClipboardState(): Promise<void> {
		if (!hasActiveProject || !isLocalConnection()) {
			// No project, or a remote session with no local OS clipboard.
			if (!isLocalConnection()) osClipboardHasFiles = false;
			return;
		}
		// Always probe (even with an internal entry): handlePaste compares
		// the native clipboard against the internal one, so this flag must
		// reflect the OS truth — e.g. a fresh Explorer Ctrl+C while an
		// internal COPY is still held.
		const id = ++osClipboardProbeId;
		try {
			const res = await ws.http('files:read-os-clipboard', {});
			if (id !== osClipboardProbeId) return;
			// Availability flag only — the item list itself is NEVER stored:
			// every paste re-reads the native clipboard fresh (see handlePaste).
			osClipboardHasFiles = (res.items ?? []).length > 0;
		} catch {
			if (id !== osClipboardProbeId) return;
			osClipboardHasFiles = false;
		}
	}

	// ============================
	// Unified paste entry (single handler)
	// ============================
	// handlePaste() is the ONLY paste entry: keyboard Ctrl+V/⌘V (hotkey leg
	// and `paste`-event leg), context-menu Paste, and the paste-to-root
	// button all funnel here. EVERY trigger reads the LIVE clipboard at call
	// time — no snapshots, no frozen sources — so a COPY that happened
	// immediately before a PASTE always uses the newest source.
	type PasteTrigger =
		| { kind: 'menu'; file: FileNode }
		| { kind: 'root' }
		| { kind: 'keyboard' }
		| { kind: 'os-event'; event: ClipboardEvent };

	async function handlePaste(trigger: PasteTrigger): Promise<void> {
		if (!hasActiveProject || !projectPath) return;
		// The `paste` DOM event carries OS data — its own implementation
		// (backend-read first, DataTransfer fallback) is preserved as-is.
		if (trigger.kind === 'os-event') {
			await handleOsPaste(trigger.event);
			return;
		}
		// Fresh native clipboard first (local sessions only). EVERY paste
		// re-reads the Windows clipboard directly — nothing cached, no
		// snapshot — so Copy A → Paste A, Copy B → Paste B, Copy C → Paste C.
		// A previous OS adoption is NEVER trusted: with origin 'os' the fresh
		// read always wins. An in-Clopen COPY (origin 'internal') wins only
		// while its async OS publish is still in flight (or just happened),
		// when the native side may still hold the previous Explorer content.
		// CUT always uses the internal clipboard (never published to the OS).
		// Adopted entries become the internal clipboard (COPY semantics) and
		// flow through the same pasteToDestinations() as everything else.
		if (isLocalConnection()) {
			const osItems = await tryReadOsClipboardItems();
			let useFreshOs = false;
			if (osItems.length > 0) {
				if (!clipboard) useFreshOs = true;
				else if (clipboard.operation !== 'copy') useFreshOs = false;
				else if (clipboard.origin === 'os') useFreshOs = true;
				else if (osItemsDifferFromClipboard(osItems)) {
					useFreshOs = !shouldPreferInternalOverFreshOs();
				}
			}
			if (useFreshOs) {
				adoptOsItems(osItems);
				if (trigger.kind === 'keyboard') lastInternalPasteAt = Date.now();
				if (trigger.kind === 'menu') {
					const dirs = selectedDirectoryPaths();
					const dests = dirs.length >= 2 ? dirs : [trigger.file.path];
					await pasteToDestinations(dests.map((base) => ({ base, expand: true })));
					return;
				}
				if (trigger.kind === 'root') {
					await pasteToBase(projectPath, null);
					return;
				}
				const dests = resolvePasteDestinations();
				const bases = dests.length > 0 ? dests : [projectPath];
				await pasteToDestinations(bases.map((base) => ({ base, expand: true })));
				return;
			}
		}
		// Internal clipboard (set synchronously by doCopy/doCut) always wins.
		// A keyboard paste always stamps the guard so the `paste` DOM event
		// firing right after this keydown cannot paste a second time.
		if (clipboard) {
			if (trigger.kind === 'menu') {
				await pasteFile(trigger.file);
				return;
			}
			if (trigger.kind === 'root') {
				await pasteToBase(projectPath, null);
				return;
			}
			lastInternalPasteAt = Date.now();
			await pasteViaKeyboard();
			return;
		}
		// No internal clipboard: menu/root go through pasteFromOsClipboard
		// (which sets the clipboard from the OS, then pastes it).
		if (trigger.kind === 'root') {
			await pasteFromOsClipboard([projectPath]);
			return;
		}
		if (trigger.kind === 'menu') {
			const dirs = selectedDirectoryPaths();
			await pasteFromOsClipboard(dirs.length >= 2 ? dirs : [trigger.file.path]);
			return;
		}
		// Keyboard with empty internal clipboard: peek the OS clipboard
		// silently (no toast when empty) and paste if files are found.
		// Falls through to the DOM `paste` event for screenshots/DataTransfer.
		const dests = resolvePasteDestinations();
		const bases = dests.length > 0 ? dests : [projectPath];
		try {
			const res = await ws.http('files:read-os-clipboard', {});
			const items = res.items ?? [];
			if (items.length > 0) {
				adoptOsItems(items);
				lastInternalPasteAt = Date.now();
				await pasteToDestinations(bases.map((base) => ({ base, expand: true })));
			}
		} catch {
			// Unavailable — let the DOM `paste` event handle DataTransfer.
		}
	}

	async function pasteFile(targetFolder: FileNode) {
		if (!clipboard) {
			const dirs = selectedDirectoryPaths();
			const dests = dirs.length >= 2 ? dirs : [targetFolder.path];
			await pasteFromOsClipboard(dests);
			return;
		}
		const selectedDirs = selectedDirectoryPaths();
		if (selectedDirs.length >= 2) {
			await pasteToDestinations(selectedDirs.map((base) => ({ base, expand: true })));
			return;
		}
		const basePath = targetFolder.type === 'directory'
			? targetFolder.path
			: (() => {
				const pathParts = targetFolder.path.split(/[\\/]/);
				pathParts.pop();
				return pathParts.join(targetFolder.path.includes('\\') ? '\\' : '/');
			})();

		await pasteToBase(basePath, targetFolder.type === 'directory' ? targetFolder.path : null);
	}

	async function pasteToRoot() {
		await handlePaste({ kind: 'root' });
	}

	// ============================
	// Paste with automatic duplicate naming
	// ============================
	// COPY never fails on duplicates and never asks for a name: the target
	// is always resolved via generateUniqueFilename (same style as uploads).
	// "Laporan PKL" -> "Laporan PKL (1)" -> "Laporan PKL (2)"; for files the
	// number goes before the extension ("laporan.docx" -> "laporan (1).docx").
	// Names are checked against items that already exist; existing items are
	// never overwritten. A folder keeps its type and its whole subtree is
	// copied with its structure intact — a FILE is pasted directly as a FILE,
	// never wrapped in a folder. CUT keeps exact targets (a move conflict is
	// reported, nothing is renamed or overwritten).
	function isBackendExistsError(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		const m = error.message;
		return (
			m.includes('already exists') ||
			m.includes('Target file already exists') ||
			m.includes('Destination path already exists') ||
			m.includes('Destination already exists') ||
			m.includes('EEXIST') ||
			m.includes(' 409') ||
			m.includes('(409)')
		);
	}

	// Builds the SINGLE notification for a paste action from the aggregated
	// per-destination outcomes. One paste action always yields one toast:
	// full success → success, partial (some items applied, some skipped or
	// failed) → warning, nothing applied → warning/error describing why.
	function notifyPasteOutcome(
		operation: 'copy' | 'cut',
		appliedTotal: number,
		selfNested: string[],
		skipped: string[],
		failed: string[],
		destErrors: string[]
	): void {
		const uniq = (arr: string[]): string[] => [...new Set(arr)];
		const shown = (arr: string[]): string => uniq(arr).slice(0, 3).join(', ');
		const more = (arr: string[]): string =>
			uniq(arr).length > 3 ? ` (+${uniq(arr).length - 3} more)` : '';
		const verb = operation === 'copy' ? 'Copied' : 'Moved';
		if (appliedTotal > 0 && selfNested.length === 0 && skipped.length === 0 && failed.length === 0 && destErrors.length === 0) {
			notifyExplorer('success', 'Pasted', `${verb} ${appliedTotal === 1 ? '1 item' : `${appliedTotal} items`}.`);
			return;
		}
		if (appliedTotal > 0) {
			const reasons: string[] = [];
			if (skipped.length > 0) reasons.push(`already exists: ${shown(skipped)}${more(skipped)}`);
			if (selfNested.length > 0) reasons.push(`cannot paste a folder into itself: ${shown(selfNested)}${more(selfNested)}`);
			if (failed.length > 0) reasons.push(`failed: ${shown(failed)}${more(failed)}`);
			if (destErrors.length > 0) reasons.push(`destination error: ${shown(destErrors)}${more(destErrors)}`);
			notifyExplorer('warning', 'Partially Pasted', `${verb} ${appliedTotal === 1 ? '1 item' : `${appliedTotal} items`} (${reasons.join('; ')}).`);
			return;
		}
		if (selfNested.length > 0) {
			notifyExplorer('warning', 'Paste Cancelled', `Cannot paste a folder into itself: ${shown(selfNested)}${more(selfNested)}.`);
			return;
		}
		if (skipped.length > 0) {
			notifyExplorer('warning', 'Paste Cancelled', `Item already exists at the destination: ${shown(skipped)}${more(skipped)}.`);
			return;
		}
		if (failed.length > 0) {
			notifyExplorer('error', 'Paste Failed', `Unable to paste the item: ${shown(failed)}${more(failed)}.`);
			return;
		}
		if (destErrors.length > 0) {
			notifyExplorer('error', 'Paste Failed', `Unable to paste into: ${shown(destErrors)}${more(destErrors)}.`);
			return;
		}
		notifyExplorer('warning', 'Nothing Pasted', 'Items are already at this location.');
	}

	type PasteOutcome = { applied: number; failed: string[]; skipped: string[]; selfNested: string[] };

	// Core paste into ONE folder: no toasts/alerts. Every item is processed
	// independently — a failing item is recorded in the outcome and the batch
	// continues with the next item, so one bad file never stops the rest.
	// Only a transport-level failure (e.g. loadProjectFiles throwing) escapes
	// to the multi-destination driver, which isolates it per folder.
	type ClipboardType = { files: FileNode[]; operation: 'copy' | 'cut'; origin: 'internal' | 'os' };
	async function applyPasteToBase(basePath: string, source?: ClipboardType): Promise<PasteOutcome> {
		const empty: PasteOutcome = { applied: 0, failed: [], skipped: [], selfNested: [] };
		// Snapshot the source at entry: a concurrent COPY/CUT mid-paste must
		// never redirect the remaining destinations to the newer clipboard.
		// Callers pass the paste-entry snapshot; direct callers fall back to
		// the live clipboard for backward compatibility.
		const active = source ?? clipboard;
		if (!active || active.files.length === 0) return empty;
		const { files: sourceFiles, operation } = active;
		// OS-adopted sources may live outside every project (Desktop,
		// Downloads, …), which the plain files:duplicate guard rejects with
		// "Access denied" — the backend root cause behind menu-Paste failing
		// after an Explorer Ctrl+C. Route them through
		// files:duplicate-from-outside instead (target stays access-guarded,
		// COPY-only, sources never moved/deleted).
		const duplicateRoute =
			active.origin === 'os' ? 'files:duplicate-from-outside' : 'files:duplicate';
		const sep = basePath.includes('\\') ? '\\' : '/';

		// A folder must never be pasted into itself or its descendant.
		// CUT pasting an item onto its own path is a silent no-op; CUT move
		// conflicts keep exact targets and are reported (never renamed).
		// COPY targets are resolved per item at apply time via
		// generateUniqueFilename so same-name multi-copy
		// (a/file.txt + b/file.txt) also serializes to file.txt, file (1).txt.
		const selfNested: string[] = [];
		const skipped: string[] = [];
		const planned: FileNode[] = [];
		for (const sourceFile of sourceFiles) {
			if (
				sourceFile.type === 'directory' &&
				(basePath === sourceFile.path || basePath.startsWith(`${sourceFile.path}${sep}`))
			) {
				selfNested.push(sourceFile.name);
				continue;
			}
			if (operation === 'cut') {
				const targetPath = `${basePath}${sep}${sourceFile.name}`;
				if (targetPath === sourceFile.path) continue;
				if (findFileInTree(projectFiles, targetPath)) {
					skipped.push(sourceFile.name);
					continue;
				}
			}
			planned.push(sourceFile);
		}
		if (planned.length === 0) {
			// Nothing to apply (all no-ops or move conflicts). The clipboard
			// is kept so the items can be pasted at another location.
			return { applied: 0, failed: [], skipped, selfNested };
		}

		let applied = 0;
		const failed: string[] = [];
		for (const sourceFile of planned) {
			if (operation === 'copy') {
				// Auto-rename against everything already in the tree,
				// including items pasted earlier in this same batch.
				// Prefer the fresh tree node; fall back to the clipboard
				// entry itself so OS-adopted stubs (outside the tree) still
				// render optimistically with the right type.
				const freshNode = findFileInTree(projectFiles, sourceFile.path) ?? sourceFile;
				let targetPath = generateUniqueFilename(basePath, sourceFile.name);
				// Optimistic copy — langsung muncul tanpa refresh (SSOT add, guard duplikat).
				pendingFsMutations += 1;
				addCopiedNodeToTree(freshNode, targetPath);
				try {
					await ws.http(duplicateRoute, { sourcePath: sourceFile.path, targetPath });
					pendingFsMutations = Math.max(0, pendingFsMutations - 1);
				} catch (err) {
					// Roll back the optimistic node so there is no ghost item.
					projectFiles = removeNodeFromTree(projectFiles, targetPath);
					pendingFsMutations = Math.max(0, pendingFsMutations - 1);
					if (!isBackendExistsError(err)) {
						// One bad item must never stop the rest of the batch:
						// record it and continue with the next item instead of
						// throwing out of the whole destination loop.
						debug.error('file', 'Failed to paste item, continuing batch:', { source: sourceFile.path, error: err });
						failed.push(sourceFile.name);
						continue;
					}
					// Stale tree: the name looked free locally but exists on
					// disk. Re-sync with disk truth once and retry with a
					// fresh unique name instead of failing. A non-exists
					// error on retry is recorded and the batch continues —
					// it must never throw out of the destination loop.
					let done = false;
					for (let attempt = 0; attempt < 2 && !done; attempt++) {
						await loadProjectFiles(true);
						targetPath = generateUniqueFilename(basePath, sourceFile.name);
						pendingFsMutations += 1;
						addCopiedNodeToTree(findFileInTree(projectFiles, sourceFile.path) ?? sourceFile, targetPath);
						try {
							await ws.http(duplicateRoute, { sourcePath: sourceFile.path, targetPath });
							pendingFsMutations = Math.max(0, pendingFsMutations - 1);
							done = true;
						} catch (retryErr) {
							projectFiles = removeNodeFromTree(projectFiles, targetPath);
							pendingFsMutations = Math.max(0, pendingFsMutations - 1);
							if (!isBackendExistsError(retryErr)) {
								debug.error('file', 'Failed to paste item on retry, continuing batch:', { source: sourceFile.path, error: retryErr });
								break;
							}
						}
					}
					if (!done) {
						failed.push(sourceFile.name);
						continue;
					}
				}
			} else {
				const targetPath = `${basePath}${sep}${sourceFile.name}`;
				// Optimistic move — langsung pindah tanpa refresh (SSOT: tree + rebase).
				pendingFsMutations += 1;
				projectFiles = moveNodeInTree(projectFiles, sourceFile.path, targetPath);
				rebaseAllPathState(sourceFile.path, targetPath);
				try {
					await ws.http('files:rename', { oldPath: sourceFile.path, newPath: targetPath });
				} catch (err) {
					// Roll back via SSOT yang sama agar tidak hilang/duplikat.
					projectFiles = moveNodeInTree(projectFiles, targetPath, sourceFile.path);
					rebaseAllPathState(targetPath, sourceFile.path);
					pendingFsMutations = Math.max(0, pendingFsMutations - 1);
					if (isBackendExistsError(err)) {
						skipped.push(sourceFile.name);
						continue;
					}
					// Same batch rule as copy above: isolate the failure,
					// keep moving the remaining items.
					debug.error('file', 'Failed to move item, continuing batch:', { source: sourceFile.path, error: err });
					failed.push(sourceFile.name);
					continue;
				}
				pendingFsMutations = Math.max(0, pendingFsMutations - 1);
			}
			applied += 1;
		}
		return { applied, failed, skipped, selfNested };
	}

	// Paste into EVERY chosen destination. COPY fans out to all folders;
	// CUT (a move consumes its sources) only targets the first one. Each
	// destination is isolated: unexpected failure in one never stops the
	// others. Duplicate names resolve per destination via the upload-style
	// "(1)" naming; FILE stays FILE and FOLDER stays FOLDER everywhere.
	// Explorer updates optimistically per item (no full reload): nodes appear
	// instantly via addCopiedNodeToTree/moveNodeInTree.
	// Captures the clipboard snapshot at entry so every destination pastes
	// the SAME source even if a concurrent COPY/CUT replaces the clipboard
	// mid-paste. The identity guard below still detects that replacement so
	// a concurrent COPY is never wiped by cut-consumption.
	async function pasteToDestinations(dests: { base: string; expand: boolean }[]): Promise<void> {
		if (!clipboard || dests.length === 0) return;
		// Capture the clipboard reference at entry. The whole paste uses the
		// entry snapshot (passed to applyPasteToBase), while the
		// cut-consumption guard below compares live identity to detect a
		// concurrent COPY/CUT (e.g. user did COPY while a CUT paste was in
		// flight — the cut source must NOT be wiped).
		const source = clipboard;
		const { operation, origin } = clipboard;
		const snapshot: ClipboardType = { files: [...source.files], operation, origin };
		const targets = operation === 'copy' ? dests : dests.slice(0, 1);
		const uniq = (arr: string[]): string[] => [...new Set(arr)];
		const selfNestedAll: string[] = [];
		const skippedAll: string[] = [];
		const failedAll: string[] = [];
		const destErrors: string[] = [];
		let appliedTotal = 0;
		let expandedChanged = false;
		for (const { base, expand } of targets) {
			try {
				const outcome = await applyPasteToBase(base, snapshot);
				appliedTotal += outcome.applied;
				selfNestedAll.push(...outcome.selfNested);
				skippedAll.push(...outcome.skipped);
				failedAll.push(...outcome.failed);
				if (expand && !expandedFolders.has(base)) {
					expandedFolders.add(base);
					expandedChanged = true;
				}
			} catch (error) {
				debug.error('file', 'Failed to paste:', error);
				destErrors.push(base.split(/[\\/]/).pop() || base);
			}
		}
		if (expandedChanged) expandedFolders = new Set(expandedFolders);

		if (operation === 'cut' && appliedTotal > 0) {
			// Consume the CUT source only if no newer COPY/CUT replaced it
			// mid-paste — otherwise a concurrent COPY would be wiped out and
			// the next PASTE would wrongly fall back to stale state.
			if (clipboard === source) {
				clipboardRev += 1;
				clipboard = null;
				clearSelection();
				// The cut sources are consumed: re-probe the OS clipboard so the
				// Paste affordance reflects what is truly still pasteable.
				void refreshOsClipboardState();
			}
		}
		if (origin === 'os') {
			// OS-adopted entries arrive with shallow children: re-sync the
			// tree once the whole batch lands so Explorer shows disk truth
			// (full subtrees, exact names). Internal pastes already carry
			// fresh tree nodes, so they keep the lighter optimistic path.
			try {
				await loadProjectFiles(true);
			} catch (error) {
				debug.error('file', 'Post-paste tree sync failed (watcher covers):', error);
			}
		}
		// Exactly one notification per paste action (success and failure alike).
		notifyPasteOutcome(operation, appliedTotal, uniq(selfNestedAll), uniq(skippedAll), uniq(failedAll), uniq(destErrors));
	}

	async function pasteToBase(basePath: string, expandFolder: string | null) {
		await pasteToDestinations([{ base: basePath, expand: expandFolder !== null }]);
	}

	// ============================
	// Keyboard Shortcuts (Ctrl/Cmd+C/X/V)
	// ============================
	// Reuses the internal clipboard + pasteToBase() above — no backend changes.
	// Single handler for all platforms: `ctrlKey || metaKey` covers Ctrl on
	// Windows/Linux and Cmd on macOS in one branch, so it can never fire twice.

	// Paths currently marked as "cut" — visual feedback only (FileTree/FileNode).
	const cutPaths = $derived(
		clipboard?.operation === 'cut'
			? new Set(clipboard.files.map((f) => f.path))
			: new Set<string>()
	);

	function getParentDir(filePath: string): string | null {
		const parts = filePath.split(/[\\/]/);
		if (parts.length <= 1) return null;
		parts.pop();
		const parent = parts.join(filePath.includes('\\') ? '\\' : '/');
		return parent || null;
	}

	// "Current folder" fallback — ONLY for an empty selection (no explicit
	// destination). Never used when the user selected folders: those are
	// returned verbatim by resolvePasteDestinations() below.
	function getActiveFolderPath(): string {
		const candidates: (string | null)[] = [
			activeTabPath ? (getParentDir(activeTabPath) ?? null) : null,
			displayFile ? (getParentDir(displayFile.path) ?? null) : null,
			selectionAnchor ? (getParentDir(selectionAnchor) ?? null) : null
		];
		for (const candidate of candidates) {
			if (!candidate) continue;
			if (candidate === projectPath) return candidate;
			const node = findFileInTree(projectFiles, candidate);
			if (node && node.type === 'directory') return candidate;
		}
		return projectPath;
	}

	function resolveClipboardTargets(): FileNode[] {
		if (selectedPaths.size > 0) {
			const nodes = Array.from(selectedPaths)
				.map((p) => findFileInTree(projectFiles, p))
				.filter((n): n is FileNode => n !== null);
			if (nodes.length > 0) return nodes;
		}
		if (activeTabPath) {
			const activeNode = findFileInTree(projectFiles, activeTabPath);
			if (activeNode) return [activeNode];
		}
		if (displayFile) {
			const displayNode = findFileInTree(projectFiles, displayFile.path);
			if (displayNode) return [displayNode];
		}
		return [];
	}

	// Single source of truth for paste destinations. ROOT CAUSE FIX: the old
	// resolveKeyboardPasteBase() returned getActiveFolderPath() — the PARENT
	// of the anchor/active tab — for every multi-select case that did not hit
	// the dirs>=2 fast path (dirs==0, stale tree, mixed files). That is why a
	// paste with 2 selected folders landed in the PARENT folder. Explicit
	// selection now always wins:
	// - 1+ folders selected → those folders verbatim (never their parent).
	// - only files selected → parent of the selected file(s), never the
	//   active tab's folder and never root unless that parent IS root.
	// - empty selection → current-folder heuristic (active file's parent),
	//   fallback to project root. This is the ONLY path allowed to use it.
	function resolvePasteDestinations(): string[] {
		if (!projectPath) return [];
		const dirs = selectedDirectoryPaths();
		if (dirs.length > 0) return dirs;
		if (selectedPaths.size > 0) {
			for (const p of selectedPaths) {
				const node = findFileInTree(projectFiles, p);
				if (node && node.type === 'file') {
					return [getParentDir(node.path) ?? projectPath];
				}
			}
			const anchor = selectionAnchor ?? Array.from(selectedPaths)[0];
			if (anchor) return [getParentDir(anchor) ?? projectPath];
			return [projectPath];
		}
		return [getActiveFolderPath()];
	}

	// Single folder selected → that folder. Single file → its parent.
	// Multi-select / unclear → explicit selection first (resolvePasteDestinations),
	// never the active-folder parent heuristic. Root is only returned when it
	// really is the destination (empty selection at root / explicit root).
	function resolveKeyboardPasteBase(): string | null {
		if (!projectPath) return null;
		if (selectedPaths.size === 1) {
			const only = Array.from(selectedPaths)[0];
			const node = findFileInTree(projectFiles, only);
			if (node) {
				if (node.type === 'directory') return node.path;
				return getParentDir(node.path) ?? projectPath;
			}
			return getParentDir(only) ?? projectPath;
		}
		const dests = resolvePasteDestinations();
		return dests.length > 0 ? dests[0] : null;
	}

	async function pasteViaKeyboard(): Promise<void> {
		if (!clipboard) return;
		const dests = resolvePasteDestinations();
		if (dests.length === 0) return;
		if (dests.length >= 2) {
			await pasteToDestinations(dests.map((base) => ({ base, expand: true })));
			return;
		}
		const base = dests[0];
		const isRoot = base === projectPath;
		await pasteToBase(base, isRoot ? null : base);
	}

	function isEditableTarget(el: HTMLElement | null): boolean {
		if (!el) return false;
		const tag = el.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
		if (el.isContentEditable) return true;
		if (
			el.closest(
				'input,textarea,select,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],.monaco-editor,.cm-editor,.cm-content,.xterm,.xterm-screen,[data-terminal],.terminal,[role="dialog"],[role="alertdialog"],.modal,[data-dialog],[data-command-palette]'
			)
		)
			return true;
		return false;
	}

	// Strict scope: only handle when the user is interacting with the file
	// tree — never the editor side, terminal, search inputs, or open dialogs.
	// DOM focus alone is not reliable here: in 1-column mode opening a file
	// hides the tree, so focus falls back to <body>. Instead, track where the
	// last pointer interaction happened (capture phase, so nothing can block
	// it) and accept <body>-focused keys only when the tree was clicked last.
	let pointerInTree = false;

	function trackPointerSide(event: PointerEvent): void {
		const t = event.target as HTMLElement | null;
		pointerInTree = !!(t && treeScrollContainer && treeScrollContainer.contains(t));
	}

	// True when the user selected readable text outside the tree (e.g. in the
	// markdown preview). Copy/cut/select-all must keep the native text
	// behavior then.
	function hasTextSelectionOutsideTree(): boolean {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
		const anchor = sel.anchorNode as Node | null;
		if (!anchor) return false;
		const el = anchor instanceof Element ? anchor : anchor.parentElement;
		if (el && treeScrollContainer && treeScrollContainer.contains(el)) return false;
		return true;
	}

	function shouldHandleExplorerShortcut(event: KeyboardEvent, key: string): boolean {
		if (dialogOpen || compressDialogOpen || passwordDialogOpen || closeAllUnsavedDialogOpen)
			return false;
		const target = event.target as HTMLElement | null;
		if (isEditableTarget(target)) return false;
		const active = document.activeElement as HTMLElement | null;
		if (active && active !== document.body && isEditableTarget(active)) return false;
		const inTree = !!(target && treeScrollContainer && treeScrollContainer.contains(target));
		if (!inTree) {
			// Focus sits outside the tree (typically <body> after opening a
			// file hid the tree in 1-column mode). Only continue when the last
			// click was inside the tree and focus isn't on another widget.
			if (!pointerInTree) return false;
			if (target !== document.body && target !== document.documentElement) return false;
			if ((key === 'c' || key === 'x' || key === 'a') && hasTextSelectionOutsideTree()) return false;
		}
		return true;
	}

	function handleExplorerKeydown(event: KeyboardEvent): void {
		if (!hasActiveProject || !projectPath) return;
		const key = event.key.toLowerCase();

		// Delete / Backspace (no modifier): native parity — File Explorer
		// deletes with Delete, Finder with Delete/Backspace (Cmd+Backspace
		// also works there, but plain Backspace must stay navigational on
		// Windows, so it is mac-only here). Same pipeline as the menu Delete.
		if (key === 'delete' || (key === 'backspace' && explorerIsMac)) {
			if (!shouldHandleExplorerShortcut(event, 'delete')) return;
			if (selectedPaths.size === 0) return;
			event.preventDefault();
			event.stopPropagation();
			void runExplorerAction('delete', null);
			return;
		}

		// F2 renames, like the native manager. Shares startRename() with the
		// context-menu Rename item: same dialog, same single toast on confirm.
		if (key === 'f2') {
			if (!shouldHandleExplorerShortcut(event, 'f2')) return;
			event.preventDefault();
			event.stopPropagation();
			startRename(null);
			return;
		}

		// OS-specific modifier: Command (never Ctrl) on macOS, Ctrl (never
		// Command) on Windows/Linux — matching Finder vs File Explorer.
		// Alt/Shift variants (e.g. Ctrl+Shift+V) are intentionally ignored.
		if (!isExplorerMod(event)) return;
		if (key !== 'c' && key !== 'x' && key !== 'v' && key !== 'a') return;
		if (!shouldHandleExplorerShortcut(event, key)) return;

		// Select all visible rows, like Ctrl+A / ⌘A in the native manager.
		// Shared with the context-menu item (selectAllVisible): selection-only
		// change, no toast (not a mutating action).
		if (key === 'a') {
			event.preventDefault();
			event.stopPropagation();
			selectAllVisible();
			return;
		}

		// Context menu and keyboard share one action pipeline: copy/cut/paste
		// ALL funnel through runExplorerAction(), so keyboard shortcuts run
		// the exact same logic and emit the same single toast as the menu
		// items. Ctrl+V always funnels here (even with an empty internal
		// clipboard) so the OS peek runs in the same handler; when nothing
		// is pasted handlePaste leaves lastInternalPasteAt untouched and the
		// DOM `paste` event below still owns screenshots/DataTransfer.
		if (key === 'c' || key === 'x') {
			event.preventDefault();
			event.stopPropagation();
			void runExplorerAction(key === 'c' ? 'copy' : 'cut', null);
			return;
		}

		if (key === 'v') {
			event.preventDefault();
			event.stopPropagation();
			void runExplorerAction('paste', null);
		}
	}

	// ============================
	// OS Clipboard Paste (file manager / screenshots)
	// ============================
	// Files copied outside Clopen never touch keydown — browsers expose them
	// on the `paste` event instead. This reuses uploadFilesTo() (the same path
	// as drag&drop-from-OS) and the keyboard paste destination, so Ctrl+V /
	// ⌘V from the native file manager lands where an internal paste would
	// land. Right-click menu Paste (no DataTransfer there) uses the backend
	// `files:read-os-clipboard` round-trip instead — see pasteFromOsClipboard.
	// Guards mirror the keyboard shortcuts: editors, terminals, chats, inputs
	// and dialogs keep their own paste behavior; plain text paste is ignored.
	let lastInternalPasteAt = 0;

	function collectOsPasteFiles(event: ClipboardEvent): File[] {
		const dt = event.clipboardData;
		if (!dt) return [];
		const files = Array.from(dt.files);
		if (files.length > 0) return files;
		// Screenshots / copied bitmaps may arrive as image items only.
		const out: File[] = [];
		if (dt.items) {
			for (const item of Array.from(dt.items)) {
				if (item.kind !== 'file') continue;
				const f = item.getAsFile();
				if (!f) continue;
				out.push(f.name ? f : new File([f], `pasted-image-${Date.now()}.png`, { type: f.type || 'image/png' }));
			}
		}
		return out;
	}

	// DOM `paste` listener leg of the unified handlePaste(): the browser
	// delivers outside-Clopen copies (and screenshots) through this event.
	function handlePasteDomEvent(event: ClipboardEvent): void {
		void handlePaste({ kind: 'os-event', event });
	}

	async function handleOsPaste(event: ClipboardEvent): Promise<void> {
		if (!hasActiveProject || !projectPath) return;
		// An internal paste just ran from the Ctrl+V keydown that precedes
		// this event — don't paste twice.
		if (Date.now() - lastInternalPasteAt < 1000) return;
		if (dialogOpen || compressDialogOpen || passwordDialogOpen || closeAllUnsavedDialogOpen)
			return;
		const target = event.target as HTMLElement | null;
		if (isEditableTarget(target)) return;
		const active = document.activeElement as HTMLElement | null;
		if (active && active !== document.body && isEditableTarget(active)) return;
		const dt = event.clipboardData;
		if (!dt) return;
		const inTree = !!(target && treeScrollContainer && treeScrollContainer.contains(target));
		if (!inTree) {
			if (!pointerInTree) return;
			if (target !== document.body && target !== document.documentElement) return;
		}
		// Same destination rule as internal paste: every explicitly selected
		// folder is a destination. The old single-base call collapsed a
		// 2-folder selection into getActiveFolderPath() (their PARENT).
		const dests = resolvePasteDestinations();
		const bases = dests.length > 0 ? dests : [projectPath];
		// Same source as Context Menu Paste: prefer the native file-drop list
		// (File Explorer / Finder copies) via the backend, so keyboard Ctrl+V
		// and right-click → Paste share one handler and produce identical
		// results. Screenshots/bitmap data have no file paths, and remote
		// sessions have no local clipboard — an empty or failed read falls
		// through to the DataTransfer path below.
		if (isLocalConnection()) {
			try {
				const res = await ws.http('files:read-os-clipboard', {});
				const osItems = res.items ?? [];
				if (osItems.length > 0) {
					event.preventDefault();
					event.stopPropagation();
					adoptOsItems(osItems);
					await pasteToDestinations(bases.map((base) => ({ base, expand: true })));
					return;
				}
			} catch (error) {
				debug.debug('file', 'OS clipboard read unavailable, using paste event data:', error);
			}
		}
		// Folders first (needs async traversal); falls back to flat files.
		const tree = await collectOsPasteTree(dt);
		if (tree && (tree.dirs.length > 0 || tree.files.length > 0)) {
			event.preventDefault();
			event.stopPropagation();
			try {
				let pastedTotal = 0;
				const failedAll: { name: string; reason: string }[] = [];
				let firstDirName: string | null = null;
				let onlyOneDir = false;
				for (const base of bases) {
					try {
						const result = await uploadOsPasteTree(base, tree);
						pastedTotal += result.createdDirs + result.acceptedFiles;
						failedAll.push(...result.failedFiles);
						if (firstDirName === null && result.dirNames.length > 0) {
							firstDirName = result.dirNames[0];
							onlyOneDir = result.createdDirs === 1 && result.acceptedFiles === 0;
						}
					} catch (error) {
						debug.error('file', 'Failed to paste folder to destination, continuing batch:', { base, error });
						failedAll.push({ name: base.split(/[\\/]/).pop() || base, reason: errorMessage(error, 'Could not paste the folder.') });
					}
				}
				// Exactly one notification for the whole OS paste action.
				if (failedAll.length === 0) {
					if (pastedTotal > 0) {
						notifyExplorer('success', 'Pasted', pastedTotal === 1
							? (onlyOneDir && firstDirName ? `Pasted folder "${firstDirName}".` : `Pasted "${tree.files[0]?.file.name ?? 'item'}".`)
							: `Pasted ${pastedTotal} items.`);
					}
				} else if (pastedTotal > 0) {
					notifyExplorer('warning', 'Partially Pasted', `Pasted ${pastedTotal} items (${failedAll.length} failed: ${failedAll.slice(0, 3).map((f) => f.name).join(', ')}).`);
				} else {
					notifyExplorer('error', 'Paste Failed', failedAll[0]?.reason || 'Could not paste the items.');
				}
			} catch (error) {
				debug.error('file', 'Failed to paste folder:', error);
				notifyExplorer('error', 'Paste Failed', errorMessage(error, 'Unknown error'));
			}
			return;
		}
		const files = collectOsPasteFiles(event);
		if (files.length === 0) return;
		// Duplicates auto-rename via uploadFilesTo() (same "(1)" style as
		// internal paste) — never rejected, never overwritten.
		event.preventDefault();
		event.stopPropagation();
		let uploadedTotal = 0;
		const failedAll: { name: string; reason: string }[] = [];
		for (const base of bases) {
			try {
				const result = await uploadFilesTo(files, base);
				uploadedTotal += result.uploaded;
				failedAll.push(...result.failed);
			} catch (error) {
				debug.error('file', 'Failed to upload paste to destination, continuing batch:', { base, error });
				failedAll.push({ name: base.split(/[\\/]/).pop() || base, reason: errorMessage(error, 'Could not paste the files.') });
			}
		}
		// Exactly one notification for the whole OS paste action.
		if (failedAll.length === 0) {
			notifyExplorer('success', 'Pasted', files.length === 1 ? `Pasted "${files[0].name}".` : `Pasted ${files.length} files.`);
		} else if (uploadedTotal > 0) {
			notifyExplorer('warning', 'Partially Pasted', `Pasted ${uploadedTotal} files (${failedAll.length} failed).`);
		} else {
			notifyExplorer('error', 'Paste Failed', failedAll[0]?.reason || 'Could not paste the files.');
		}
	}

	// ============================
	// OS Folder Paste (directory traversal via FileSystem API)
	// ============================
	// A folder copied in Windows Explorer arrives as directory entries, not
	// flat files — DataTransfer.files alone would silently drop it. We walk
	// the entries (Chrome/Edge; other browsers fall back to the flat path)
	// and recreate the structure, reusing uploadFilesTo() per directory. The
	// backend auto-creates parent dirs on upload; only empty folders need an
	// explicit create. Name clashes auto-rename ("Laporan PKL" becomes
	// "Laporan PKL (1)" with its whole subtree), matching internal paste —
	// existing items are never merged into, overwritten, or skipped.
	interface PastedTreeFile {
		dir: string; // '/'-separated path relative to the paste base ('' = base)
		file: File;
	}

	function pasteEntryOf(item: DataTransferItem): FileSystemEntry | null {
		const anyItem = item as DataTransferItem & {
			getAsEntry?: () => FileSystemEntry | null;
			webkitGetAsEntry?: () => FileSystemEntry | null;
		};
		try {
			return anyItem.getAsEntry?.() ?? anyItem.webkitGetAsEntry?.() ?? null;
		} catch {
			return null;
		}
	}

	function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
		return new Promise((resolve, reject) => {
			const out: FileSystemEntry[] = [];
			const pump = () => {
				// readEntries must be called repeatedly until it returns [].
				reader.readEntries(
					(batch) => {
						if (batch.length === 0) resolve(out);
						else {
							out.push(...batch);
							pump();
						}
					},
					reject
				);
			};
			pump();
		});
	}

	function entryAsFile(entry: FileSystemFileEntry): Promise<File> {
		return new Promise((resolve, reject) => entry.file(resolve, reject));
	}

	// Nama sampah OS yang boleh diabaikan saat menilai pola folder-dari-file.
	function isOsJunkName(name: string): boolean {
		if (name.startsWith('.')) return true;
		const lower = name.toLowerCase();
		return lower === 'desktop.ini' || lower === 'thumbs.db';
	}

	async function walkPasteEntry(
		entry: FileSystemEntry,
		relDir: string,
		dirs: string[],
		files: PastedTreeFile[]
	): Promise<void> {
		if (entry.isDirectory) {
			const reader = (entry as FileSystemDirectoryEntry).createReader();
			const children = await readDirectoryEntries(reader);
			// Defensif: sejumlah sumber clipboard melaporkan FILE sebagai folder
			// yang berisi dirinya sendiri ("nama.docx"/"nama.docx"). Runtuhkan
			// kembali menjadi file biasa — jangan pernah membuat folder bernama
			// seperti file. Sampah tersembunyi (desktop.ini, thumbs.db, dotfile)
			// diabaikan saat menilai pola ini. Pola sah (folder berisi file
			// beda nama, beberapa file, atau subfolder) tetap disalin apa adanya.
			const meaningful = children.filter((c) => !isOsJunkName(c.name));
			// Compare NFC-normalized: the same visible name may arrive in a
			// different Unicode normalization than the entry itself.
			if (
				meaningful.length === 1 &&
				meaningful[0].isFile &&
				meaningful[0].name.normalize('NFC') === entry.name.normalize('NFC') &&
				/\.[A-Za-z0-9]{1,6}$/.test(entry.name)
			) {
				const parentRel = relDir.includes('/') ? relDir.slice(0, relDir.lastIndexOf('/')) : '';
				files.push({ dir: parentRel, file: await entryAsFile(meaningful[0] as FileSystemFileEntry) });
				return;
			}
		dirs.push(relDir);
		for (const child of children) {
			// ROOT CAUSE FIX: relDir adalah PARENT dir untuk FILE, tapi path
			// DIR itu sendiri untuk FOLDER. Versi lama selalu menambahkan
			// child.name sehingga file "Laporan PKL/ABSENSI.docx" mendapat
			// dir="Laporan PKL/ABSENSI.docx" dan upload membuat folder
			// bernama file berisi file yang sama. FILE harus langsung
			// memakai relDir induknya; hanya FOLDER yang menambah nama.
			if (child.isDirectory) {
				await walkPasteEntry(child, relDir ? `${relDir}/${child.name}` : child.name, dirs, files);
			} else {
				await walkPasteEntry(child, relDir, dirs, files);
			}
		}
		} else if (entry.isFile) {
			files.push({ dir: relDir, file: await entryAsFile(entry as FileSystemFileEntry) });
		}
	}

	async function collectOsPasteTree(dt: DataTransfer): Promise<{ dirs: string[]; files: PastedTreeFile[] } | null> {
		if (!dt.items) return null;
		const entries: FileSystemEntry[] = [];
		for (const item of Array.from(dt.items)) {
			if (item.kind !== 'file') continue;
			const entry = pasteEntryOf(item);
			if (entry) entries.push(entry);
		}
		// No folders involved — the caller keeps the flat-file fast path.
		if (!entries.some((e) => e.isDirectory)) return null;
		const dirs: string[] = [];
		const files: PastedTreeFile[] = [];
		for (const entry of entries) {
			if (entry.isDirectory) {
				await walkPasteEntry(entry, entry.name, dirs, files);
			} else if (entry.isFile) {
				files.push({ dir: '', file: await entryAsFile(entry as FileSystemFileEntry) });
			}
		}
		return { dirs, files };
	}

	function treeParentFor(targetAbs: string): string | null {
		const parts = targetAbs.split(/[\\/]/);
		parts.pop();
		const parent = parts.join(targetAbs.includes('\\') ? '\\' : '/');
		return parent === projectPath || parent === '' ? null : parent;
	}

	async function uploadOsPasteTree(
		base: string,
		tree: { dirs: string[]; files: PastedTreeFile[] }
	): Promise<{ createdDirs: number; acceptedFiles: number; dirNames: string[]; failedFiles: { name: string; reason: string }[] }> {
		const sep = base.includes('\\') ? '\\' : '/';
		const joinBase = (rel: string): string => (rel ? `${base}${sep}${rel.split('/').join(sep)}` : base);
		const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
		// 1. Directories: a colliding folder is created under a fresh unique
		//    name ("Laporan PKL" -> "Laporan PKL (1)") and its whole subtree
		//    follows the renamed parent via `remap`. Existing folders are
		//    never merged into and nothing is ever skipped or overwritten.
		const remap = new Map<string, string>(); // original rel -> actual rel
		const ordered = [...tree.dirs].sort((a, b) => a.split('/').length - b.split('/').length);
		const dirNames: string[] = [];
		let createdDirs = 0;
		for (const rel of ordered) {
			const leaf = rel.split('/').pop() || rel;
			const parentNew = remap.get(parentOf(rel)) ?? parentOf(rel);
			const parentAbs = joinBase(parentNew);
			let targetAbs = generateUniqueFilename(parentAbs, leaf);
			const optimisticLeaf = targetAbs.split(/[\\/]/).pop() || leaf;
			// Optimistic dir — langsung muncul tanpa refresh (SSOT add).
			pendingFsMutations += 1;
			projectFiles = addNodeToTree(
				projectFiles,
				treeParentFor(targetAbs),
				{ name: optimisticLeaf, path: targetAbs, type: 'directory', size: 0, modified: new Date(), children: [] }
			);
			try {
				await ws.http('files:create-directory', { dirPath: targetAbs });
				pendingFsMutations = Math.max(0, pendingFsMutations - 1);
			} catch (err) {
				// Stale tree but already on disk: re-sync once and retry with
				// a fresh unique name. Other errors go to the general alert.
				if (!isBackendExistsError(err)) {
					projectFiles = removeNodeFromTree(projectFiles, targetAbs);
					pendingFsMutations = Math.max(0, pendingFsMutations - 1);
					throw err;
				}
				projectFiles = removeNodeFromTree(projectFiles, targetAbs);
				await loadProjectFiles(true);
				targetAbs = generateUniqueFilename(parentAbs, leaf);
				projectFiles = addNodeToTree(
					projectFiles,
					treeParentFor(targetAbs),
					{ name: targetAbs.split(/[\\/]/).pop() || leaf, path: targetAbs, type: 'directory', size: 0, modified: new Date(), children: [] }
				);
				try {
					await ws.http('files:create-directory', { dirPath: targetAbs });
					pendingFsMutations = Math.max(0, pendingFsMutations - 1);
				} catch (retryErr) {
					projectFiles = removeNodeFromTree(projectFiles, targetAbs);
					pendingFsMutations = Math.max(0, pendingFsMutations - 1);
					throw retryErr;
				}
			}
			const newLeaf = targetAbs.split(/[\\/]/).pop() || leaf;
			remap.set(rel, parentNew ? `${parentNew}/${newLeaf}` : newLeaf);
			dirNames.push(newLeaf);
			createdDirs += 1;
		}
		const remapDir = (rel: string): string => {
			if (!rel) return '';
			// Longest remapped-prefix wins so nested files follow renames.
			const parts = rel.split('/');
			for (let i = parts.length; i >= 1; i--) {
				const prefix = parts.slice(0, i).join('/');
				const mapped = remap.get(prefix);
				if (mapped !== undefined) {
					const rest = parts.slice(i).join('/');
					if (!rest) return mapped;
					return mapped ? `${mapped}/${rest}` : rest;
				}
			}
			return rel;
		};
		// 2. Files: grouped by their (possibly renamed) directory.
		//    uploadFilesTo() auto-renames per-file collisions, so a FILE is
		//    never turned into a folder and never overwrites anything.
		const byDir = new Map<string, File[]>();
		for (const f of tree.files) {
			const newDir = remapDir(f.dir);
			const list = byDir.get(newDir) ?? [];
			list.push(f.file);
			byDir.set(newDir, list);
		}
		let acceptedFiles = 0;
		const failedFiles: { name: string; reason: string }[] = [];
		for (const [rel, list] of byDir) {
			// Silent per-group upload — failures aggregate into failedFiles so
			// the caller can emit the single notification for the whole action.
			const outcome = await uploadFilesTo(list, joinBase(rel));
			acceptedFiles += outcome.uploaded;
			failedFiles.push(...outcome.failed);
		}
		if (base !== projectPath && !expandedFolders.has(base)) {
			expandedFolders.add(base);
			expandedFolders = new Set(expandedFolders);
		}
		return { createdDirs, acceptedFiles, dirNames, failedFiles };
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

	async function handleFileOpen(filePath: string, target?: { line: number; column?: number; length?: number }) {
		let file = findFileInTree(projectFiles, filePath);
		if (!file) {
			const fileName = filePath.split(/[/\\]/).pop() || 'Untitled';
			file = { name: fileName, path: filePath, type: 'file', size: 0, modified: new Date() };
		}
		openFileInTab(file, target);
	}

	// Single action pipeline for the whole explorer: every context-menu item
	// AND every keyboard shortcut funnels through here, so both triggers run
	// the same logic and emit the same single toast. `file` is the
	// right-clicked node for menu triggers, or null for keyboard triggers
	// (targets then resolve from the current selection, same as before).
	type ExplorerAction =
		| 'copy' | 'cut' | 'paste'
		| 'copy-path' | 'copy-relative-path'
		| 'rename' | 'duplicate' | 'delete' | 'select-all'
		| 'new-file' | 'new-folder' | 'upload'
		| 'refresh' | 'zip' | 'extract' | 'download'
		| 'reveal-in-file-manager';

	async function runExplorerAction(action: ExplorerAction, file: FileNode | null): Promise<void> {
		switch (action) {
			case 'copy-path': {
				if (!file) return;
				try {
					await navigator.clipboard.writeText(file.path);
					notifyExplorer('success', 'Copied', `Copied path "${file.name}".`);
				} catch (err) {
					notifyExplorer('error', 'Copy Failed', errorMessage(err, 'Could not copy the path.'));
				}
				break;
			}
			case 'copy-relative-path': {
				if (!file) return;
				let relativePath = file.path;
				if (projectPath && file.path.startsWith(projectPath)) {
					relativePath = file.path.substring(projectPath.length);
					if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
						relativePath = relativePath.substring(1);
					}
				}
				try {
					await navigator.clipboard.writeText(relativePath);
					notifyExplorer('success', 'Copied', `Copied relative path "${relativePath}".`);
				} catch (err) {
					notifyExplorer('error', 'Copy Failed', errorMessage(err, 'Could not copy the path.'));
				}
				break;
			}
			case 'rename':
				startRename(file);
				break;
			case 'select-all':
				selectAllVisible();
				break;
			case 'copy':
				await doCopy(file ? getActionTargets(file) : resolveClipboardTargets());
				break;
			case 'cut':
				doCut(file ? getActionTargets(file) : resolveClipboardTargets());
				break;
			case 'paste':
				if (file) await handlePaste({ kind: 'menu', file });
				else await handlePaste({ kind: 'keyboard' });
				break;
			case 'new-file':
				if (file) openDialog('new-file', undefined, file.type === 'directory' ? file.path : null);
				break;
			case 'new-folder':
				if (file) openDialog('new-folder', undefined, file.type === 'directory' ? file.path : null);
				break;
			case 'duplicate':
				if (file) await duplicateFile(file);
				break;
			case 'delete': {
				const targets = file ? getActionTargets(file) : resolveClipboardTargets();
				if (targets.length > 0) await deleteFiles(targets);
				break;
			}
			case 'refresh':
				await refreshAll();
				break;
			case 'upload':
				if (file && file.type === 'directory') triggerUpload(file.path);
				break;
			case 'zip': {
				if (!file) return;
				const targets = getActionTargets(file);
				if (targets.length > 0) {
					compressTargets = targets;
					compressDialogOpen = true;
				}
				break;
			}
			case 'extract':
				if (file && file.type === 'file') await extractZip(file);
				break;
			case 'download':
				if (file && file.type === 'file') await downloadFileNode(file);
				break;
			case 'reveal-in-file-manager':
				if (!file) return;
				try {
					await ws.http('files:reveal-in-file-manager', { path: file.path });
					notifyExplorer('success', 'Revealed', `Revealed "${file.name}" in file manager.`);
				} catch (err) {
					notifyExplorer('error', 'Reveal Failed', errorMessage(err, 'Failed to open file manager'));
				}
				break;
		}
	}

	function handleFileAction(action: string, file: FileNode) {
		void runExplorerAction(action as ExplorerAction, file);
	}

	// Download a file from the sidebar context menu. Streams the on-disk bytes
	// over HTTP and saves them client-side, preserving the original format.
	// It takes the same banner as an upload: a big file used to give no sign of
	// movement at all, then simply appear on the device.
	async function downloadFileNode(file: FileNode) {
		const opId = crypto.randomUUID();
		const controller = new AbortController();
		// Deliberately not `markBusy` — that greys the row out and blocks it, which
		// is right for a mutation but wrong for a read: the file is still openable
		// while its bytes are being copied. The banner carries the feedback.
		pushOp({
			id: opId,
			kind: 'download',
			label: `Downloading ${file.name}`,
			progress: 0,
			onCancel: () => controller.abort()
		});

		try {
			const blob = await fetchFileBlob(file.path, {
				totalBytes: file.size ?? null,
				signal: controller.signal,
				onProgress: ({ transferredBytes, totalBytes }) => {
					updateOp(opId, {
						label: totalBytes
							? `Downloading ${file.name} (${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)})`
							: `Downloading ${file.name} (${formatBytes(transferredBytes)})`,
						// Undefined leaves the banner on its indeterminate spinner,
						// which is honest when the total is unknown.
						progress: totalBytes ? transferredBytes / totalBytes : undefined
					});
				}
			});
			saveBlob(blob, file.name);
			notifyExplorer('success', 'Downloaded', `Downloaded "${file.name}".`);
		} catch (err) {
			if (isAbortError(err)) return;
			notifyExplorer('error', 'Download Failed', errorMessage(err, 'Failed to download file'));
		} finally {
			popOp(opId);
		}
	}

	async function deleteFiles(files: FileNode[]) {
		if (files.length === 0) return;

		const confirmMessage = files.length === 1
			? (files[0].type === 'directory'
				? `Are you sure you want to delete the folder "${files[0].name}" and all its contents?`
				: `Are you sure you want to delete "${files[0].name}"?`)
			: `Are you sure you want to delete ${files.length} items?`;

		const confirmed = await showConfirm({
			title: files.length === 1 && files[0].type === 'directory' ? 'Delete Folder' : (files.length === 1 ? 'Delete File' : 'Delete Items'),
			message: confirmMessage,
			type: 'error',
			confirmText: 'Delete',
			cancelText: 'Cancel'
		});
		if (!confirmed) return;

		let deleted = 0;
		let failedName: string | null = null;
		let failedReason = '';
		for (const file of files) {
			try {
				const deletedNode = findFileInTree(projectFiles, file.path);
				// Optimistic delete — langsung hilang tanpa refresh (SSOT).
				pendingFsMutations += 1;
				projectFiles = removeNodeFromTree(projectFiles, file.path);
				pruneAllPathStateForDelete(file.path);

				try {
					await ws.http('files:delete', { filePath: file.path, force: file.type === 'directory' });
				} catch (err) {
					// Roll back via SSOT yang sama (parentForAdd agar root ikut pulih).
					if (deletedNode) {
						projectFiles = addNodeToTree(projectFiles, parentForAdd(file.path), deletedNode);
					}
					throw err;
				} finally {
					pendingFsMutations = Math.max(0, pendingFsMutations - 1);
				}
				deleted += 1;
			} catch (error) {
				debug.error('file', 'Failed to delete file:', error);
				failedName = file.name;
				failedReason = errorMessage(error, 'Unknown error');
				break;
			}
		}
		// SSOT prune di atas sudah membersihkan selection/expanded/clipboard
		// untuk target yang dihapus — tanpa refresh manual.
		// Exactly one notification for the whole delete action.
		if (failedName !== null) {
			notifyExplorer('error', 'Delete Failed', `Could not delete "${failedName}": ${failedReason}`);
		} else {
			notifyExplorer('success', 'Deleted', deleted === 1 ? `Deleted "${files[0].name}" (${explorerKeys.deleteKey}).` : `Deleted ${deleted} items (${explorerKeys.deleteKey}).`);
		}
	}

	async function duplicateFile(file: FileNode) {
		const pathParts = file.path.split(/[\\/]/);
		const fileName = pathParts.pop() || file.name;
		const parentPath = pathParts.join(file.path.includes('\\') ? '\\' : '/');
		const targetPath = generateUniqueFilename(parentPath, fileName);
		// Optimistic UI — langsung muncul tanpa refresh (SSOT duplicate).
		pendingFsMutations += 1;
		projectFiles = duplicateNodeInTree(projectFiles, file.path, targetPath);
		try {
			await ws.http('files:duplicate', { sourcePath: file.path, targetPath });
			// Folder hasil duplicate optimistis bisa shallow — sinkron latar
			// agar subtree penuh tanpa refresh manual.
			if (file.type === 'directory') syncTreeWithDisk();
		} catch (error) {
			debug.error('file', 'Failed to duplicate file:', error);
			// Roll back node optimistis yang sama (no hilang/duplikat, no reload).
			projectFiles = removeNodeFromTree(projectFiles, targetPath);
			notifyExplorer('error', 'Duplicate Failed', errorMessage(error, 'Unknown error'));
			return;
		} finally {
			pendingFsMutations = Math.max(0, pendingFsMutations - 1);
		}
		notifyExplorer('success', 'Duplicated', `Duplicated "${file.name}" as "${targetPath.split(/[\\/]/).pop() || file.name}".`);
	}

	function createNewFileInRoot() {
		openDialog('new-file', undefined, null);
	}

	function createNewFolderInRoot() {
		openDialog('new-folder', undefined, null);
	}

	// ============================
	// Busy state — per-path counters so concurrent ops on the same node
	// don't clear each other prematurely. `rootBusyOps` covers operations
	// targeting the project root (where there is no file node to spinner).
	// `activeOps` drives the top-of-tree banner so the user has a clearly
	// visible indicator even when the affected node is collapsed or
	// scrolled out of view.
	//
	// IMPORTANT: Plain Map/Set are NOT made reactive by $state() in Svelte 5
	// — we have to use SvelteMap so mutations notify the UI.
	// ============================

	const busyOps = new SvelteMap<string, number>();
	const busyPaths = $derived(new Set(busyOps.keys()));
	let rootBusyOps = $state(0);
	const isRootBusy = $derived(rootBusyOps > 0);

	type ActiveOp = {
		id: string;
		kind: 'upload' | 'download' | 'zip' | 'extract';
		label: string;
		progress?: number; // 0–1, only set for transfers that report bytes
		// Present only for ops that can be stopped mid-flight (transfers);
		// its presence is what puts a cancel button on the banner row.
		onCancel?: () => void;
	};
	const activeOps = new SvelteMap<string, ActiveOp>();
	const activeOpsList = $derived(Array.from(activeOps.values()));

	function pushOp(op: ActiveOp): void {
		activeOps.set(op.id, op);
	}
	function updateOp(id: string, patch: Partial<ActiveOp>): void {
		const existing = activeOps.get(id);
		if (!existing) return;
		activeOps.set(id, { ...existing, ...patch });
	}
	function popOp(id: string): void {
		activeOps.delete(id);
	}

	function markBusy(path: string, delta: 1 | -1): void {
		const current = busyOps.get(path) ?? 0;
		const next = current + delta;
		if (next <= 0) {
			busyOps.delete(path);
		} else {
			busyOps.set(path, next);
		}
	}

	// ============================
	// Upload
	// ============================

	let uploadInputRef = $state<HTMLInputElement | null>(null);
	let uploadTargetDir = $state<string>('');

	function triggerUpload(targetDir: string) {
		uploadTargetDir = targetDir || projectPath;
		uploadInputRef?.click();
	}

	function triggerUploadToRoot() {
		triggerUpload(projectPath);
	}

	async function handleUploadInputChange(event: Event) {
		const input = event.target as HTMLInputElement;
		if (!input.files || input.files.length === 0) return;
		await doUploadFiles(input.files, uploadTargetDir);
		input.value = '';
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	// HTTP upload via /api/files/upload. The WS path used to wedge on the Vite
	// dev proxy (`write EPIPE`) on sustained binary transfers; HTTP through the
	// same proxy streams cleanly. XHR is used so we can drive a real progress
	// bar via `upload.onprogress`. finalName sudah dipesan via
	// generateUniqueFilename oleh pemanggil agar node optimistis dan nama di
	// disk selalu sama (no duplikat, langsung muncul).
	async function uploadSingleFileHttp(file: File, targetDir: string, finalName: string, finalPath: string, opId: string, fileIndex: number, total: number): Promise<{ finalName: string; finalPath: string } | null> {
		updateOp(opId, {
			label: total === 1
				? `Uploading ${finalName} (${formatBytes(file.size)})`
				: `Uploading ${fileIndex + 1}/${total}: ${finalName} (${formatBytes(file.size)})`,
			progress: 0
		});

		const token = authStore.sessionToken;
		if (!token) throw new Error('Not authenticated');

		const params = new URLSearchParams({
			targetPath: targetDir,
			fileName: finalName,
			fileSize: String(file.size)
		});

		return await new Promise<{ finalName: string; finalPath: string }>((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open('POST', `/api/files/upload?${params.toString()}`);
			xhr.setRequestHeader('Authorization', `Bearer ${token}`);
			xhr.responseType = 'text';

			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable && e.total > 0) {
					updateOp(opId, { progress: e.loaded / e.total });
				}
			};

			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					updateOp(opId, { progress: 1 });
					resolve({ finalName, finalPath });
				} else {
					const msg = (xhr.responseText || '').trim();
					reject(new Error(msg || `Upload failed (HTTP ${xhr.status})`));
				}
			};
			xhr.onerror = () => reject(new Error('Network error during upload'));
			xhr.onabort = () => reject(new Error('Upload aborted'));

			xhr.send(file);
		});
	}

	type UploadOutcome = { uploaded: number; failed: { name: string; reason: string }[] };

	// Silent batch uploader: performs the transfer + progress banner + tree
	// updates, but emits NO toast itself. Every caller wraps it in a shared
	// single-notification step (doUploadFiles / OS paste / folder-tree paste),
	// so one upload action always yields exactly one toast.
	async function uploadFilesTo(files: FileList | File[], targetDir: string): Promise<UploadOutcome> {
		const none: UploadOutcome = { uploaded: 0, failed: [] };
		if (!targetDir) return none;
		const list = Array.from(files);
		if (list.length === 0) return none;

		const isRoot = targetDir === projectPath;
		if (isRoot) {
			rootBusyOps += 1;
		} else {
			markBusy(targetDir, 1);
		}

		const opId = crypto.randomUUID();
		pushOp({
			id: opId,
			kind: 'upload',
			label: list.length === 1 ? `Uploading ${list[0].name}` : `Uploading ${list.length} files`,
			progress: 0
		});

		const outcome: UploadOutcome = { uploaded: 0, failed: [] };
		pendingFsMutations += 1;
		try {
			for (let i = 0; i < list.length; i++) {
				const f = list[i];
				// Pesan nama dulu + tampilkan node SEBELUM transfer agar upload
				// langsung muncul tanpa refresh. Batch berikutnya melihat node
				// ini sehingga auto-rename "(1)" tetap benar (no duplikat).
				const targetFullPath = generateUniqueFilename(targetDir, f.name);
				const finalName = targetFullPath.split(/[\\/]/).pop() || f.name;
				const parentForAdd = targetDir === projectPath ? null : targetDir;
				const newNode: FileNode = {
					name: finalName,
					path: targetFullPath,
					type: 'file',
					size: f.size,
					modified: new Date()
				};
				projectFiles = addNodeToTree(projectFiles, parentForAdd, newNode);
				if (parentForAdd && !expandedFolders.has(parentForAdd)) {
					expandedFolders.add(parentForAdd);
					expandedFolders = new Set(expandedFolders);
				}
				try {
					await uploadSingleFileHttp(f, targetDir, finalName, targetFullPath, opId, i, list.length);
					outcome.uploaded += 1;
				} catch (error) {
					// Roll back node optimistis agar gagal upload tidak menyisakan ghost.
					projectFiles = removeNodeFromTree(projectFiles, targetFullPath);
					debug.error('file', 'Failed to upload file:', error);
					outcome.failed.push({ name: f.name, reason: errorMessage(error, 'Upload failed') });
				}
			}
		} finally {
			pendingFsMutations = Math.max(0, pendingFsMutations - 1);
			popOp(opId);
			if (isRoot) {
				rootBusyOps = Math.max(0, rootBusyOps - 1);
			} else {
				markBusy(targetDir, -1);
			}
		}
		return outcome;
	}

	// Shared upload completion step: exactly one toast per upload action.
	function notifyUploadOutcome(total: number, uploaded: number, failed: { name: string; reason: string }[]): void {
		if (failed.length === 0) {
			notifyExplorer('success', 'Uploaded', total === 1 ? 'Uploaded 1 file.' : `Uploaded ${uploaded} files.`);
			return;
		}
		if (uploaded > 0) {
			notifyExplorer('warning', 'Partially Uploaded', `Uploaded ${uploaded} of ${total} files (failed: ${failed.slice(0, 3).map((f) => f.name).join(', ')}).`);
			return;
		}
		notifyExplorer('error', 'Upload Failed', failed[0]?.reason || 'Could not upload the files.');
	}

	// Upload entry used by the file picker, drag-and-drop, and any other
	// direct upload trigger: transfer (silent) + exactly one toast.
	async function doUploadFiles(files: FileList | File[], targetDir: string): Promise<void> {
		const list = Array.from(files);
		if (list.length === 0 || !targetDir) return;
		const outcome = await uploadFilesTo(files, targetDir);
		notifyUploadOutcome(list.length, outcome.uploaded, outcome.failed);
	}

	// ============================
	// Zip / Extract
	// ============================

	interface CompressOptions {
		format: ArchiveFormat;
		method?: ZipMethod;
		level?: number;
		password?: string;
	}

	function onCompressConfirm(options: CompressOptions) {
		const targets = compressTargets;
		compressDialogOpen = false;
		compressTargets = [];
		void zipFiles(targets, options);
	}

	async function zipFiles(targets: FileNode[], options: CompressOptions) {
		if (targets.length === 0) return;
		const first = targets[0];
		const parts = first.path.split(/[\\/]/);
		parts.pop();
		const sep = first.path.includes('\\') ? '\\' : '/';
		const parentPath = parts.length > 0 ? parts.join(sep) : projectPath;
		const ext = extensionFor(options.format);
		const baseName = targets.length === 1 ? `${targets[0].name}${ext}` : `archive${ext}`;
		const targetPath = generateUniqueFilename(parentPath, baseName);
		const targetName = targetPath.split(/[\\/]/).pop() || baseName;

		const busyTargets = targets.map((t) => t.path);
		for (const p of busyTargets) markBusy(p, 1);
		const opId = crypto.randomUUID();
		pushOp({
			id: opId,
			kind: 'zip',
			label: targets.length === 1
				? `Compressing ${targets[0].name} → ${targetName}`
				: `Compressing ${targets.length} items → ${targetName}`
		});
		// Optimistic UI (same SSOT helpers as every other action): the archive
		// appears instantly; the reload below reconciles it with disk truth.
		const zipTreeParent = !parentPath || parentPath === projectPath ? null : parentPath;
		pendingFsMutations += 1;
		projectFiles = addNodeToTree(projectFiles, zipTreeParent, {
			name: targetName,
			path: targetPath,
			type: 'file',
			size: 0,
			modified: new Date()
		});
		try {
			await ws.http(
				'files:zip',
				{
					sourcePaths: targets.map((t) => t.path),
					targetPath,
					format: options.format,
					method: options.method,
					level: options.level,
					password: options.password
				},
				// Compression can take a while for big trees — give it room.
				300_000
			);
			// Watcher will pick the new archive up; explicitly refresh for snappier UI.
			await loadProjectFiles(true);
			notifyExplorer('success', 'Compressed', `Created archive "${targetName}".`);
		} catch (error) {
			debug.error('file', 'Failed to create archive:', error);
			// Roll back the optimistic node so a failed compress leaves no ghost file.
			projectFiles = removeNodeFromTree(projectFiles, targetPath);
			notifyExplorer('error', 'Compress Failed', errorMessage(error, 'Compress failed'));
		} finally {
			pendingFsMutations = Math.max(0, pendingFsMutations - 1);
			popOp(opId);
			for (const p of busyTargets) markBusy(p, -1);
		}
	}

	async function extractZip(file: FileNode) {
		const parts = file.path.split(/[\\/]/);
		const fileName = parts.pop() || file.name;
		const sep = file.path.includes('\\') ? '\\' : '/';
		const parentPath = parts.length > 0 ? parts.join(sep) : projectPath;
		const baseName = stripArchiveExtension(fileName) || 'extracted';
		const targetDir = generateUniqueFilename(parentPath, baseName);
		const targetName = targetDir.split(/[\\/]/).pop() || baseName;

		// Optimistic UI (same SSOT helpers as every other action): the
		// destination folder appears instantly; reloads below reconcile it.
		const extractTreeParent = !parentPath || parentPath === projectPath ? null : parentPath;
		pendingFsMutations += 1;
		projectFiles = addNodeToTree(projectFiles, extractTreeParent, {
			name: targetName,
			path: targetDir,
			type: 'directory',
			size: 0,
			modified: new Date(),
			children: []
		});

		// Retry loop: encrypted archives surface a clean error, prompt for the
		// password, then re-run with it (re-prompting on a wrong password).
		let password: string | undefined;
		for (;;) {
			markBusy(file.path, 1);
			const opId = crypto.randomUUID();
			pushOp({
				id: opId,
				kind: 'extract',
				label: `Extracting ${fileName} → ${targetName}`
			});
			try {
				await ws.http(
					'files:extract',
					{
						archivePath: file.path,
						targetDir,
						password
					},
					300_000
				);
				await loadProjectFiles(true);
				pendingFsMutations = Math.max(0, pendingFsMutations - 1);
				notifyExplorer('success', 'Extracted', `Extracted "${fileName}" to "${targetName}".`);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Extract failed';
				if (/password-protected|incorrect password/i.test(message)) {
					const entered = await promptPassword(/incorrect password/i.test(message));
					if (!entered) {
						// Cancelled by user: silent, but remove the optimistic
						// folder so no ghost entry remains.
						projectFiles = removeNodeFromTree(projectFiles, targetDir);
						pendingFsMutations = Math.max(0, pendingFsMutations - 1);
						return;
					}
					password = entered;
					continue;
				}
				debug.error('file', 'Failed to extract archive:', error);
				projectFiles = removeNodeFromTree(projectFiles, targetDir);
				pendingFsMutations = Math.max(0, pendingFsMutations - 1);
				notifyExplorer('error', 'Extract Failed', message);
				return;
			} finally {
				popOp(opId);
				markBusy(file.path, -1);
			}
		}
	}

	// ============================
	// Drag-and-Drop (move + OS upload)
	// ============================

	const DND_MIME = 'application/x-clopen-fileops';
	let dropTargetPath = $state<string | null>(null);
	let isRootDropTarget = $state(false);

	function getDragPaths(file: FileNode): string[] {
		if (selectedPaths.has(file.path) && selectedPaths.size > 1) {
			return Array.from(selectedPaths);
		}
		return [file.path];
	}

	function onNodeDragStart(file: FileNode, event: DragEvent) {
		const paths = getDragPaths(file);
		if (!selectedPaths.has(file.path)) {
			selectedPaths = new Set([file.path]);
			selectionAnchor = file.path;
		}
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData(DND_MIME, JSON.stringify({ paths }));
			event.dataTransfer.setData('text/plain', paths.join('\n'));
		}
	}

	function hasInternalDrag(event: DragEvent): boolean {
		return event.dataTransfer ? Array.from(event.dataTransfer.types).includes(DND_MIME) : false;
	}

	function hasOSFiles(event: DragEvent): boolean {
		return event.dataTransfer ? Array.from(event.dataTransfer.types).includes('Files') : false;
	}

	function onNodeDragOver(file: FileNode, event: DragEvent) {
		if (file.type !== 'directory') return;
		if (!hasInternalDrag(event) && !hasOSFiles(event)) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = hasInternalDrag(event) ? 'move' : 'copy';
		}
		dropTargetPath = file.path;
		isRootDropTarget = false;
	}

	function onNodeDragLeave(file: FileNode, _event: DragEvent) {
		if (dropTargetPath === file.path) {
			dropTargetPath = null;
		}
	}

	async function onNodeDrop(file: FileNode, event: DragEvent) {
		if (file.type !== 'directory') return;
		event.preventDefault();
		event.stopPropagation();
		dropTargetPath = null;
		isRootDropTarget = false;

		if (hasOSFiles(event) && event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
			await doUploadFiles(event.dataTransfer.files, file.path);
			return;
		}

		if (hasInternalDrag(event) && event.dataTransfer) {
			try {
				const raw = event.dataTransfer.getData(DND_MIME);
				const payload = JSON.parse(raw) as { paths: string[] };
				await moveNodesTo(payload.paths, file.path);
			} catch (err) {
				debug.error('file', 'Drop parse failed:', err);
				notifyExplorer('error', 'Move Failed', 'Could not read the dropped items.');
			}
		}
	}

	function onNodeDragEnd(_file: FileNode, _event: DragEvent) {
		dropTargetPath = null;
		isRootDropTarget = false;
	}

	function onRootDragOver(event: DragEvent) {
		if (!hasInternalDrag(event) && !hasOSFiles(event)) return;
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = hasInternalDrag(event) ? 'move' : 'copy';
		}
		isRootDropTarget = true;
	}

	function onRootDragLeave(_event: DragEvent) {
		isRootDropTarget = false;
	}

	async function onRootDrop(event: DragEvent) {
		event.preventDefault();
		isRootDropTarget = false;
		dropTargetPath = null;

		if (hasOSFiles(event) && event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
			await doUploadFiles(event.dataTransfer.files, projectPath);
			return;
		}

		if (hasInternalDrag(event) && event.dataTransfer) {
			try {
				const raw = event.dataTransfer.getData(DND_MIME);
				const payload = JSON.parse(raw) as { paths: string[] };
				await moveNodesTo(payload.paths, projectPath);
			} catch (err) {
				debug.error('file', 'Root drop parse failed:', err);
				notifyExplorer('error', 'Move Failed', 'Could not read the dropped items.');
			}
		}
	}

	async function moveNodesTo(sourcePaths: string[], targetDirPath: string) {
		const sep = targetDirPath.includes('\\') ? '\\' : '/';
		let moved = 0;
		for (const src of sourcePaths) {
			if (src === targetDirPath) continue;
			// Reject moving a folder into itself or its descendant
			if (targetDirPath === src || targetDirPath.startsWith(`${src}${sep}`)) {
				const name = src.split(/[\\/]/).pop() || src;
				notifyExplorer('warning', 'Move Cancelled', `Cannot move "${name}" into itself or its descendant.`);
				return;
			}
			// No-op when already in target
			const srcParts = src.split(/[\\/]/);
			srcParts.pop();
			const srcParent = srcParts.join(sep);
			if (srcParent === targetDirPath) continue;

			const name = src.split(/[\\/]/).pop() || '';
			const targetPath = generateUniqueFilename(targetDirPath, name);

			// Optimistic move — langsung pindah tanpa refresh (SSOT: tree + rebase).
			pendingFsMutations += 1;
			projectFiles = moveNodeInTree(projectFiles, src, targetPath);
			rebaseAllPathState(src, targetPath);
			try {
				await ws.http('files:rename', { oldPath: src, newPath: targetPath });
				moved += 1;
			} catch (err) {
				// Roll back via SSOT yang sama (termasuk tab turunan folder).
				projectFiles = moveNodeInTree(projectFiles, targetPath, src);
				rebaseAllPathState(targetPath, src);
				pendingFsMutations = Math.max(0, pendingFsMutations - 1);
				notifyExplorer('error', 'Move Failed', errorMessage(err, 'Move failed'));
				return;
			}
			pendingFsMutations = Math.max(0, pendingFsMutations - 1);
		}
		// SSOT rebase di atas sudah menggeser selection mengikuti path baru.
		// Exactly one notification for the whole move action.
		if (moved > 0) {
			notifyExplorer('success', 'Moved', moved === 1 ? 'Moved 1 item.' : `Moved ${moved} items.`);
		} else {
			notifyExplorer('warning', 'Nothing Moved', 'Items are already in this folder.');
		}
	}

	// Save file with optimistic-concurrency protection.
	// Sends the disk mtime the tab is based on; the backend rejects the write
	// if the file changed underneath us, so a stale buffer can't silently
	// clobber newer on-disk content. If the tab is already flagged as changed
	// externally, the user has been warned — this save is an explicit overwrite,
	// so we omit the base token to force it through.
	async function saveFile(filePath: string, content: string) {
		const tab = openTabs.find(t => t.file.path === filePath);
		const forcing = tab?.externallyChanged === true;
		const baseModified = forcing ? undefined : tab?.savedMtime;

		try {
			const res = await ws.http('files:write-file', { filePath, content, baseModified });
			openTabs = openTabs.map(t =>
				t.file.path === filePath
					? { ...t, savedContent: content, savedMtime: res.modified, externallyChanged: false }
					: t
			);
			// No longer dirty — drop any preserved unsaved buffer.
			clearUnsavedBuffer(projectPath, filePath);
			if (filePath === activeTabPath) {
				displaySavedContent = content;
				displayExternallyChanged = false;
			}
		} catch (err) {
			if (isWriteConflict(err)) {
				// Disk diverged — surface the "Changed externally" badge so the
				// user can reload or deliberately overwrite, and rethrow so the
				// editor keeps the unsaved buffer instead of marking it clean.
				openTabs = openTabs.map(t =>
					t.file.path === filePath
						? { ...t, externallyChanged: true }
						: t
				);
				if (filePath === activeTabPath) {
					displayExternallyChanged = true;
				}
			}
			throw err;
		}
	}

	function isWriteConflict(err: unknown): boolean {
		return err instanceof Error && err.message.includes('FILE_CONFLICT');
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
	// Reconciliation
	// ============================

	// Re-establish the truth of the panel against disk: reload the tree and
	// re-sync every open tab. Push events (the file watcher) are best-effort —
	// the OS can drop them under bursts and watchers can go silently deaf — so
	// this is the self-healing path, invoked both on watcher events and when the
	// window/tab regains focus. Unsaved edits are never overwritten: a diverged
	// file is flagged `externallyChanged` instead.
	async function reconcile(
		changes: Array<{ path: string; type: 'created' | 'modified' | 'deleted'; timestamp: string }> = [],
		allowClose = false
	) {
		await loadProjectFiles(true);

		const tabsSnapshot = [...openTabs];
		for (const tab of tabsSnapshot) {
			const hasUnsavedChanges = tab.currentContent !== tab.savedContent;

			if (hasUnsavedChanges) {
				// Tab has unsaved changes — check if the file changed externally,
				// but keep the user's buffer intact regardless.
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

			// Tab has no unsaved changes — auto-sync from disk.
			const success = await loadTabContent(tab.file.path);
			if (!success) {
				// File no longer exists — try to detect a rename within the same
				// parent directory (only possible when we have change hints).
				const tabDir = tab.file.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
				const renameTarget = changes.find(c => {
					if (c.type !== 'created') return false;
					const cDir = c.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
					return cDir === tabDir;
				});

				if (renameTarget) {
					const newPath = renameTarget.path;
					const newName = newPath.split(/[\\/]/).pop() || tab.file.name;
					const oldPath = tab.file.path;

					openTabs = openTabs.map(t =>
						t.file.path === oldPath
							? { ...t, file: { ...t.file, path: newPath, name: newName } }
							: t
					);
					if (activeTabPath === oldPath) {
						activeTabPath = newPath;
					}

					await loadTabContent(newPath);
				} else if (allowClose) {
					// No rename target and a watcher event told us the tree changed —
					// the file was truly deleted, so drop the tab. We don't close on
					// the focus safety-net path, where a failed read could just be a
					// transient reconnect rather than a real deletion.
					closeTab(tab.file.path);
				}
			}
		}
	}

	// Debounced safety-net reconcile (used by focus/visibility), separate from
	// the watcher-event debounce so they don't cancel each other.
	let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleReconcile() {
		if (!hasActiveProject || !projectId || !projectPath) return;
		if (reconcileTimer) clearTimeout(reconcileTimer);
		reconcileTimer = setTimeout(() => {
			reconcileTimer = null;
			// Re-arm the server watcher in case it was torn down or went deaf
			// while we were away, then refresh git status and reconcile content.
			ws.emit('files:watch', { projectPath });
			refreshGitStatus(0);
			reconcile();
		}, 200);
	}

	function handleVisibilityChange() {
		if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
			scheduleReconcile();
			// Returning from another app (e.g. after Ctrl+C in the native
			// file manager) can change the OS clipboard: refresh Paste
			// availability so the next context menu is already correct.
			void refreshOsClipboardState();
		}
	}

	// Same refresh on window focus (Alt+Tab back from File Explorer/Finder):
	// reconcile tree truth and re-probe the OS clipboard together.
	function handleWindowFocusRefresh(): void {
		scheduleReconcile();
		void refreshOsClipboardState();
	}

	// ============================
	// Effects
	// ============================

	// Load files when project changes — restore persisted state first, then
	// fetch tree with the correct `expanded` paths so children are populated.
	$effect(() => {
		const currentProjectId = projectId;
		const currentProjectPath = projectPath;
		const currentScope = watchScope;

		if (!hasActiveProject) {
			openTabs = [];
			activeTabPath = null;
			viewMode = 'tree';
			lastProjectPath = '';
			lastProjectId = '';
			lastProjectScope = '';
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
			persistStateForProject(lastProjectId, lastProjectPath, lastProjectScope || lastProjectId);
		}

		if (lastProjectPath !== currentProjectPath) {
			isInitialLoad = true;
			panelStateLoaded = false;
			// Reset transient state — restore() will repopulate
			openTabs = [];
			activeTabPath = null;
			expandedFolders = new Set();
			viewMode = 'tree';
			// Drop the outgoing project's tree. It used to survive here and stay on
			// screen until the new tree arrived, which only looked right because the
			// switch barrier hid it; now that panels reveal before their data lands,
			// leaving it would show the wrong project's files.
			projectFiles = [];
			error = '';
			// Drop the clipboard: it holds FileNode references from the previous
			// project, which would be dangling/invalid pointers in the new one.
			clipboard = null;
		}

		lastProjectPath = currentProjectPath;
		lastProjectId = currentProjectId;
		lastProjectScope = currentScope;

		// Sync git status for the new project
		syncGitStatusForProject();
		refreshIgnoredPaths();

		// Restore from DB then load the tree
		restoreAndLoad(currentProjectId, currentProjectPath, currentScope);
	});

	async function restoreAndLoad(targetProjectId: string, targetProjectPath: string, targetScope = watchScope) {
		// Hold the Files panel's skeleton for the WHOLE restore, not just the tree
		// fetch: the panel state round-trip happens first, and without this the
		// panel would show an empty tree for its duration.
		const releasePanel = beginPanelLoad('files');
		try {
			// Try in-memory snapshot first (instant for same-session mobile/desktop switch)
			const inMem = projectFileStates.get(targetProjectPath);
			let restored = false;

			if (inMem) {
				applyPersistedState(inMem, targetProjectPath);
				restored = true;
			}

			// Always fetch DB state too — it may be newer (cross-device, refresh)
			try {
				const result = await ws.http('files:get-panel-state', {
					projectId: targetProjectId,
					scopeKey: targetScope
				});
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

			if (projectId !== targetProjectId) return;

			// Mark as loaded BEFORE loadProjectFiles so any post-load saves are kept
			panelStateLoaded = true;

			await loadProjectFiles(restored);

			// After tree load, hydrate tab content for any restored tabs that
			// don't yet have content (their loadTabContent was triggered in
			// applyPersistedState but may still be in flight)
		} finally {
			releasePanel();
		}
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
			// Re-seed the dirty buffer so loadTabContent below restores the unsaved
			// edit as live content (and the tab shows as modified) instead of the
			// pristine disk version.
			if (t.unsaved !== undefined) {
				setUnsavedBuffer(basePath, absPath, t.unsaved);
			}
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

	// Start/stop file watcher when project changes. Routed through the shared
	// client-side ref-count so that closing this panel doesn't tear down the
	// watcher while the Git dock still needs it (both share one connection).
	// acquireFileWatch captures the path, so the cleanup releases the project
	// this effect started — not whatever `projectPath` has since become.
	$effect(() => {
		if (hasActiveProject && projectId && projectPath) {
			const release = acquireFileWatch(projectPath);
			return () => {
				release();
				isWatching = false;
			};
		}
	});

	// Listen for file change events
	$effect(() => {
		if (!hasActiveProject || !projectId) return;

		// Accumulate changes across multiple events within the debounce window
		let accumulatedChanges: Array<{ path: string; type: 'created' | 'modified' | 'deleted'; timestamp: string }> = [];

		const unsubChanges = ws.on('files:changed', (payload) => {
			if (payload.projectId !== watchScope) return;
			if (payload.changes.length === 0) return;

			// Accumulate changes from all events before debounce fires
			accumulatedChanges.push(...payload.changes);

			if (watchDebounceTimer) clearTimeout(watchDebounceTimer);

			watchDebounceTimer = setTimeout(async () => {
				const changes = [...accumulatedChanges];
				accumulatedChanges = [];
				watchDebounceTimer = null;
				// Mutasi optimistis sendiri sedang berjalan (rename/paste/upload/
				// delete langsung tampil): tunda reconcile agar echo watcher
				// tidak menimpa state optimistis (hilang/duplikat). Jadwalkan
				// ulang setelah mutasi selesai.
				if (pendingFsMutations > 0) {
					accumulatedChanges.push(...changes);
					if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
					watchDebounceTimer = setTimeout(async () => {
						const retry = [...accumulatedChanges];
						accumulatedChanges = [];
						watchDebounceTimer = null;
						await reconcile(retry, true);
					}, 500);
					return;
				}
				await reconcile(changes, true);
			}, 500);
		});

		// The watcher was rebuilt and may have missed events; no path is known to
		// have changed, so re-read the tree in place (scroll and expansion kept)
		// rather than reconciling a phantom change list. Tunda saat mutasi
		// optimistis berjalan agar tidak menimpa tampilan langsung.
		const unsubResync = ws.on('files:resync', (payload) => {
			if (payload.projectId !== watchScope) return;
			if (pendingFsMutations > 0) {
				syncTreeWithDiskDeferred();
				return;
			}
			void loadProjectFiles(true);
		});

		const unsubWatching = ws.on('files:watching', (payload) => {
			if (payload.projectId !== watchScope) return;
			isWatching = payload.watching;
		});

		const unsubError = ws.on('files:watch-error', (payload) => {
			if (payload.projectId !== watchScope) return;
			debug.error('file', `Watch error: ${payload.error}`);
		});

		return () => {
			unsubChanges();
			unsubResync();
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
		const currentProjectPath = projectPath;
		if (!revealPath || !currentProjectPath) return;

		clearRevealRequest();

		async function performReveal(targetPath: string) {
			// Expand all parent directories in the tree
			const relativePath = targetPath.startsWith(currentProjectPath)
				? targetPath.slice(currentProjectPath.length).replace(/^[/\\]/, '')
				: '';
			if (relativePath) {
				const parts = relativePath.split(/[/\\]/);
				let currentPath = currentProjectPath;
				const sep = currentProjectPath.includes('\\') ? '\\' : '/';
				for (let i = 0; i < parts.length - 1; i++) {
					currentPath += sep + parts[i];
					expandedFolders.add(currentPath);
				}
				// Also add target itself temporarily in case it is a directory
				expandedFolders.add(targetPath);
				expandedFolders = new Set(expandedFolders);
			}

			// Await loading the project files with the updated expanded folders
			await loadProjectFiles(true);

			// Update selection to focus on revealed node
			selectedPaths = new Set([targetPath]);
			selectionAnchor = targetPath;

			// Check node type to either open or scroll
			const targetNode = findFileInTree(projectFiles, targetPath);
			if (targetNode?.type === 'directory') {
				if (!isTwoColumnMode) viewMode = 'tree';
				scrollToActiveFile(targetPath);
			} else {
				// It's a file, or doesn't exist in tree (fallback to file). Clean from expandedFolders.
				if (expandedFolders.has(targetPath)) {
					expandedFolders.delete(targetPath);
					expandedFolders = new Set(expandedFolders);
				}
				await revealAndOpenFile(targetPath);
			}
		}

		performReveal(revealPath);
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
		initIgnoredPaths();

		// Subscribe to AI changes for explorer dot indicators
		const unsubAiFiles = onAiFilesChange((paths) => {
			aiChangesSet = new Set(paths);
		});

		// Safety-net reconcile when the user returns to the app/tab. File-watch
		// push events can be missed while the window is hidden (OS throttling,
		// sleep/wake, dropped events); reconciling on focus re-establishes truth
		// without relying on the watcher having stayed perfectly live.
		if (typeof window !== 'undefined') {
			window.addEventListener('focus', handleWindowFocusRefresh);
			document.addEventListener('visibilitychange', handleVisibilityChange);
			window.addEventListener('keydown', handleExplorerKeydown);
			window.addEventListener('pointerdown', trackPointerSide, true);
			window.addEventListener('paste', handlePasteDomEvent);
		}

		let resizeObserver: ResizeObserver | null = null;
		if (containerRef && typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) {
					containerWidth = entry.contentRect.width;
				}
			});
			resizeObserver.observe(containerRef);
		}

		return () => {
			unsubAiFiles();
			if (typeof window !== 'undefined') {
				window.removeEventListener('focus', handleWindowFocusRefresh);
				document.removeEventListener('visibilitychange', handleVisibilityChange);
				window.removeEventListener('keydown', handleExplorerKeydown);
				window.removeEventListener('pointerdown', trackPointerSide, true);
				window.removeEventListener('paste', handlePasteDomEvent);
			}
			if (reconcileTimer) clearTimeout(reconcileTimer);
			resizeObserver?.disconnect();
		};
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
		isTwoColumnMode: () => isTwoColumnMode,
		collapseAllFolders: () => { expandedFolders = new Set(); }
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
							onclick={(e) => { e.stopPropagation(); handleCloseTab(tab.file.path); }}
							title="Close tab"
						>
							<Icon name="lucide:x" class="w-3 h-3" />
						</button>
					</div>
				{/each}
			</div>
			<div class="relative flex-shrink-0">
				<button
					type="button"
					class="flex items-center justify-center px-2.5 border-l border-slate-200/50 dark:border-slate-700/50 text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors bg-transparent cursor-pointer h-full"
					onclick={(e) => { e.stopPropagation(); closeAllTabs(); }}
					title="Close all tabs"
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
			</div>
		</div>
	{/if}
{/snippet}

<div class="relative h-full flex flex-col bg-transparent" bind:this={containerRef}>
	<!-- Active operations banner — pinned to the bottom of the panel so it
	     stays visible regardless of tree scroll position. Mirrors the per-row
	     spinner for users whose target node is collapsed or off-screen. -->
	{#if activeOpsList.length > 0}
		<div
			class="absolute left-2 right-2 bottom-2 z-30 flex flex-col gap-1.5 pointer-events-none"
			aria-live="polite"
			aria-label="File operations in progress"
		>
			{#each activeOpsList as op (op.id)}
				<div
					class="pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/95 dark:bg-slate-800/95 text-slate-100 shadow-lg backdrop-blur border border-slate-700/60 text-xs"
				>
					<span class="w-3.5 h-3.5 border-2 border-violet-300/40 border-t-violet-300 rounded-full animate-spin flex-shrink-0"></span>
					<div class="flex-1 min-w-0">
						<div class="truncate">{op.label}</div>
						{#if op.progress !== undefined}
							<div class="mt-1 h-1 w-full rounded-full bg-slate-700/60 overflow-hidden">
								<div
									class="h-full bg-violet-400 transition-all duration-150"
									style="width: {Math.min(100, Math.max(0, op.progress * 100)).toFixed(1)}%"
								></div>
							</div>
						{/if}
					</div>
					{#if op.onCancel}
						<button
							onclick={op.onCancel}
							class="flex-shrink-0 p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-700/60 transition-colors cursor-pointer"
							title="Cancel"
							aria-label="Cancel {op.label}"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

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
							canPaste={isPasteAvailable()}
							onMenuOpen={handleMenuOpen}
							{cutPaths}
							onPasteToRoot={pasteToRoot}
							onNewFileInRoot={createNewFileInRoot}
							onNewFolderInRoot={createNewFolderInRoot}
							onUploadToRoot={triggerUploadToRoot}
							onRefresh={refreshAll}
							modifiedFiles={modifiedFilePaths}
							gitStatusMap={gitStatusState.map}
							gitFolderStatusMap={gitStatusState.folderMap}
							{selectedPaths}
							onNodeClick={handleNodeClick}
							{onNodeDragStart}
							{onNodeDragOver}
							{onNodeDragLeave}
							{onNodeDrop}
							{onNodeDragEnd}
							{dropTargetPath}
							{onRootDragOver}
							{onRootDragLeave}
							{onRootDrop}
							onClearSelection={clearSelection}
							{isRootDropTarget}
							{busyPaths}
							{isRootBusy}
							{aiChangesSet}
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
							target={displayTarget}
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

	<!-- Compress dialog (format / method / level / password) -->
	<CompressDialog
		isOpen={compressDialogOpen}
		itemCount={compressTargets.length}
		onConfirm={onCompressConfirm}
		onClose={() => { compressDialogOpen = false; compressTargets = []; }}
	/>

	<!-- Password prompt for extracting encrypted archives -->
	<Dialog
		bind:isOpen={passwordDialogOpen}
		type={passwordDialogWrong ? 'error' : 'info'}
		title="Password Required"
		message={passwordDialogWrong
			? 'Incorrect password. Please try again:'
			: 'This archive is password-protected. Enter its password to extract:'}
		bind:inputValue={passwordDialogValue}
		inputType="password"
		inputPlaceholder="Password"
		confirmText="Extract"
		onConfirm={(value) => resolvePassword(((value ?? passwordDialogValue) || '').trim() || undefined)}
		onClose={() => resolvePassword(undefined)}
	/>

	<!-- Unsaved changes prompt shown when closing all tabs -->
	<Dialog
		isOpen={closeAllUnsavedDialogOpen}
		type="warning"
		title="Unsaved Changes"
		message={closeAllUnsavedMessage}
		confirmText="Discard All"
		cancelText="Cancel"
		extraText="Save All"
		onExtra={saveAllAndCloseTabs}
		onConfirm={discardAllAndCloseTabs}
		onClose={closeCloseAllUnsavedDialog}
	/>

	<!-- Alert Component -->
	<Alert
		bind:isOpen={showAlert}
		title={alertTitle}
		message={alertMessage}
		type={alertType}
		onClose={() => { showAlert = false; }}
	/>

	<!-- Hidden file input used by upload triggers -->
	<input
		bind:this={uploadInputRef}
		type="file"
		multiple
		class="hidden"
		onchange={handleUploadInputChange}
	/>
</div>

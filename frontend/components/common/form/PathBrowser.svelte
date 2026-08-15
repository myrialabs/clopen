<script lang="ts">
	import { untrack } from 'svelte';
	import Button from '../display/Button.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '../overlay/Modal.svelte';
	import Dialog from '../overlay/Dialog.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/utils/ws';
	import { getFileIcon } from '$frontend/utils/file-icon-mappings';
	import { systemSettings } from '$frontend/stores/features/settings.svelte';

	interface FileItem {
		name: string;
		type: 'file' | 'directory';
		path: string;
		modified?: string;
		extension?: string;
		kind?: 'home' | 'root' | 'volume' | 'drive';
		children?: FileItem[];
		error?: string;
	}

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		onSelect: (path: string, name: string) => void;
		/** What can be confirmed: the browsed folder, or a file picked from it. */
		mode?: 'directory' | 'file';
		title?: string;
		confirmText?: string;
		/** File-mode filter, e.g. ['db', 'sqlite']. Empty means every file. */
		fileExtensions?: string[];
		/** Where to start. A file path opens its parent with the file preselected. */
		initialPath?: string;
		/** Create / rename / delete folder controls. */
		allowFolderActions?: boolean;
		/** Recent- and active-project badges — only meaningful when picking a project folder. */
		showProjectHints?: boolean;
		currentProjectPath?: string;
	}

	let {
		isOpen = $bindable(),
		onClose,
		onSelect,
		mode = 'directory',
		title,
		confirmText,
		fileExtensions = [],
		initialPath = '',
		allowFolderActions = true,
		showProjectHints = false,
		currentProjectPath
	}: Props = $props();

	let currentPath = $state('');
	let items: FileItem[] = $state([]);
	let loading = $state(false);
	let showLoadingSpinner = $state(false);
	let error = $state('');
	let selectedPath = $state('');
	let manualPath = $state('');
	let availableDrives: FileItem[] = $state([]);
	let recentProjects: string[] = $state([]);
	let loadingTimeout: number | null = null;
	let showCreateFolder = $state(false);
	let newFolderName = $state('');
	let showDeleteFolder = $state(false);
	let folderToDelete: FileItem | null = $state(null);
	let deleteFolderConfirmName = $state('');
	let showRenameFolder = $state(false);
	let folderToRename: FileItem | null = $state(null);
	let renameFolderName = $state('');
	let showHidden = $state(false);
	let showAllFiles = $state(false);

	// Set while resolving a file target so the parent listing can restore it as
	// the selection once the directory finishes loading.
	let pendingSelection: string | null = null;

	const isFileMode = $derived(mode === 'file');
	const heading = $derived(title ?? (isFileMode ? 'Select File' : 'Select Folder'));
	const confirmLabel = $derived(confirmText ?? (isFileMode ? 'Select File' : 'Select Folder'));

	// Toolbar pill styling, shared by every quick-access and toggle button.
	// The active fill matches the primary buttons (navigate arrow, confirm) so
	// the toolbar reads as one violet; the old violet-900/30 wash sat too close
	// to the slate toolbar behind it to register as "active" in dark mode.
	const PILL = 'px-3 py-1.5 text-xs rounded-lg transition-colors';
	const PILL_ACTIVE = 'bg-violet-600 hover:bg-violet-700 text-white';
	const PILL_IDLE = 'bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300';

	// Normalized to bare lowercase extensions ('.DB' and 'db' both become 'db')
	const allowedExtensions = $derived(
		fileExtensions.map(ext => ext.replace(/^\./, '').toLowerCase()).filter(Boolean)
	);
	const extensionsLabel = $derived(
		allowedExtensions.length <= 2
			? allowedExtensions.map(ext => `.${ext}`).join(' ')
			: `.${allowedExtensions[0]} +${allowedExtensions.length - 1}`
	);
	const canFilterExtensions = $derived(isFileMode && allowedExtensions.length > 0);

	function matchesExtension(item: FileItem): boolean {
		const raw = item.extension ?? item.name.slice(item.name.lastIndexOf('.'));
		return allowedExtensions.includes(raw.replace(/^\./, '').toLowerCase());
	}

	const filteredItems = $derived.by(() => {
		const base = showHidden ? items : items.filter(item => !item.name.startsWith('.'));
		// When browsing the drives root, hide the home entry — it has a dedicated button
		if (currentPath === 'drives') return base.filter(item => item.kind !== 'home');
		if (canFilterExtensions && !showAllFiles) {
			return base.filter(item => item.type === 'directory' || matchesExtension(item));
		}
		return base;
	});

	// Derived: whether directory access is restricted
	const hasRestrictions = $derived(systemSettings.allowedBasePaths && systemSettings.allowedBasePaths.length > 0);

	// Detect backend OS from current path (drive letter = Windows)
	const isWindows = $derived(/^[A-Za-z]:/.test(currentPath));
	const hasWindowsDrives = $derived(availableDrives.some(d => /^[A-Za-z]:\\/.test(d.path)));
	// Actual home path sourced from backend — avoids client-side path prefix guessing
	const homePath = $derived(availableDrives.find(d => d.kind === 'home')?.path ?? '');
	// Home has its own dedicated button, so exclude it from the dynamic location list
	const quickAccessLocations = $derived(availableDrives.filter(d => d.kind !== 'home'));

	// OS-appropriate placeholder for the path input
	const pathPlaceholder = $derived(
		isWindows ? 'e.g. C:\\Users\\username' : 'e.g. /home/username'
	);

	// Normalize path separators to forward slash and strip trailing slashes
	function normalizePath(p: string): string {
		let n = p.replace(/\\/g, '/');
		// Keep trailing slash only for drive roots like "C:/"
		if (n.length > 1 && !n.match(/^[A-Za-z]:\/$/)) {
			n = n.replace(/\/+$/, '');
		}
		return n;
	}

	// Compare two paths, case-insensitively on Windows paths
	function pathsEqual(a: string, b: string): boolean {
		const na = normalizePath(a);
		const nb = normalizePath(b);
		// Windows paths start with a drive letter
		if (/^[A-Za-z]:/.test(na) || /^[A-Za-z]:/.test(nb)) {
			return na.toLowerCase() === nb.toLowerCase();
		}
		return na === nb;
	}

	// Check if a path is within a base path
	function isWithinBase(path: string, base: string): boolean {
		const np = normalizePath(path);
		const nb = normalizePath(base);
		const isWindows = /^[A-Za-z]:/.test(np) || /^[A-Za-z]:/.test(nb);
		if (isWindows) {
			const npl = np.toLowerCase();
			const nbl = nb.toLowerCase();
			return npl === nbl || npl.startsWith(nbl + '/');
		}
		return np === nb || np.startsWith(nb + '/');
	}

	// Check if a path is accessible (within allowed base paths)
	function isPathAllowed(path: string): boolean {
		if (!systemSettings.allowedBasePaths || systemSettings.allowedBasePaths.length === 0) return true;
		return systemSettings.allowedBasePaths.some(base => isWithinBase(path, base));
	}

	// Parent of a path, keeping the separator style the backend OS uses
	function parentPathOf(path: string): string {
		const separator = path.includes('\\') ? '\\' : '/';
		const lastSeparator = path.lastIndexOf(separator);
		if (lastSeparator <= 0) return separator === '\\' ? path : '/';
		const parent = path.slice(0, lastSeparator);
		// Windows drive roots need their trailing separator ("C:" -> "C:\")
		return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
	}

	// Check if current path is at the restriction boundary (cannot go up)
	const atRestrictionBoundary = $derived(
		hasRestrictions && systemSettings.allowedBasePaths.some(base => pathsEqual(currentPath, base))
	);

	// Get available drives/mount points for all platforms
	async function loadAvailableDrives() {
		try {
			const data = await ws.http('files:browse-path', { path: 'drives' });
			if (data.children) {
				availableDrives = data.children as FileItem[];
			}
		} catch {
			debug.warn('session', 'Failed to get available drives/mount points');
			availableDrives = [];
		}
	}

	// Get recent projects from database
	async function loadRecentProjects() {
		try {
			const projects = await ws.http('projects:list', {});
			if (projects) {
				// Extract paths from projects, sorted by last_opened_at DESC
				recentProjects = projects.map((project: any) => project.path);
			}
		} catch {
			debug.warn('session', 'Failed to get recent projects');
			recentProjects = [];
		}
	}

	// Get the path to open on: caller-provided, else home / current working directory
	async function getInitialPath(): Promise<string> {
		if (initialPath.trim() && isPathAllowed(initialPath.trim())) {
			return initialPath.trim();
		}

		// If restrictions are set, start at the first allowed base path
		if (systemSettings.allowedBasePaths && systemSettings.allowedBasePaths.length > 0) {
			return systemSettings.allowedBasePaths[0];
		}

		try {
			const data = await ws.http('files:browse-path', { path: 'home' });
			if (data.path) {
				return data.path;
			}
		} catch {
			debug.warn('session', 'Failed to get home directory, using current working directory');
		}

		// Fallback to current working directory
		try {
			const data = await ws.http('files:browse-path', { path: '.' });
			if (data.path) {
				return data.path;
			}
		} catch {
			debug.warn('session', 'Failed to get current directory');
		}

		// Platform-specific fallback
		if (typeof window !== 'undefined') {
			if (navigator.userAgent.includes('Windows')) {
				return 'C:\\';
			} else {
				// Unix-like systems (Linux, macOS, etc.)
				return '/';
			}
		}

		// Final fallback
		return '/';
	}

	// Check if a folder path is a recent project
	function isRecentProject(folderPath: string): boolean {
		return showProjectHints && recentProjects.includes(folderPath);
	}

	// Check if a folder path is the active project
	function isActiveProject(folderPath: string): boolean {
		return showProjectHints && currentProjectPath !== undefined && currentProjectPath === folderPath;
	}

	function isQuickAccessActive(location: 'home' | 'drives' | string): boolean {
		if (location === 'drives') return currentPath === 'drives';
		if (location === 'home') {
			if (currentPath === 'drives' || !homePath) return false;
			return pathsEqual(currentPath, homePath);
		}
		return pathsEqual(currentPath, location);
	}

	// Navigate to a specific common location
	async function navigateToLocation(location: 'home' | 'cwd' | 'drives' | string) {
		if (location === 'home') {
			// The backend resolves "home"; loadDirectory picks up the real path
			loadDirectory('home');
		} else if (location === 'cwd') {
			loadDirectory('.');
		} else if (location === 'drives') {
			loadDirectory('drives');
		} else {
			// Normalize path separators to match backend OS.
			// Use currentPath to detect OS if available, else detect from the path itself.
			let path = location;
			const backendIsWindows = currentPath
				? /^[A-Za-z]:/.test(currentPath)
				: /^[A-Za-z]:/.test(path);
			if (backendIsWindows) {
				path = path.replace(/\//g, '\\');
			} else {
				path = path.replace(/\\/g, '/');
			}
			loadDirectory(path);
		}
	}

	async function loadDirectory(path: string) {
		loading = true;
		error = '';

		// Clear any existing timeout
		if (loadingTimeout) {
			clearTimeout(loadingTimeout);
			loadingTimeout = null;
		}

		// Only show loading spinner after 150ms to prevent flickering for fast operations
		loadingTimeout = setTimeout(() => {
			if (loading) {
				showLoadingSpinner = true;
			}
		}, 150) as unknown as number;

		try {
			// ws.http() now unwraps response - returns data directly or throws error
			const fileData = await ws.http('files:browse-path', { path });

			// A file target is only meaningful in file mode: remember it as the
			// selection and browse its parent so it shows up in context.
			if (fileData.type === 'file') {
				if (!isFileMode) {
					error = 'That path is a file, not a folder';
					items = [];
					return;
				}
				if (!isPathAllowed(fileData.path)) {
					error = `Access restricted. Allowed paths: ${systemSettings.allowedBasePaths.join(', ')}`;
					items = [];
					return;
				}
				pendingSelection = fileData.path;
				await loadDirectory(parentPathOf(fileData.path));
				return;
			}

			currentPath = fileData.path;

			// Enforce access restrictions
			if (!isPathAllowed(currentPath)) {
				error = `Access restricted. Allowed paths: ${systemSettings.allowedBasePaths.join(', ')}`;
				items = [];
				return;
			}

			if (isFileMode) {
				// Only a file can be confirmed, so navigating drops any stale pick
				selectedPath = pendingSelection ?? '';
				pendingSelection = null;
			} else {
				// Do not auto-select the synthetic "drives" root. A real folder must be
				// chosen before confirming selection.
				selectedPath = fileData.path === 'drives' ? '' : fileData.path;
			}

			if (fileData.type === 'directory' && fileData.children) {
				// Filter to show only directories and common project files
				items = (fileData.children as FileItem[])
					.sort((a, b) => {
						// Directories first, then files
						if (a.type !== b.type) {
							return a.type === 'directory' ? -1 : 1;
						}
						return a.name.localeCompare(b.name);
					});
			} else {
				items = [];
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load directory';
			items = [];
		} finally {
			loading = false;
			showLoadingSpinner = false;

			// Clear timeout if still pending
			if (loadingTimeout) {
				clearTimeout(loadingTimeout);
				loadingTimeout = null;
			}
		}
	}

	function navigateToParent() {
		// Special case: if we're viewing drives list
		if (currentPath === 'drives') {
			return; // Can't go higher than drives list
		}

		// Handle both Windows and Unix paths properly
		const pathSeparator = currentPath.includes('\\') ? '\\' : '/';
		const pathParts = currentPath.split(pathSeparator).filter(part => part !== '');

		if (pathParts.length === 0) {
			// Already at root, can't go higher
			return;
		}

		if (pathParts.length === 1) {
			// We're at a drive root like "C:" on Windows, go to drives list
			if (pathSeparator === '\\' && pathParts[0].match(/^[A-Z]:$/)) {
				navigateToLocation('drives');
				return;
			}
			// On Unix, we're at root
			loadDirectory('/');
			return;
		}

		// Remove last part and rejoin
		pathParts.pop();
		let parentPath = pathParts.join(pathSeparator);

		// Ensure proper format
		if (pathSeparator === '\\') {
			// Windows: ensure we have drive letter with backslash
			if (pathParts.length === 1 && pathParts[0].match(/^[A-Z]:$/)) {
				parentPath = pathParts[0] + '\\';
			} else if (!parentPath.endsWith('\\')) {
				parentPath = pathParts.join(pathSeparator) + '\\';
			}
		} else {
			// Unix: ensure we start with /
			if (!parentPath.startsWith('/')) {
				parentPath = '/' + parentPath;
			}
		}

		loadDirectory(parentPath);
	}

	function navigateToFolder(folderPath: string) {
		loadDirectory(folderPath);
		// Note: selectedPath is now auto-set in loadDirectory
	}

	function selectFolder(folderPath: string) {
		selectedPath = folderPath;
	}

	// Row activation: folders navigate, files are selectable in file mode only
	function activateItem(item: FileItem) {
		if (item.type === 'directory') {
			navigateToFolder(item.path);
		} else if (isFileMode) {
			selectedPath = item.path;
		}
	}

	function confirmSelection() {
		if (selectedPath) {
			// Handle both Windows and Unix paths properly
			const pathSeparator = selectedPath.includes('\\') ? '\\' : '/';
			const name = selectedPath.split(pathSeparator).pop() || selectedPath;
			onSelect(selectedPath, name);
		}
	}

	function navigateToManualPath() {
		if (manualPath.trim()) {
			let path = manualPath.trim();
			// Normalize path separators to match backend OS
			if (isWindows) {
				path = path.replace(/\//g, '\\');
			} else {
				path = path.replace(/\\/g, '/');
			}
			loadDirectory(path);
		}
	}

	function handleManualPathKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			navigateToManualPath();
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (showCreateFolder) {
				showCreateFolder = false;
				newFolderName = '';
			} else {
				onClose();
			}
		}
	}

	async function createNewFolder() {
		if (!newFolderName.trim()) return;

		const folderPath = currentPath.includes('\\')
			? `${currentPath}\\${newFolderName.trim()}`
			: `${currentPath}/${newFolderName.trim()}`;

		try {
			// Create folder via WebSocket
			await ws.http('files:create-directory', {
				dirPath: folderPath
			});

			// Store current path before clearing dialog state
			const pathToReload = currentPath;

			// Close create folder dialog
			showCreateFolder = false;
			newFolderName = '';

			// Add a small delay to ensure file system operation is complete
			await new Promise(resolve => setTimeout(resolve, 100));

			// Reload current directory using the main loadDirectory function
			if (pathToReload) {
				loadDirectory(pathToReload);
			} else {
				// Fallback to current path if somehow it's empty
				const fallbackPath = currentPath || '.';
				loadDirectory(fallbackPath);
			}

			// Select the new folder after reload starts — files-only pickers keep their pick
			if (!isFileMode) {
				selectFolder(folderPath);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create folder';
		}
	}

	function openDeleteDialog(item: FileItem) {
		folderToDelete = item;
		deleteFolderConfirmName = '';
		showDeleteFolder = true;
	}

	async function deleteFolder() {
		if (!folderToDelete || deleteFolderConfirmName !== folderToDelete.name) return;

		try {
			const folderPath = folderToDelete.path;

			// Picker-only route: rejects non-empty directories and paths inside
			// other users' projects, even when forced.
			await ws.http('files:delete-directory', {
				dirPath: folderPath
			});

			// Store current path before clearing dialog state
			const pathToReload = currentPath;

			// Clear selection if deleted folder was selected
			if (selectedPath === folderPath) {
				selectedPath = isFileMode ? '' : pathToReload;
			}

			// Close delete dialog
			showDeleteFolder = false;
			folderToDelete = null;
			deleteFolderConfirmName = '';

			// Add a small delay to ensure file system operation is complete
			await new Promise(resolve => setTimeout(resolve, 100));

			// Reload current directory using the main loadDirectory function
			if (pathToReload) {
				loadDirectory(pathToReload);
			} else {
				// Fallback to current path if somehow it's empty
				const fallbackPath = currentPath || '.';
				loadDirectory(fallbackPath);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete folder';
		}
	}

	function openRenameDialog(item: FileItem) {
		folderToRename = item;
		renameFolderName = item.name;
		showRenameFolder = true;
	}

	async function renameFolder() {
		if (!folderToRename) return;
		const trimmed = renameFolderName.trim();
		if (!trimmed || trimmed === folderToRename.name) {
			showRenameFolder = false;
			folderToRename = null;
			return;
		}

		const oldPath = folderToRename.path;
		const usesBackslash = oldPath.includes('\\');
		const sep = usesBackslash ? '\\' : '/';
		const lastSep = usesBackslash ? oldPath.lastIndexOf('\\') : oldPath.lastIndexOf('/');
		const parent = lastSep >= 0 ? oldPath.slice(0, lastSep) : '';
		const newPath = parent ? `${parent}${sep}${trimmed}` : trimmed;

		try {
			await ws.http('files:rename-directory', {
				oldPath,
				newPath
			});

			const pathToReload = currentPath;

			if (selectedPath === oldPath) {
				selectedPath = newPath;
			}

			showRenameFolder = false;
			folderToRename = null;
			renameFolderName = '';

			await new Promise(resolve => setTimeout(resolve, 100));

			if (pathToReload) {
				loadDirectory(pathToReload);
			} else {
				const fallbackPath = currentPath || '.';
				loadDirectory(fallbackPath);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to rename folder';
		}
	}

	// Initialize when dialog opens. Everything inside is untracked so that a
	// caller changing `initialPath` (e.g. while typing into the field the picker
	// fills) cannot yank the browser back to another directory mid-browse.
	$effect(() => {
		if (!isOpen) return;
		untrack(() => {
			// Load available drives/mount points for all platforms
			loadAvailableDrives();

			// Project badges are opt-in — skip the lookup when they're not shown
			if (showProjectHints) {
				loadRecentProjects();
			}

			showAllFiles = false;

			getInitialPath().then(path => {
				loadDirectory(path);
			});
		});
	});

	// Sync manualPath with currentPath
	$effect(() => {
		if (currentPath === 'drives') {
			manualPath = hasWindowsDrives ? '' : (homePath || '/');
			return;
		}
		manualPath = currentPath;
	});

	// Cleanup function to clear timeout when component unmounts
	$effect(() => {
		return () => {
			if (loadingTimeout) {
				clearTimeout(loadingTimeout);
				loadingTimeout = null;
			}
		};
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal
	bind:isOpen={isOpen}
	onClose={onClose}
	size="xl"
	className=""
>
	{#snippet header()}
		<div class="bg-slate-50 dark:bg-slate-800">
			<div class="flex items-center justify-between px-4 md:px-6 pt-4 mb-2">
				<div>
					<h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
						{heading}
					</h2>
				</div>
				<button
					type="button"
					class="p-2 rounded-lg text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
					onclick={onClose}
					aria-label="Close modal"
				>
					<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
				</button>
			</div>

			<!-- Path navigation -->
			<div class="px-6 pb-4">
				<div class="flex items-center space-x-2 text-sm">
					<button
						onclick={navigateToParent}
						disabled={currentPath === '/' || currentPath === 'drives' || loading || atRestrictionBoundary}
						class="flex p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						aria-label="Go to parent directory"
					>
						<Icon name="lucide:arrow-up" class="text-slate-600 dark:text-slate-300" />
					</button>

					<input
						bind:value={manualPath}
						onkeydown={handleManualPathKeydown}
						class="flex-1 font-mono text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 dark:focus:border-violet-400"
						placeholder={pathPlaceholder}
					/>
					<button
						onclick={navigateToManualPath}
						disabled={!manualPath.trim()}
						class="flex p-3 rounded-lg bg-violet-500 dark:bg-violet-600 hover:bg-violet-600 dark:hover:bg-violet-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						aria-label="Navigate to path"
					>
						<Icon name="lucide:arrow-right" class="text-slate-100" />
					</button>

					{#if showLoadingSpinner}
						<div class="animate-spin rounded-full h-4 w-4 border-2 border-violet-500 border-t-transparent"></div>
					{/if}
				</div>

				<!-- Quick actions -->
				<div class="flex items-center justify-between mt-3">
					<div class="flex items-center gap-2 flex-wrap">
						{#if hasRestrictions}
							<!-- Restricted mode: show allowed base paths as quick access -->
							{#each systemSettings.allowedBasePaths as basePath (basePath)}
								<button
									onclick={() => navigateToLocation(basePath)}
									class="{PILL} {isQuickAccessActive(basePath) ? PILL_ACTIVE : PILL_IDLE}"
									title="Go to {basePath}"
								>
									<Icon name="lucide:folder-lock" class="inline mr-1" />
									{basePath.split(/[/\\]/).filter(Boolean).pop() || basePath}
								</button>
							{/each}
						{:else}
							<!-- Normal mode: home, [volumes/drives], system buttons -->
							<button
								onclick={() => navigateToLocation('home')}
								class="{PILL} {isQuickAccessActive('home') ? PILL_ACTIVE : PILL_IDLE}"
								title="Go to home directory"
							>
								<Icon name="lucide:house" class="inline mr-1" />
								Home
							</button>

							<!-- Dynamic location buttons (all platforms) -->
							{#if quickAccessLocations.length > 0}
								{#each quickAccessLocations as location (location.path)}
									<button
										onclick={() => navigateToLocation(location.path)}
										class="{PILL} {isQuickAccessActive(location.path) ? PILL_ACTIVE : PILL_IDLE}"
										title="Go to {location.name}"
									>
										{#if location.kind === 'drive'}
											<Icon name="lucide:hard-drive" class="inline mr-1" />
											{location.path.replace(/\\/g, '')}
										{:else if location.kind === 'root'}
											<Icon name="lucide:folder-root" class="inline mr-1" />
											/
										{:else if location.kind === 'volume'}
											<Icon name="lucide:hard-drive" class="inline mr-1" />
											{location.name}
										{:else}
											<Icon name="lucide:folder" class="inline mr-1" />
											{location.path.split(/[/\\]/).pop() || location.name}
										{/if}
									</button>
								{/each}
							{/if}

							<button
								onclick={() => navigateToLocation('drives')}
								class="{PILL} {isQuickAccessActive('drives') ? PILL_ACTIVE : PILL_IDLE}"
								title="Browse all system locations"
							>
								<Icon name="lucide:monitor" class="inline mr-1" />
								System
							</button>
						{/if}
					</div>

					<div class="flex items-center space-x-2">
						{#if canFilterExtensions}
							<button
								onclick={() => showAllFiles = !showAllFiles}
								class="{PILL} {showAllFiles ? PILL_IDLE : PILL_ACTIVE}"
								title={showAllFiles
									? `Show only ${allowedExtensions.map(ext => `.${ext}`).join(', ')} files`
									: 'Show every file'}
							>
								<Icon name="lucide:filter" class="inline sm:mr-1" />
								<span class="hidden sm:inline">{showAllFiles ? 'All files' : extensionsLabel}</span>
							</button>
						{/if}
						<button
							onclick={() => showHidden = !showHidden}
							class="{PILL} {showHidden ? PILL_ACTIVE : PILL_IDLE}"
							title={showHidden ? 'Hide hidden entries' : 'Show hidden entries'}
						>
							<Icon name={showHidden ? 'lucide:eye' : 'lucide:eye-off'} class="inline sm:mr-1" />
							<span class="hidden sm:inline">Hidden</span>
						</button>
						{#if allowFolderActions}
							<button
								onclick={() => showCreateFolder = true}
								class="{PILL} {PILL_IDLE}"
								title="Create new folder in current directory"
							>
								<Icon name="lucide:folder-plus" class="inline sm:mr-1" />
								<span class="hidden sm:inline">New Folder</span>
							</button>
						{/if}
					</div>
				</div>
			</div>
		</div>
	{/snippet}

	{#snippet children()}
		<!-- Scrollable directory contents -->
		{#if error}
			<div class="flex items-center justify-center py-12">
				<div class="text-center">
					<Icon name="lucide:triangle-alert" class="text-4xl text-red-500 mx-auto mb-4" />
					<p class="text-red-600 dark:text-red-400 font-medium">Error Loading Directory</p>
					<p class="text-sm text-slate-600 dark:text-slate-400 mt-2">{error}</p>
					<Button
						onclick={() => loadDirectory(currentPath)}
						variant="outline"
						size="sm"
						class="mt-4"
					>
						Try Again
					</Button>
				</div>
			</div>
		{:else if showLoadingSpinner && filteredItems.length === 0}
			<div class="flex items-center justify-center py-12">
				<div class="text-center">
					<div class="animate-spin rounded-full h-8 w-8 border-2 border-violet-500 border-t-transparent mx-auto mb-4"></div>
					<p class="text-slate-600 dark:text-slate-400">Loading directory...</p>
				</div>
			</div>
		{:else if filteredItems.length === 0}
			<div class="flex items-center justify-center py-12">
				<div class="text-center">
					<Icon name={isFileMode ? 'lucide:file-x' : 'lucide:folder-x'} class="text-4xl text-slate-400 mx-auto mb-4" />
					<p class="text-slate-600 dark:text-slate-400">Nothing to show here</p>
					<p class="text-sm text-slate-500 dark:text-slate-500 mt-2">
						{#if items.length > 0 && canFilterExtensions && !showAllFiles}
							Nothing matches {allowedExtensions.map(ext => `.${ext}`).join(', ')} — switch to "All files" to see everything
						{:else if items.length > 0}
							Toggle "Hidden" to show hidden entries
						{:else}
							This directory is empty
						{/if}
					</p>
				</div>
			</div>
		{:else}
			<!-- Entries flow into two columns on wider screens so the modal stops wasting horizontal space -->
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-2 transition-opacity duration-300 {loading ? 'opacity-75' : 'opacity-100'}">
				{#each filteredItems as item (item.path)}
					<div
						class="flex items-center space-x-3 py-3 px-4 rounded-xl border transition-all duration-200 {item.type === 'directory' || isFileMode ? 'cursor-pointer' : 'cursor-default'} {selectedPath === item.path
							? 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-700'
							: isActiveProject(item.path)
								? 'bg-violet-50/50 dark:bg-violet-900/10 border-violet-300 dark:border-violet-700/50 hover:bg-violet-100/50 dark:hover:bg-violet-900/20'
							: isRecentProject(item.path)
								? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/50 hover:bg-green-100 dark:hover:bg-green-900/20'
								: 'bg-slate-50 dark:bg-slate-800/30 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/50'}"
						onclick={() => activateItem(item)}
						role="button"
						tabindex="0"
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								activateItem(item);
							}
						}}
					>
						<div class="flex-shrink-0 relative">
							{#if item.type === 'directory'}
								<Icon
									name="lucide:folder"
									class="text-xl {selectedPath === item.path
										? 'text-violet-600 dark:text-violet-400'
										: isActiveProject(item.path)
											? 'text-violet-600 dark:text-violet-400'
										: isRecentProject(item.path)
											? 'text-green-600 dark:text-green-400'
											: 'text-slate-500 dark:text-slate-400'}"
								/>
								{#if isActiveProject(item.path)}
									<div class="absolute -top-1 -right-1">
										<Icon
											name="lucide:star"
											class="text-xs text-violet-600 dark:text-violet-400 bg-white dark:bg-slate-800 rounded-full p-0.5"
										/>
									</div>
								{:else if isRecentProject(item.path)}
									<div class="absolute -top-1 -right-1">
										<Icon
											name="lucide:clock"
											class="text-xs text-green-600 dark:text-green-400 bg-white dark:bg-slate-800 rounded-full p-0.5"
										/>
									</div>
								{/if}
							{:else}
								<Icon
									name={getFileIcon(item.name)}
									class="text-xl {selectedPath === item.path
										? 'text-violet-600 dark:text-violet-400'
										: 'text-slate-500 dark:text-slate-400'}"
								/>
							{/if}
						</div>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<p class="font-medium truncate {item.type === 'file' && !isFileMode ? 'text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-slate-100'}">
									{item.name}
								</p>
								{#if isActiveProject(item.path)}
									<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-violet-100 dark:bg-violet-900/30 text-violet-800 dark:text-violet-300 border border-violet-200 dark:border-violet-800">
										Active Project
									</span>
								{:else if isRecentProject(item.path)}
									<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 border border-green-200 dark:border-green-800">
										Recent Project
									</span>
								{/if}
							</div>
							{#if item.modified}
								<p class="text-xs text-slate-500 dark:text-slate-400">
									Modified {new Date(item.modified).toLocaleDateString()}
								</p>
							{/if}
						</div>
						{#if item.type === 'directory'}
							<div class="flex-shrink-0 flex items-center gap-2">
								{#if allowFolderActions}
									<button
										onclick={(e) => {
											e.stopPropagation();
											openRenameDialog(item);
										}}
										class="flex p-1.5 rounded-lg hover:bg-violet-100 dark:hover:bg-violet-900/20 transition-colors group"
										title="Rename folder"
										aria-label="Rename {item.name}"
									>
										<Icon
											name="lucide:pencil"
											class="text-sm text-slate-400 dark:text-slate-500 group-hover:text-violet-500 dark:group-hover:text-violet-400"
										/>
									</button>
									<button
										onclick={(e) => {
											e.stopPropagation();
											openDeleteDialog(item);
										}}
										class="flex p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors group"
										title="Delete folder"
										aria-label="Delete {item.name}"
									>
										<Icon
											name="lucide:trash-2"
											class="text-sm text-slate-400 dark:text-slate-500 group-hover:text-red-500 dark:group-hover:text-red-400"
										/>
									</button>
								{/if}
								<Icon
									name="lucide:chevron-right"
									class="text-sm text-slate-400 dark:text-slate-500"
								/>
							</div>
						{:else if isFileMode && selectedPath === item.path}
							<Icon name="lucide:check" class="flex-shrink-0 text-violet-600 dark:text-violet-400" />
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}

	{#snippet footer()}
		<div class="flex items-end flex-wrap sm:flex-nowrap gap-3 w-full">
			<!-- Selection summary always occupies the left so the footer never sits
			     as a lone button against an empty bar -->
			<div class="flex-1 min-w-0 w-full sm:w-auto">
				<p class="text-xs text-slate-500 dark:text-slate-400 mb-1.5">
					Selected {isFileMode ? 'file' : 'folder'}
				</p>
				<!-- Dashed and unfilled in both states: this is a read-only echo of the
				     pick, and a solid box read as an editable path input. py-2.5 +
				     border matches the buttons, so a single-line path lines up with
				     Cancel / confirm. -->
				<div
					class="text-sm px-3 py-2.5 rounded-lg border border-dashed border-slate-200 dark:border-slate-700 break-all line-clamp-2 {selectedPath
						? 'text-slate-700 dark:text-slate-200'
						: 'text-slate-400 dark:text-slate-500'}"
					title={selectedPath}
				>
					{selectedPath || (isFileMode ? 'Pick a file from the list' : 'Browse to the folder you want')}
				</div>
			</div>

			<div class="flex items-center gap-2 flex-none w-full sm:w-auto">
				<Button variant="outline" onclick={onClose} class="flex-1 sm:flex-none">
					Cancel
				</Button>
				<!-- The transparent border keeps the filled button the same height as the
				     outlined Cancel, which pays for its own 1px -->
				<Button
					onclick={confirmSelection}
					disabled={!selectedPath}
					class="border border-transparent disabled:opacity-50 disabled:cursor-not-allowed flex-1 sm:flex-none"
				>
					{confirmLabel}
				</Button>
			</div>
		</div>
	{/snippet}
</Modal>

<!-- Create Folder Dialog -->
<Dialog
	bind:isOpen={showCreateFolder}
	onClose={() => {
		showCreateFolder = false;
		newFolderName = '';
	}}
	title="Create New Folder"
	type="info"
	message={`Create a new folder in: ${currentPath}`}
	bind:inputValue={newFolderName}
	inputPlaceholder="Enter folder name"
	confirmText="Create"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={createNewFolder}
/>

<!-- Delete Folder Dialog -->
<Dialog
	bind:isOpen={showDeleteFolder}
	onClose={() => {
		showDeleteFolder = false;
		folderToDelete = null;
		deleteFolderConfirmName = '';
	}}
	title="Delete Folder"
	type="warning"
	message={`This action cannot be undone. To delete "${folderToDelete?.name || ''}", type the folder name exactly as shown:`}
	bind:inputValue={deleteFolderConfirmName}
	inputPlaceholder="Type folder name to confirm"
	confirmText="Delete"
	cancelText="Cancel"
	showCancel={true}
	confirmDisabled={deleteFolderConfirmName !== folderToDelete?.name}
	onConfirm={deleteFolder}
/>

<!-- Rename Folder Dialog -->
<Dialog
	bind:isOpen={showRenameFolder}
	onClose={() => {
		showRenameFolder = false;
		folderToRename = null;
		renameFolderName = '';
	}}
	title="Rename Folder"
	type="info"
	message={`Rename "${folderToRename?.name || ''}" to:`}
	bind:inputValue={renameFolderName}
	inputPlaceholder="Enter new folder name"
	confirmText="Rename"
	cancelText="Cancel"
	showCancel={true}
	confirmDisabled={!renameFolderName.trim() || renameFolderName.trim() === folderToRename?.name}
	onConfirm={renameFolder}
/>

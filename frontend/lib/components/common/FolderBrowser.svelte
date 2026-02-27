<script lang="ts">
	// import { onMount } from 'svelte';
	import Button from './Button.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import Modal from './Modal.svelte';
	import Dialog from './Dialog.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/lib/utils/ws';
	import { settings } from '$frontend/lib/stores/features/settings.svelte';
	
	interface FileItem {
		name: string;
		type: 'file' | 'directory';
		path: string;
		modified?: string;
		children?: FileItem[];
		error?: string;
	}
	
	interface Props {
		isOpen: boolean;
		onClose: () => void;
		onSelect: (folderPath: string, folderName: string) => void;
		currentProjectPath?: string;
	}
	
	let { isOpen = $bindable(), onClose, onSelect, currentProjectPath }: Props = $props();
	
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

	// Derived: whether directory access is restricted
	const hasRestrictions = $derived(settings.allowedBasePaths && settings.allowedBasePaths.length > 0);

	// Detect backend OS from current path (drive letter = Windows)
	const isWindows = $derived(/^[A-Za-z]:/.test(currentPath));

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
		if (!settings.allowedBasePaths || settings.allowedBasePaths.length === 0) return true;
		return settings.allowedBasePaths.some(base => isWithinBase(path, base));
	}

	// Check if current path is at the restriction boundary (cannot go up)
	const atRestrictionBoundary = $derived(
		hasRestrictions && settings.allowedBasePaths.some(base => pathsEqual(currentPath, base))
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

	// Get user's home directory or current working directory
	async function getInitialPath(): Promise<string> {
		// If restrictions are set, start at the first allowed base path
		if (settings.allowedBasePaths && settings.allowedBasePaths.length > 0) {
			return settings.allowedBasePaths[0];
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
		return recentProjects.includes(folderPath);
	}

	// Check if a folder path is the active project
	function isActiveProject(folderPath: string): boolean {
		return currentProjectPath !== undefined && currentProjectPath === folderPath;
	}
	
	// Navigate to a specific common location
	async function navigateToLocation(location: 'home' | 'cwd' | 'drives' | string) {
		if (location === 'home') {
			const path = await getInitialPath();
			loadDirectory(path);
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

			currentPath = fileData.path;

			// Enforce access restrictions
			if (!isPathAllowed(currentPath)) {
				error = `Access restricted. Allowed paths: ${settings.allowedBasePaths.join(', ')}`;
				items = [];
				return;
			}

			// Auto-select current directory when loading
			selectedPath = fileData.path;

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
	
	function confirmSelection() {
		if (selectedPath) {
			// Handle both Windows and Unix paths properly
			const pathSeparator = selectedPath.includes('\\') ? '\\' : '/';
			const folderName = selectedPath.split(pathSeparator).pop() || selectedPath;
			onSelect(selectedPath, folderName);
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
	
	function selectCurrentFolder() {
		if (currentPath) {
			selectFolder(currentPath);
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
			const data = await ws.http('files:create-directory', {
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

			// Select the new folder after reload starts
			selectFolder(folderPath);
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

			// Delete folder via WebSocket
			await ws.http('files:delete', {
				filePath: folderPath,
				force: true  // Allow deletion of non-empty directories
			});

			// Store current path before clearing dialog state
			const pathToReload = currentPath;

			// Clear selection if deleted folder was selected
			if (selectedPath === folderPath) {
				selectedPath = pathToReload;
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
	
	// Initialize when dialog opens
	$effect(() => {
		if (isOpen) {
			// Load available drives/mount points for all platforms
			loadAvailableDrives();
			
			// Load recent projects from database
			loadRecentProjects();
			
			getInitialPath().then(path => {
				loadDirectory(path);
			});
		}
	});
	
	// Sync manualPath with currentPath
	$effect(() => {
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
						Select Project Folder
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
						disabled={currentPath === '/' || loading || atRestrictionBoundary}
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
							{#each settings.allowedBasePaths as basePath (basePath)}
								<button
									onclick={() => navigateToLocation(basePath)}
									class="px-3 py-1.5 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 transition-colors"
									title="Go to {basePath}"
								>
									<Icon name="lucide:folder-lock" class="inline mr-1" />
									{basePath.split(/[/\\]/).filter(Boolean).pop() || basePath}
								</button>
							{/each}
						{:else}
							<!-- Normal mode: home, system, drive buttons -->
							<button
								onclick={() => navigateToLocation('home')}
								class="px-3 py-1.5 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 transition-colors"
								title="Go to home directory"
							>
								<Icon name="lucide:house" class="inline mr-1" />
								Home
							</button>
							<button
								onclick={() => navigateToLocation('drives')}
								class="px-3 py-1.5 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 transition-colors"
								title="Browse system locations"
							>
								<Icon name="lucide:monitor" class="inline mr-1" />
								System
							</button>

							<!-- Dynamic location buttons (all platforms) -->
							{#if availableDrives.length > 0}
								{#each availableDrives as location (location.path)}
									<button
										onclick={() => navigateToLocation(location.path)}
										class="px-3 py-1.5 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 transition-colors"
										title="Go to {location.name}"
									>
										{#if location.path.match(/^[A-Z]:\\/i)}
											<!-- Windows drive -->
											<Icon name="lucide:hard-drive" class="inline mr-1" />
											{location.path.replace(/\\/g, '')}
										{:else if location.path === '/'}
											<!-- Unix root -->
											<Icon name="lucide:folder-root" class="inline mr-1" />
											/
										{:else if location.path.startsWith('/Volumes')}
											<!-- macOS volume -->
											<Icon name="lucide:disc" class="inline mr-1" />
											{location.path.split('/').pop()}
										{:else if location.path.includes('/mnt') || location.path.includes('/media')}
											<!-- Linux mount point -->
											<Icon name="lucide:hard-drive" class="inline mr-1" />
											{location.path.split('/').pop()}
										{:else}
											<!-- Generic location -->
											<Icon name="lucide:folder" class="inline mr-1" />
											{location.path.split('/').pop() || location.name}
										{/if}
									</button>
								{/each}
							{/if}
						{/if}
					</div>
					
					<div class="flex items-center space-x-2">
						<button
							onclick={() => showCreateFolder = true}
							class="px-3 py-1.5 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 transition-colors"
							title="Create new folder in current directory"
						>
							<Icon name="lucide:folder-plus" class="inline sm:mr-1" />
							<span class="hidden sm:inline">New Folder</span>
						</button>
						<!-- <button
							onclick={selectCurrentFolder}
							disabled={!currentPath}
							class="px-3 py-1.5 text-xs rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 transition-colors"
						>
							<Icon name="lucide:check" class="inline mr-1" />
							Use Current Folder
						</button> -->
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
		{:else if showLoadingSpinner && items.length === 0}
			<div class="flex items-center justify-center py-12">
				<div class="text-center">
					<div class="animate-spin rounded-full h-8 w-8 border-2 border-violet-500 border-t-transparent mx-auto mb-4"></div>
					<p class="text-slate-600 dark:text-slate-400">Loading directory...</p>
				</div>
			</div>
		{:else if items.length === 0}
			<div class="flex items-center justify-center py-12">
				<div class="text-center">
					<Icon name="lucide:folder-x" class="text-4xl text-slate-400 mx-auto mb-4" />
					<p class="text-slate-600 dark:text-slate-400">No folders found</p>
					<p class="text-sm text-slate-500 dark:text-slate-500 mt-2">This directory doesn't contain any subdirectories</p>
				</div>
			</div>
		{:else}
			<div class="space-y-2 transition-opacity duration-300 {loading ? 'opacity-75' : 'opacity-100'}">
				{#each items as item (item.path)}
					<div 
						class="flex items-center space-x-3 py-3 px-4 rounded-xl border transition-all duration-200 cursor-pointer {selectedPath === item.path 
							? 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-700' 
							: isActiveProject(item.path)
								? 'bg-violet-50/50 dark:bg-violet-900/10 border-violet-300 dark:border-violet-700/50 hover:bg-violet-100/50 dark:hover:bg-violet-900/20'
							: isRecentProject(item.path) 
								? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/50 hover:bg-green-100 dark:hover:bg-green-900/20' 
								: 'bg-slate-50 dark:bg-slate-800/30 border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800/50'}"
						onclick={() => {
							if (item.type === 'directory') {
								navigateToFolder(item.path);
							}
						}}
						role="button"
						tabindex="0"
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								if (item.type === 'directory') {
									navigateToFolder(item.path);
								}
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
									name="lucide:file-text" 
									class="text-xl text-slate-500 dark:text-slate-400" 
								/>
							{/if}
						</div>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-2">
								<p class="font-medium text-slate-900 dark:text-slate-100 truncate">
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
								<Icon 
									name="lucide:chevron-right" 
									class="text-sm text-slate-400 dark:text-slate-500" 
								/>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}

	{#snippet footer()}
		<div class="flex items-end justify-between flex-wrap sm:flex-nowrap gap-3 w-full">
			{#if selectedPath}
				<div class="w-full">
					<p class="text-sm text-slate-600 dark:text-slate-400 mb-2">Selected folder:</p>
					<div class="font-mono text-sm bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 break-all">
						{selectedPath}
					</div>
				</div>
			{/if}
			
			<div class="flex items-center justify-between gap-3 flex-none w-full sm:w-auto">
				<!-- <div class="flex items-center gap-3 ml-auto"> -->
					<!-- <Button variant="outline" onclick={onClose}>
						Cancel
					</Button> -->
					<Button 
						onclick={confirmSelection} 
						disabled={!selectedPath}
						class="disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto"
					>
						Select Project
					</Button>
				<!-- </div> -->
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
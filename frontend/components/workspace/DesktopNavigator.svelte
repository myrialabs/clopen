<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { projectState, setCurrentProject, removeProject } from '$frontend/stores/core/projects.svelte';
	import { workspaceState, toggleNavigator } from '$frontend/stores/ui/workspace.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import { projectStatusService } from '$frontend/services/project';
	import { presenceState, getProjectStatusColor } from '$frontend/stores/core/presence.svelte';
	import type { Project } from '$shared/types/database/schema';
	import { debug } from '$shared/utils/logger';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import FolderBrowser from '$frontend/components/common/form/FolderBrowser.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ViewMenu from '$frontend/components/workspace/ViewMenu.svelte';
	import TunnelButton from '$frontend/components/tunnel/TunnelButton.svelte';
	import TunnelModal from '$frontend/components/tunnel/TunnelModal.svelte';
	import DbClientButton from '$frontend/components/db-client/DbClientButton.svelte';
	import DbClientModal from '$frontend/components/db-client/DbClientModal.svelte';
	import ProjectUserAvatars from '$frontend/components/common/display/ProjectUserAvatars.svelte';
	import ws from '$frontend/utils/ws';

	// State
	let existingProjects = $state<Project[]>([]);
	let showFolderBrowser = $state(false);
	let showDeleteDialog = $state(false);
	let projectToDelete = $state<Project | null>(null);
	let searchQuery = $state('');
	let showTunnelModal = $state(false);
	let showDbClientModal = $state(false);
	let hoveredProject = $state<Project | null>(null);
	let tooltipY = $state(0);
	let tooltipX = $state(0);

	// Derived
	const isCollapsed = $derived(workspaceState.navigatorCollapsed);
	const currentProjectId = $derived(projectState.currentProject?.id);
	const navigatorWidth = $derived(
		workspaceState.navigatorCollapsed ? 48 : Math.round(workspaceState.navigatorWidth * (settings.fontSize / 13))
	);

	const filteredProjects = $derived(() => {
		if (!searchQuery.trim()) return existingProjects;
		const query = searchQuery.toLowerCase();
		return existingProjects.filter(
			(p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
		);
	});

	// Load projects
	async function loadProjects() {
		try {
			const projects = await ws.http('projects:list', {});
			if (Array.isArray(projects)) {
				existingProjects = projects;
			}
		} catch (error) {
			debug.error('workspace', 'Failed to load projects:', error);
		}
	}

	// Select project
	async function selectProject(project: Project) {
		await setCurrentProject(project);
		await projectStatusService.startTracking(project.id);

		// Update last opened (handled by projects:get in setCurrentProject)
	}

	// Create project from folder
	async function createProjectFromFolder(folderPath: string, folderName: string) {
		try {
			showFolderBrowser = false;

			// Check if already exists
			const existing = existingProjects.find((p) => p.path === folderPath);
			if (existing) {
				await selectProject(existing);
				return;
			}

			const newProject = await ws.http('projects:create', { name: folderName, path: folderPath });

			await setCurrentProject(newProject);
			await loadProjects();
		} catch (error) {
			debug.error('workspace', 'Failed to create project:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'Failed to create project',
				duration: 5000
			});
		}
	}

	// Delete project
	let deletingProject = $state(false);

	async function confirmDeleteProject(mode: 'remove' | 'full') {
		if (!projectToDelete || deletingProject) return;
		const deleteId = projectToDelete.id!;
		deletingProject = true;

		try {
			await ws.http('projects:delete', { id: deleteId, mode });
			removeProject(deleteId);
			existingProjects = existingProjects.filter(p => p.id !== deleteId);
			showDeleteDialog = false;
			projectToDelete = null;
		} catch (error) {
			debug.error('workspace', 'Failed to delete project:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'Failed to delete project',
				duration: 5000
			});
		} finally {
			deletingProject = false;
		}
	}

	// Status color for project indicator — uses shared helper from presence store

	// Close folder browser
	function closeFolderBrowser() {
		showFolderBrowser = false;
	}

	// Close delete dialog
	function closeDeleteDialog() {
		showDeleteDialog = false;
		projectToDelete = null;
	}

	// Handle delete button click
	function handleDeleteClick(project: Project, event: MouseEvent) {
		event.stopPropagation();
		projectToDelete = project;
		showDeleteDialog = true;
	}

	onMount(async () => {
		await loadProjects();
	});

	// Get project initials (max 2 characters)
	function getProjectInitials(name: string): string {
		const words = name.trim().split(/[\s-_]+/);
		if (words.length >= 2) {
			// Multiple words: take first letter of first 2 words
			return (words[0][0] + words[1][0]).toUpperCase();
		}
		// Single word: take first 2 letters
		return name.substring(0, 2).toUpperCase();
	}

	function showProjectTooltip(project: Project, event: MouseEvent) {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		tooltipX = rect.right + 8;
		tooltipY = rect.top + rect.height / 2;
		hoveredProject = project;
	}

	function hideProjectTooltip() {
		hoveredProject = null;
	}
</script>

<!-- Project Navigator Sidebar -->
<aside
	class="shrink-0 h-full bg-white dark:bg-slate-900/95 border-r border-slate-200 dark:border-slate-800 transition-[width] duration-200 z-20"
	style="width: {navigatorWidth}px"
	aria-label="Project Navigator"
>
	<nav
		class="flex flex-col h-full bg-white dark:bg-slate-900/95 transition-all duration-200 {isCollapsed
			? 'items-center'
			: ''}"
	>
		<!-- Header -->
		<header
			class="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-800 {isCollapsed
				? 'justify-center px-2'
				: ''}"
		>
			{#if !isCollapsed}
				<div class="flex items-center gap-2.5" in:fade={{ duration: 150 }}>
					<img src="/favicon.svg" alt="Clopen" class="w-8 h-8 rounded-lg" />
					<span class="text-base font-semibold text-slate-900 dark:text-slate-100">Clopen</span>
				</div>
			{/if}

			<button
				type="button"
				class="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
				onclick={toggleNavigator}
				aria-label={isCollapsed ? 'Expand navigator' : 'Collapse navigator'}
				title={isCollapsed ? 'Expand' : 'Collapse'}
			>
				<Icon
					name={isCollapsed ? 'lucide:panel-left-open' : 'lucide:panel-left-close'}
					class="w-5 h-5"
				/>
			</button>
		</header>

		{#if !isCollapsed}
			<!-- Search -->
			<div
				class="flex items-center gap-2.5 mx-4 my-3 py-2.5 px-3.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg"
				in:fade={{ duration: 150 }}
			>
				<Icon name="lucide:search" class="w-4 h-4 text-slate-600 dark:text-slate-500 shrink-0" />
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search projects..."
					class="flex-1 bg-transparent border-none outline-none text-slate-900 dark:text-slate-100 text-sm placeholder:text-slate-600 dark:placeholder:text-slate-500"
				/>
			</div>

			<!-- Projects List -->
			<div class="flex-1 flex flex-col min-h-0 px-3" in:fade={{ duration: 150 }}>
				<div
					class="flex items-center justify-between py-2 px-1 text-xs font-semibold text-slate-600 dark:text-slate-500 uppercase tracking-wider"
				>
					<span>Projects</span>
					<button
						type="button"
						class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded-md text-slate-600 dark:text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:text-violet-600"
						onclick={() => (showFolderBrowser = true)}
						aria-label="Add project"
						title="Add project"
					>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</button>
				</div>

				<div class="flex-1 overflow-y-auto flex flex-col">
					{#each filteredProjects() as project (project.id)}
						<div
							class="flex items-center gap-2.5 py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-600 dark:text-slate-400 text-sm text-left cursor-pointer transition-all duration-150 relative group
								hover:bg-violet-500/10
								{currentProjectId === project.id
								? 'bg-violet-500/10 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100'
								: ''}"
							role="button"
							title={project.path}
							tabindex="0"
							onclick={() => selectProject(project)}
							onkeydown={(e) => e.key === 'Enter' && selectProject(project)}
						>
							<div class="relative shrink-0">
								<Icon name="lucide:folder" class="w-4 h-4" />
								<span
									class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-50 dark:border-slate-900/95 {getProjectStatusColor(project.id ?? '')}"
								></span>
							</div>

							<div class="flex-1 flex items-center justify-between gap-2 min-w-0">
								<div class="flex-1 min-w-0">
									<span class="block overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
									<span class="block text-3xs text-slate-400 dark:text-slate-500 overflow-hidden text-ellipsis whitespace-nowrap font-mono leading-tight">{project.path}</span>
								</div>
								<div class="flex items-center gap-1 shrink-0">
									<ProjectUserAvatars projectStatus={presenceState.statuses.get(project.id ?? '')} maxVisible={2} />
									<button
										type="button"
										class="flex items-center justify-center w-6 h-6 bg-transparent border-none rounded-md text-slate-400 dark:text-slate-600 cursor-pointer transition-all duration-150 hover:bg-red-500/20 hover:text-red-500 shrink-0"
										onclick={(e) => handleDeleteClick(project, e)}
										aria-label="Delete project"
										title="Delete"
									>
										<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
									</button>
								</div>
							</div>
						</div>
					{:else}
						<div
							class="flex flex-col items-center gap-3 py-8 px-4 text-slate-600 dark:text-slate-500 text-sm text-center"
						>
							<Icon name="lucide:folder-plus" class="w-8 h-8 opacity-40" />
							<span>No projects yet</span>
							<button
								type="button"
								class="py-2 px-4 bg-violet-500/10 dark:bg-violet-500/15 border border-violet-500/20 dark:border-violet-500/30 rounded-lg text-violet-600 text-xs font-medium cursor-pointer transition-all duration-150 hover:bg-violet-500/20 dark:hover:bg-violet-500/25"
								onclick={() => (showFolderBrowser = true)}
							>
								Add your first project
							</button>
						</div>
					{/each}
				</div>
			</div>

			<!-- Footer Actions -->
			<footer class="flex flex-col p-3 border-t border-slate-200 dark:border-slate-800" in:fade={{ duration: 150 }}>
				<ViewMenu />
				<TunnelButton onClick={() => (showTunnelModal = true)} />
				<DbClientButton onClick={() => (showDbClientModal = true)} />

				<button
					type="button"
					class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-slate-500 text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => openSettingsModal()}
				>
					<Icon name="lucide:settings" class="w-4 h-4" />
					<span>Settings</span>
				</button>
			</footer>
		{:else}
			<!-- Collapsed State: Icon Buttons -->
			<div class="flex flex-col items-center pt-4 px-2 shrink-0">
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 relative hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => (showFolderBrowser = true)}
					title="Add Project"
				>
					<Icon name="lucide:folder-plus" class="w-5 h-5" />
				</button>

				<div class="w-6 h-px bg-violet-500/10 my-1"></div>
			</div>

			<div class="flex-1 flex flex-col items-center gap-2 px-2 pb-4 min-h-0 overflow-y-auto">
				{#each existingProjects as project (project.id)}
					{@const projectStatus = presenceState.statuses.get(project.id ?? '')}
					{@const activeUserCount = (projectStatus?.activeUsers || []).length}
					<button
						type="button"
						class="flex items-center justify-center w-9 h-9 shrink-0 border-none rounded-lg cursor-pointer transition-all duration-150 relative font-semibold text-sm
							{currentProjectId === project.id
							? 'bg-violet-500/10 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300'
							: 'bg-slate-200/50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
						onclick={() => selectProject(project)}
						onmouseenter={(e) => showProjectTooltip(project, e)}
						onmouseleave={hideProjectTooltip}
					>
						<span>{getProjectInitials(project.name)}</span>
						<span
							class="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-slate-50 dark:border-slate-900/95 {getProjectStatusColor(project.id ?? '')}"
						></span>
						{#if activeUserCount > 0}
							<span
								class="absolute -top-1 -right-1 min-w-4 h-4 px-0.5 rounded-full bg-violet-500 text-white text-3xs font-bold flex items-center justify-center border-2 border-slate-50 dark:border-slate-900/95"
							>
								{activeUserCount}
							</span>
						{/if}
					</button>
				{/each}
			</div>

			<footer class="flex flex-col gap-2 py-3 px-2 border-t border-slate-200 dark:border-slate-800">
				<ViewMenu collapsed={true} />
				<TunnelButton collapsed={true} onClick={() => (showTunnelModal = true)} />
				<DbClientButton collapsed={true} onClick={() => (showDbClientModal = true)} />

				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 relative hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => openSettingsModal()}
					title="Settings"
				>
					<Icon name="lucide:settings" class="w-5 h-5" />
				</button>
			</footer>
		{/if}
	</nav>
</aside>

<!-- Collapsed project tooltip (fixed position to avoid overflow clipping) -->
{#if hoveredProject}
	<div
		class="fixed z-50 pointer-events-none flex flex-col py-1.5 px-2.5 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 shadow-lg whitespace-nowrap"
		style="left: {tooltipX}px; top: {tooltipY}px; transform: translateY(-50%);"
	>
		<span class="text-xs font-semibold text-slate-900 dark:text-slate-100">{hoveredProject.name}</span>
		<span class="text-3xs font-mono text-slate-500 dark:text-slate-400">{hoveredProject.path}</span>
	</div>
{/if}

<!-- Folder Browser (includes its own Modal) -->
<FolderBrowser
	bind:isOpen={showFolderBrowser}
	onClose={closeFolderBrowser}
	onSelect={createProjectFromFolder}
/>

<!-- Delete Confirmation Dialog -->
<Dialog
	bind:isOpen={showDeleteDialog}
	onClose={closeDeleteDialog}
	type="warning"
	title="Remove Project"
	showCancel={false}
>
	{#snippet children()}
		<div class="flex items-start space-x-4">
			<div class="bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700/50 rounded-xl p-3 border">
				<Icon name="lucide:triangle-alert" class="w-6 h-6 text-amber-600 dark:text-amber-400" />
			</div>
			<div class="flex-1">
				<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Remove Project</h3>
				<p class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
					How would you like to remove <strong>"{projectToDelete?.name}"</strong>?
				</p>
			</div>
		</div>
		<div class="flex flex-col gap-2 pt-2">
			<button
				onclick={() => confirmDeleteProject('remove')}
				disabled={deletingProject}
				class="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 text-left disabled:opacity-50"
			>
				<Icon name="lucide:eye-off" class="w-5 h-5 text-slate-500 shrink-0" />
				<div class="flex-1 min-w-0">
					<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Remove from list</p>
					<p class="text-xs text-slate-500 dark:text-slate-400">Sessions will be restored when you re-add this project.</p>
				</div>
			</button>
			<button
				onclick={() => confirmDeleteProject('full')}
				disabled={deletingProject}
				class="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 text-left disabled:opacity-50"
			>
				<Icon name="lucide:trash-2" class="w-5 h-5 text-slate-500 shrink-0" />
				<div class="flex-1 min-w-0">
					<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Delete with all data</p>
					<p class="text-xs text-slate-500 dark:text-slate-400">Delete all sessions, snapshots, and related data.</p>
				</div>
			</button>
			<button
				onclick={closeDeleteDialog}
				class="w-full py-2 text-sm font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
			>
				Cancel
			</button>
			<p class="text-xs text-slate-400 dark:text-slate-500 text-center">Your project folder on disk will not be affected.</p>
		</div>
	{/snippet}
</Dialog>

<!-- Tunnel Modal -->
<TunnelModal bind:isOpen={showTunnelModal} onClose={() => (showTunnelModal = false)} />

<!-- DB Client Modal -->
<DbClientModal bind:isOpen={showDbClientModal} onClose={() => (showDbClientModal = false)} />

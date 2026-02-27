<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { projectState, setCurrentProject, removeProject } from '$frontend/lib/stores/core/projects.svelte';
	import { workspaceState, toggleNavigator } from '$frontend/lib/stores/ui/workspace.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import { openSettingsModal } from '$frontend/lib/stores/ui/settings-modal.svelte';
	import { projectStatusService } from '$frontend/lib/services/project';
	import { presenceState } from '$frontend/lib/stores/core/presence.svelte';
	import type { Project } from '$shared/types/database/schema';
	import { debug } from '$shared/utils/logger';
	import FolderBrowser from '$frontend/lib/components/common/FolderBrowser.svelte';
	import Dialog from '$frontend/lib/components/common/Dialog.svelte';
	import ViewMenu from '$frontend/lib/components/workspace/ViewMenu.svelte';
	import TunnelButton from '$frontend/lib/components/tunnel/TunnelButton.svelte';
	import TunnelModal from '$frontend/lib/components/tunnel/TunnelModal.svelte';
	import ProjectUserAvatars from '$frontend/lib/components/common/ProjectUserAvatars.svelte';
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import ws from '$frontend/lib/utils/ws';

	// State
	let existingProjects = $state<Project[]>([]);
	let showFolderBrowser = $state(false);
	let showDeleteDialog = $state(false);
	let projectToDelete = $state<Project | null>(null);
	let searchQuery = $state('');
	let showTunnelModal = $state(false);

	// Derived
	const isCollapsed = $derived(workspaceState.navigatorCollapsed);
	const currentProjectId = $derived(projectState.currentProject?.id);
	const navigatorWidth = $derived(
		workspaceState.navigatorCollapsed ? 48 : workspaceState.navigatorWidth
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
	async function confirmDeleteProject() {
		if (!projectToDelete) return;
		const deleteId = projectToDelete.id!;

		try {
			await ws.http('projects:delete', { id: deleteId });
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
		}
	}

	// Get status color from presence data (single source of truth)
	// Green only when the project is the CURRENT project AND the current chat session has an active stream
	function getStatusColor(projectId: string): string {
		if (projectId !== currentProjectId) return 'bg-slate-500/30';
		const status = presenceState.statuses.get(projectId);
		const currentChatSessionId = sessionState.currentSession?.id;
		if (!status?.streams || !currentChatSessionId) return 'bg-slate-500/30';
		const hasActiveForSession = status.streams.some(
			(s: any) => s.status === 'active' && s.chatSessionId === currentChatSessionId
		);
		if (hasActiveForSession) return 'bg-emerald-500';
		return 'bg-slate-500/30';
	}

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
</script>

<!-- Project Navigator Sidebar -->
<aside
	class="shrink-0 h-full bg-white dark:bg-slate-900/95 border-r border-slate-200 dark:border-slate-800 transition-[width] duration-200 z-20"
	style="width: {navigatorWidth}px"
	aria-label="Project Navigator"
>
	<nav
		class="flex flex-col h-full bg-slate-50 dark:bg-slate-900/95 transition-all duration-200 {isCollapsed
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
									class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-50 dark:border-slate-900/95 {getStatusColor(project.id ?? '')}"
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
			<div class="flex-1 flex flex-col items-center gap-2 py-4 px-2">
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 relative hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => (showFolderBrowser = true)}
					title="Add Project"
				>
					<Icon name="lucide:folder-plus" class="w-5 h-5" />
				</button>

				<div class="w-6 h-px bg-violet-500/10 my-1"></div>

				{#each existingProjects.slice(0, 5) as project (project.id)}
					{@const projectStatus = presenceState.statuses.get(project.id ?? '')}
					{@const activeUserCount = (projectStatus?.activeUsers || []).length}
					<button
						type="button"
						class="flex items-center justify-center w-9 h-9 border-none rounded-lg cursor-pointer transition-all duration-150 relative font-semibold text-sm
							{currentProjectId === project.id
							? 'bg-violet-500/10 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300'
							: 'bg-slate-200/50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100'}"
						onclick={() => selectProject(project)}
						title={project.name}
					>
						<span>{getProjectInitials(project.name)}</span>
						<span
							class="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full border-2 border-slate-50 dark:border-slate-900/95 {getStatusColor(project.id ?? '')}"
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
	type="error"
	title="Delete Project"
	message='This will remove "{projectToDelete?.name}" from your project list. The actual project files on disk will not be deleted.'
	confirmText="Delete"
	cancelText="Cancel"
	onConfirm={confirmDeleteProject}
/>

<!-- Tunnel Modal -->
<TunnelModal bind:isOpen={showTunnelModal} onClose={() => (showTunnelModal = false)} />

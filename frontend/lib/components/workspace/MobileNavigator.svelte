<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import Dialog from '$frontend/lib/components/common/Dialog.svelte';
	import {
		workspaceState,
		setActiveMobilePanel,
		type PanelId
	} from '$frontend/lib/stores/ui/workspace.svelte';
	import { projectState, removeProject } from '$frontend/lib/stores/core/projects.svelte';
	import { presenceState } from '$frontend/lib/stores/core/presence.svelte';
	import { openSettingsModal } from '$frontend/lib/stores/ui/settings-modal.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import TunnelButton from '$frontend/lib/components/tunnel/TunnelButton.svelte';
	import TunnelModal from '$frontend/lib/components/tunnel/TunnelModal.svelte';
	import type { Project } from '$shared/types/database/schema';
	import FolderBrowser from '$frontend/lib/components/common/FolderBrowser.svelte';
	import ProjectUserAvatars from '$frontend/lib/components/common/ProjectUserAvatars.svelte';
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import ws from '$frontend/lib/utils/ws';
	import { debug } from '$shared/utils/logger';

	// Modal states
	let showTunnelModal = $state(false);

	// Project dropdown state
	let showProjectMenu = $state(false);
	let showFolderBrowser = $state(false);
	let showDeleteDialog = $state(false);
	let projectToDelete = $state<Project | null>(null);
	let searchQuery = $state('');

	// Get current project status from shared store
	const currentProjectStatus = $derived(
		projectState.currentProject?.id
			? presenceState.statuses.get(projectState.currentProject.id)
			: undefined
	);

	const panels: { id: PanelId; icon: IconName; label: string }[] = [
		{ id: 'chat', icon: 'lucide:bot', label: 'AI' },
		{ id: 'files', icon: 'lucide:folder', label: 'Files' },
		{ id: 'git', icon: 'lucide:git-branch', label: 'Source Control' },
		{ id: 'terminal', icon: 'lucide:terminal', label: 'Terminal' },
		{ id: 'preview', icon: 'lucide:globe', label: 'Preview' }
	];

	// Filtered projects based on search query
	const filteredProjects = $derived(() => {
		if (!searchQuery.trim()) return projectState.projects;
		const query = searchQuery.toLowerCase();
		return projectState.projects.filter(
			(p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
		);
	});

	function selectPanel(panelId: PanelId) {
		setActiveMobilePanel(panelId);
	}

	function toggleProjectMenu() {
		showProjectMenu = !showProjectMenu;
		if (!showProjectMenu) {
			searchQuery = '';
		}
	}

	// Get status color from presence data (single source of truth)
	// Green only when the project is the CURRENT project AND the current chat session has an active stream
	function getStatusColor(projectId: string): string {
		const currentProjectId = projectState.currentProject?.id;
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

	function openAddProject() {
		showProjectMenu = false;
		showFolderBrowser = true;
	}

	function closeFolderBrowser() {
		showFolderBrowser = false;
	}

	function closeProjectMenu() {
		showProjectMenu = false;
		searchQuery = '';
	}

	function handleDeleteClick(project: Project, event: MouseEvent) {
		event.stopPropagation();
		projectToDelete = project;
		showDeleteDialog = true;
	}

	async function confirmDeleteProject() {
		if (!projectToDelete) return;
		const deleteId = projectToDelete.id!;

		try {
			await ws.http('projects:delete', { id: deleteId });
			removeProject(deleteId);
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

	function closeDeleteDialog() {
		showDeleteDialog = false;
		projectToDelete = null;
	}

	async function createProjectFromFolder(folderPath: string, folderName: string) {
		try {
			showFolderBrowser = false;

			const projects = await ws.http('projects:list', {});

			const existingProject = projects
				? projects.find((p: any) => p.path === folderPath)
				: null;

			if (existingProject) {
				const { setCurrentProject } = await import('$frontend/lib/stores/core/projects.svelte');
				setCurrentProject(existingProject);
				return;
			}

			const newProject = await ws.http('projects:create', { name: folderName, path: folderPath });

			if (newProject) {
				const { setCurrentProject } = await import('$frontend/lib/stores/core/projects.svelte');
				setCurrentProject(newProject);
			}
		} catch (error) {
			console.error('Failed to create project:', error);
		}
	}
</script>

<header
	class="flex items-center bg-white/90 dark:bg-slate-900/98 py-2 px-3 gap-2 relative z-30"
>
	<!-- Project Selector -->
	<button
		type="button"
		class="flex items-center gap-2 px-3 py-2.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 text-sm font-medium cursor-pointer transition-all duration-150 flex-1 min-w-0 active:bg-violet-500/10"
		onclick={toggleProjectMenu}
		aria-expanded={showProjectMenu}
		aria-haspopup="menu"
	>
		<div class="relative shrink-0"><Icon name="lucide:folder-open" class="w-4 h-4" /><span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-100 dark:border-slate-800 {getStatusColor(projectState.currentProject?.id ?? '')}"></span></div>
		<span class="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">
			{projectState.currentProject?.name ?? 'No Project'}
		</span>
		<div class="shrink-0" onclick={(e) => e.stopPropagation()}>
			<ProjectUserAvatars projectStatus={currentProjectStatus} maxVisible={2} />
		</div>
		<Icon name="lucide:chevron-down" class="w-3 h-3 opacity-60 shrink-0" />
	</button>

	<!-- Panel Tabs (Icon Only) -->
	<div
		class="flex gap-1 bg-slate-100/80 dark:bg-slate-800/50 p-1 border border-slate-200 dark:border-slate-800 rounded-lg"
		role="tablist"
		aria-label="Panel Tabs"
	>
		{#each panels as panel}
			<button
				type="button"
				class="flex items-center justify-center w-9 h-8 bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150
					{workspaceState.activeMobilePanel === panel.id
					? 'bg-violet-500/10 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100 shadow-violet-500/20'
					: 'active:bg-violet-500/10'}"
				role="tab"
				aria-selected={workspaceState.activeMobilePanel === panel.id}
				aria-controls={`panel-${panel.id}`}
				aria-label={panel.label}
				title={panel.label}
				onclick={() => selectPanel(panel.id)}
			>
				<Icon name={panel.icon} class="w-5 h-5" />
			</button>
		{/each}
	</div>

	<!-- Action Buttons -->
	<div
		class="flex gap-1 bg-slate-100/80 dark:bg-slate-800/50 p-1 border border-slate-200 dark:border-slate-800 rounded-lg"
		role="tablist"
		aria-label="Action Buttons"
	>
		<!-- Tunnel Button -->
		<TunnelButton collapsed={true} onClick={() => (showTunnelModal = true)} mobile={true} />

		<!-- Settings Button -->
		<button
			type="button"
			class="flex items-center justify-center w-9 h-8 bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 active:bg-violet-500/10"
			role="tab"
			onclick={() => openSettingsModal()}
			aria-label="Settings"
			title="Settings"
		>
			<Icon name="lucide:settings" class="w-5 h-5" />
		</button>
	</div>
</header>

<!-- Project Selection Modal -->
<Modal bind:isOpen={showProjectMenu} onClose={closeProjectMenu} size="md">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<h2 class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">Projects</h2>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 bg-violet-500/10 dark:bg-violet-500/15 border border-violet-500/20 rounded-lg text-violet-600 dark:text-violet-400 cursor-pointer transition-all duration-150 hover:bg-violet-500/20"
					onclick={openAddProject}
					aria-label="Add project"
					title="Add project"
				>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</button>
				<button
					type="button"
					class="p-1.5 md:p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors"
					onclick={closeProjectMenu}
					aria-label="Close modal"
				>
					<svg class="w-4 h-4 md:w-5 md:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M6 18L18 6M6 6l12 12"
						/>
					</svg>
				</button>
			</div>
		</div>
	{/snippet}

	{#snippet children()}
		<!-- Search Box -->
		{#if projectState.projects.length > 0}
			<div class="mb-4">
				<div
					class="flex items-center gap-2 py-2.5 px-3.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg"
				>
					<Icon name="lucide:search" class="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Search projects..."
						class="flex-1 bg-transparent border-none outline-none text-slate-900 dark:text-slate-100 text-sm placeholder:text-slate-500 dark:placeholder:text-slate-400"
					/>
					{#if searchQuery}
						<button
							type="button"
							class="flex items-center justify-center w-5 h-5 bg-transparent border-none rounded text-slate-400 cursor-pointer transition-all duration-150 hover:text-slate-600 dark:hover:text-slate-300"
							onclick={() => (searchQuery = '')}
							aria-label="Clear search"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					{/if}
				</div>
			</div>
		{/if}

		{#if projectState.projects.length === 0}
			<div class="flex flex-col items-center gap-3 py-8 text-slate-600 dark:text-slate-500 text-sm">
				<Icon name="lucide:folder-x" class="w-12 h-12 text-slate-400 opacity-40" />
				<p class="font-medium">No projects yet</p>
				<p class="text-xs text-slate-500 dark:text-slate-500">Create your first project below</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each filteredProjects() as project (project.id)}
					{@const isActive = projectState.currentProject?.id === project.id}
					<div
						class="flex items-center gap-2 w-full p-3 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 text-sm text-left transition-all duration-150
							{isActive
							? 'border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/10'
							: ''}"
					>
						<button
							type="button"
							class="flex items-center gap-3 flex-1 min-w-0 bg-transparent border-none cursor-pointer text-left"
							onclick={() => {
								import('$frontend/lib/stores/core/projects.svelte').then((m) =>
									m.setCurrentProject(project)
								);
								closeProjectMenu();
							}}
						>
							<div
								class="relative w-8 h-8 {isActive
									? 'bg-violet-200 dark:bg-violet-800/30'
									: 'bg-violet-100 dark:bg-violet-900/20'} rounded-lg flex items-center justify-center flex-shrink-0"
							>
								<Icon name="lucide:folder" class="text-violet-600 dark:text-violet-400 w-4 h-4" />
								<span
									class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 {getStatusColor(project.id ?? '')}"
								></span>
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<p class="font-semibold text-slate-900 dark:text-slate-100 truncate">
										{project.name}
									</p>
									{#if isActive}
										<span
											class="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-300 text-xs font-medium rounded-full"
										>
											<Icon name="lucide:circle-check" class="w-3 h-3" />
											Active
										</span>
									{/if}
								</div>
								<p class="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">
									{project.path}
								</p>
							</div>
						</button>
						<ProjectUserAvatars projectStatus={presenceState.statuses.get(project.id ?? '')} maxVisible={2} />
						<button
							type="button"
							class="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-lg text-slate-400 dark:text-slate-500 cursor-pointer transition-all duration-150 hover:bg-red-500/15 hover:text-red-500 shrink-0"
							onclick={(e) => handleDeleteClick(project, e)}
							aria-label="Delete project"
							title="Delete"
						>
							<Icon name="lucide:trash-2" class="w-4 h-4" />
						</button>
					</div>
				{:else}
					<div
						class="flex flex-col items-center gap-2 py-8 text-slate-500 dark:text-slate-400 text-sm"
					>
						<Icon name="lucide:search-x" class="w-10 h-10 opacity-40" />
						<p class="font-medium">No projects found</p>
						<button
							type="button"
							class="text-xs text-violet-600 dark:text-violet-400 underline cursor-pointer hover:text-violet-700 dark:hover:text-violet-300"
							onclick={() => (searchQuery = '')}
						>
							Clear search
						</button>
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}
</Modal>

<!-- Folder Browser -->
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

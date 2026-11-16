<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import AssistantEntry from './AssistantEntry.svelte';
	import { projectAvatars, statusMeaning } from '$frontend/utils/project-avatar';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { openNeedsYou } from '$frontend/stores/ui/assistant-view.svelte';
	import AssistantMark from './AssistantMark.svelte';
	import { isAssistantProject } from '$shared/utils/assistant-project';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { projectState, removeProject, reorderProjects } from '$frontend/stores/core/projects.svelte';
	import { getProjectStatusColor } from '$frontend/stores/core/presence.svelte';
	import { openSettingsModal } from '$frontend/stores/ui/settings-modal.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import ToolsMenu from '$frontend/components/workspace/ToolsMenu.svelte';
	import WorktreeSwitcher from '$frontend/components/worktree/WorktreeSwitcher.svelte';
	import TunnelModal from '$frontend/components/tunnel/TunnelModal.svelte';
	import RemoteAccessPanel from '$frontend/components/remote-access/RemoteAccessPanel.svelte';
	import DbClientModal from '$frontend/components/db-client/DbClientModal.svelte';
	import SshClientModal from '$frontend/components/ssh-client/SshClientModal.svelte';
	import PortsModal from '$frontend/components/ports/PortsModal.svelte';
	import ContainersModal from '$frontend/components/containers/ContainersModal.svelte';
	import MemoryModal from '$frontend/components/memory/MemoryModal.svelte';
	import NotesModal from '$frontend/components/notes/NotesModal.svelte';
	import WorkModal from '$frontend/components/work/WorkModal.svelte';
	import DeploymentsModal from '$frontend/components/deployments/DeploymentsModal.svelte';
	import SettingButton from '$frontend/components/settings/SettingButton.svelte';
	import type { Project } from '$shared/types/database/schema';
	import FolderBrowser from '$frontend/components/common/form/FolderBrowser.svelte';
	import ProjectInfoModal from '$frontend/components/workspace/ProjectInfoModal.svelte';
	import ProjectContextMenu, {
		type ProjectContextMenuItem
	} from '$frontend/components/workspace/ProjectContextMenu.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';
	import {
		quickPanelsState,
		openNewProjectDialog,
		closeNewProjectDialog,
		openRemoteAccessDialog,
		closeRemoteAccessDialog,
		openTunnelDialog,
		closeTunnelDialog,
		openDbClientDialog,
		closeDbClientDialog,
		openSshClientDialog,
		closeSshClientDialog,
		openPortsDialog,
		closeContainersDialog,
		openContainersDialog,
		closePortsDialog,
		openMemoryDialog,
		closeMemoryDialog,
		openNotesDialog,
		closeNotesDialog,
		openWorkDialog,
		closeWorkDialog,
		openDeploymentsDialog,
		closeDeploymentsDialog
	} from '$frontend/stores/ui/quick-panels.svelte';
	import { openCommandPalette } from '$frontend/stores/ui/command-palette.svelte';
	import {
		projectSelectionState,
		enterSelectionMode,
		exitSelectionMode,
		toggleProjectSelection,
		toggleSelectAllProjects,
		areAllSelected,
		retainSelection,
		isProjectSelected,
		isProjectPinned,
		toggleProjectPin,
		archiveProjects,
		restoreProjects,
		pruneProject,
		visibleProjects,
		archivedProjects
	} from '$frontend/stores/ui/project-selection.svelte';

	// Project dropdown state
	let showProjectMenu = $state(false);
	let showDeleteDialog = $state(false);
	let showBulkDeleteDialog = $state(false);
	let bulkDeleting = $state(false);
	let projectToDelete = $state<Project | null>(null);
	let showProjectInfo = $state(false);
	let projectInfoProject = $state<Project | null>(null);
	let archivedExpanded = $state(false);
	let contextMenuProject = $state<Project | null>(null);
	let contextMenuX = $state(0);
	let contextMenuY = $state(0);
	let contextMenuArchived = $state(false);

	// Home is always there and listed on its own, so "no projects" means none besides it.
	const avatars = $derived(projectAvatars(projectState.projects));
	const avatarOf = (project: { id: string }) => avatars.get(project.id) ?? { initials: '?', colour: 'bg-slate-500/15 text-slate-600' };
	const realProjectCount = $derived(projectState.projects.filter((project) => !isAssistantProject(project)).length);
	const selectionActive = $derived(projectSelectionState.active);
	const selectionCount = $derived(projectSelectionState.selectedIds.length);

	const contextMenuPinned = $derived(isProjectPinned(contextMenuProject?.id));
	// Same menu content as Desktop, reached through the row's ⋮ button (and
	// long-press where the browser fires `contextmenu`).
	const contextMenuItems = $derived<ProjectContextMenuItem[]>([
		...(contextMenuArchived
			? [{ id: 'restore', label: 'Restore', icon: 'lucide:archive-restore' } as ProjectContextMenuItem]
			: [
					contextMenuPinned
						? ({ id: 'pin', label: 'Unpin', icon: 'lucide:pin-off' } as ProjectContextMenuItem)
						: ({ id: 'pin', label: 'Pin', icon: 'lucide:pin' } as ProjectContextMenuItem),
					{ id: 'archive', label: 'Archive', icon: 'lucide:archive' } as ProjectContextMenuItem
				]),
		{ id: 'info', label: 'Details', icon: 'lucide:info' },
		{ id: 'delete', label: 'Delete', icon: 'lucide:trash-2', danger: true }
	]);

	function openProjectContextMenu(project: Project, event: MouseEvent, archived = false) {
		event.preventDefault();
		event.stopPropagation();
		contextMenuX = event.clientX;
		contextMenuY = event.clientY;
		contextMenuProject = project;
		contextMenuArchived = archived;
	}

	function closeProjectContextMenu() {
		contextMenuProject = null;
		contextMenuArchived = false;
	}

	function archiveSingleProject(project: Project) {
		// Archive is local-only: the project leaves the main list for the
		// Archived section, sessions and data are untouched.
		const done = archiveProjects([project.id]);
		if (done.length === 0) return;
		addNotification({
			type: 'success',
			title: 'Project archived',
			message: `"${project.name}" moved to Archived`,
			duration: 4000
		});
	}

	function handleContextMenuSelect(action: string) {
		const project = contextMenuProject;
		if (!project) return;
		if (action === 'restore') {
			handleRestore(project);
		} else if (action === 'pin') {
			toggleProjectPin(project.id);
		} else if (action === 'archive') {
			archiveSingleProject(project);
		} else if (action === 'info') {
			projectInfoProject = project;
			showProjectInfo = true;
		} else if (action === 'delete') {
			projectToDelete = project;
			showDeleteDialog = true;
		}
	}

	// Archived projects are excluded from the main list
	const filteredProjects = $derived(() => {
		return visibleProjects(projectState.projects);
	});

	const archivedList = $derived(() => {
		return archivedProjects(projectState.projects);
	});

	// ── Reorder by touch: hold the grip and drag; the row under the finger is where it lands ──
	// (HTML5 drag-and-drop, the desktop's way, does not fire for touch.)
	let movingProjectId = $state<string | null>(null);
	let overProjectId = $state<string | null>(null);

	function startProjectMove(event: PointerEvent, projectId: string) {
		if (selectionActive || filteredProjects().length < 2) return;
		event.preventDefault();
		movingProjectId = projectId;
		const move = (moved: PointerEvent) => {
			const row = (document.elementFromPoint(moved.clientX, moved.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-project-row]');
			overProjectId = row?.dataset.projectRow ?? null;
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			if (movingProjectId && overProjectId && overProjectId !== movingProjectId) reorderProjects(movingProjectId, overProjectId);
			movingProjectId = null;
			overProjectId = null;
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}

	function toggleProjectMenu() {
		showProjectMenu = !showProjectMenu;
	}

	// Status color for project indicator — uses shared helper from presence store

	function openAddProject() {
		showProjectMenu = false;
		openNewProjectDialog();
	}

	function closeProjectMenu() {
		showProjectMenu = false;
		exitSelectionMode();
	}

	const allVisibleSelected = $derived(
		filteredProjects().length > 0 && areAllSelected(filteredProjects().map((p) => p.id))
	);

	// Searching narrows the list the toolbar counts against, so drop picks that
	// scrolled out of reach — otherwise the counter reads "4/1" and a bulk
	// action would hit projects the user can no longer see.
	$effect(() => {
		retainSelection(filteredProjects().map((p) => p.id));
	});

	let selectAllEl = $state<HTMLInputElement | undefined>();

	// Partial selection renders the Select All checkbox as indeterminate.
	$effect(() => {
		if (selectAllEl) {
			selectAllEl.indeterminate = selectionCount > 0 && !allVisibleSelected;
		}
	});

	const bulkDeleteProjects = $derived(
		projectSelectionState.selectedIds
			.map((id) => projectState.projects.find((p) => p.id === id))
			.filter((p): p is Project => Boolean(p))
	);

	function handleToggleSelectAll() {
		toggleSelectAllProjects(filteredProjects().map((p) => p.id));
	}

	function handleBulkDeleteClick() {
		if (selectionCount === 0 || bulkDeleting) return;
		showBulkDeleteDialog = true;
	}

	function closeBulkDeleteDialog() {
		if (bulkDeleting) return;
		showBulkDeleteDialog = false;
	}

	async function confirmBulkDelete() {
		if (bulkDeleting || selectionCount === 0) return;
		const ids = [...projectSelectionState.selectedIds];
		bulkDeleting = true;
		let deleted = 0;
		try {
			for (const id of ids) {
				try {
					await ws.http('projects:delete', { id, mode: 'full' });
					removeProject(id);
					pruneProject(id);
					deleted++;
				} catch (error) {
					// One failure must not strand the rest of the batch; the ones
					// that failed stay selected so the user can retry just those.
					debug.error('workspace', `Failed to delete project ${id}:`, error);
				}
			}
		} finally {
			bulkDeleting = false;
		}

		const failed = ids.length - deleted;
		if (deleted > 0) {
			addNotification({
				type: 'success',
				title: 'Projects deleted',
				message: `${deleted} project${deleted === 1 ? '' : 's'} deleted`,
				duration: 4000
			});
		}
		if (failed > 0) {
			addNotification({
				type: 'error',
				title: 'Error',
				message: `Failed to delete ${failed} project${failed === 1 ? '' : 's'}`,
				duration: 5000
			});
			return;
		}
		showBulkDeleteDialog = false;
		exitSelectionMode();
	}

	function handleBulkArchive() {
		if (selectionCount === 0) return;
		// Local-only move to the Archived section — one notification, no backend call.
		const done = archiveProjects([...projectSelectionState.selectedIds]);
		if (done.length === 0) return;
		addNotification({
			type: 'success',
			title: 'Projects archived',
			message: `${done.length} project${done.length === 1 ? '' : 's'} moved to Archived`,
			duration: 4000
		});
	}

	function handleRestore(project: Project) {
		const done = restoreProjects([project.id]);
		if (done.length === 0) return;
		addNotification({
			type: 'success',
			title: 'Project restored',
			message: `"${project.name}" moved back to the list`,
			duration: 4000
		});
	}

	function closeProjectInfo() {
		showProjectInfo = false;
	}

	let deletingProject = $state(false);

	async function confirmDeleteProject(mode: 'remove' | 'full') {
		if (!projectToDelete || deletingProject) return;
		const deleteId = projectToDelete.id!;
		deletingProject = true;

		try {
			await ws.http('projects:delete', { id: deleteId, mode });
			removeProject(deleteId);
			pruneProject(deleteId);
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

	function closeDeleteDialog() {
		showDeleteDialog = false;
		projectToDelete = null;
	}

	async function createProjectFromFolder(folderPath: string, folderName: string) {
		try {
			closeNewProjectDialog();

			const projects = await ws.http('projects:list', {});

			const existingProject = projects
				? projects.find((p: any) => p.path === folderPath)
				: null;

			if (existingProject) {
				const { setCurrentProject } = await import('$frontend/stores/core/projects.svelte');
				setCurrentProject(existingProject);
				return;
			}

			const newProject = await ws.http('projects:create', { name: folderName, path: folderPath });

			if (newProject) {
				const { setCurrentProject } = await import('$frontend/stores/core/projects.svelte');
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
		class="flex items-center gap-2 px-3 py-2 bg-slate-100/80 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 text-sm font-medium cursor-pointer transition-all duration-150 flex-1 min-w-0 active:bg-violet-500/10"
		onclick={toggleProjectMenu}
		aria-expanded={showProjectMenu}
		aria-haspopup="menu"
	>
		<div class="relative shrink-0">{#if isAssistantProject(projectState.currentProject)}<AssistantMark class="w-4.5 h-4.5 rounded" />{:else}<Icon name="lucide:folder-open" class="w-4 h-4" />{/if}<span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-100 dark:border-slate-800 {getProjectStatusColor(projectState.currentProject?.id ?? '')}"></span></div>
		<span class="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">
			{projectState.currentProject?.name ?? 'No Project'}
		</span>
		<Icon name="lucide:chevron-down" class="w-3 h-3 opacity-60 shrink-0" />
	</button>

	<!-- Action Buttons -->
	<div
		class="flex gap-1 bg-slate-100/80 dark:bg-slate-800/50 px-1 py-0.5 border border-slate-200 dark:border-slate-800 rounded-lg"
		role="tablist"
		aria-label="Action Buttons"
	>
		<!-- Tools -->
		<WorktreeSwitcher collapsed={true} mobile={true} />
		<ToolsMenu
			collapsed={true}
			mobile={true}
			onRemoteAccess={openRemoteAccessDialog}
			onPublicTunnel={openTunnelDialog}
			onDbClient={openDbClientDialog}
					onSshClient={openSshClientDialog}
					onPorts={openPortsDialog}
					onContainers={openContainersDialog}
					onMemory={openMemoryDialog}
					onNotes={openNotesDialog}
					onWork={() => openWorkDialog()}
					onDeployments={() => openDeploymentsDialog()}
		/>

		<!-- Needs you: what Clopen is waiting on -->
		<button
			type="button"
			class="relative flex items-center justify-center w-9 h-8 bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 active:bg-violet-500/10"
			onclick={openNeedsYou}
			aria-label="Needs you{assistantStore.needsYou.length ? ` (${assistantStore.needsYou.length} waiting)` : ''}"
			title="Needs you"
		>
			<Icon name="lucide:bell" class="w-4.5 h-4.5" />
			{#if assistantStore.needsYou.length > 0}
				<span class="absolute top-0 right-0.5 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-3xs font-bold flex items-center justify-center">{assistantStore.needsYou.length}</span>
			{/if}
		</button>

		<!-- Quick Search Button -->
		<button
			type="button"
			class="flex items-center justify-center w-9 h-8 bg-transparent border-none rounded-md text-slate-500 cursor-pointer transition-all duration-150 active:bg-violet-500/10"
			onclick={openCommandPalette}
			aria-label="Quick search"
			title="Quick search"
		>
			<Icon name="lucide:search" class="w-4.5 h-4.5" />
		</button>

		<!-- Settings Button -->
		<SettingButton collapsed={true} mobile={true} onClick={() => openSettingsModal()} />
	</div>
</header>

<!-- Project Selection Modal -->
<Modal bind:isOpen={showProjectMenu} onClose={closeProjectMenu} size="md">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<h2 class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">Projects</h2>
			<div class="flex items-center gap-2">
				{#if !selectionActive}
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600"
						onclick={enterSelectionMode}
						aria-label="Select projects"
						title="Select projects"
					>
						<Icon name="lucide:list-checks" class="w-4 h-4" />
					</button>
				{/if}
				{#if !selectionActive}
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 bg-violet-500/10 dark:bg-violet-500/15 border border-violet-500/20 rounded-lg text-violet-600 dark:text-violet-400 cursor-pointer transition-all duration-150 hover:bg-violet-500/20"
						onclick={openAddProject}
						aria-label="Add project"
						title="Add project"
					>
						<Icon name="lucide:folder-plus" class="w-4 h-4" />
					</button>
				{/if}
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
		<!-- Clopen and the Library. Always first, never part of the list below; "Needs you" has its own button in the header. -->
		<div class="mb-2 pb-2 border-b border-slate-200 dark:border-slate-800">
			<AssistantEntry
				withNeedsYou={false}
				onChat={closeProjectMenu}
				onSelect={(project) => {
					import('$frontend/stores/core/projects.svelte').then((m) => m.setCurrentProject(project));
					closeProjectMenu();
				}}
			/>
		</div>

		{#if selectionActive}
			<!-- Selection toolbar: same single-row layout as Desktop (count left, icon-only actions right). Wraps on narrow screens. -->
			<div
				class="mb-2 flex flex-wrap items-center gap-x-1 gap-y-1 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 px-2 py-1.5"
			>
				<input
					type="checkbox"
					bind:this={selectAllEl}
					checked={allVisibleSelected}
					onchange={handleToggleSelectAll}
					disabled={filteredProjects().length === 0}
					class="h-4 w-4 shrink-0 rounded accent-violet-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
					aria-label="Select all projects"
					title="Select all / clear all"
				/>
				<span
					class="shrink-0 px-1 text-xs font-semibold text-slate-600 dark:text-slate-300 tabular-nums"
					aria-live="polite"
					title="{selectionCount} of {filteredProjects().length} selected"
				>{selectionCount}/{filteredProjects().length}</span>
				<div class="ml-auto flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-slate-400 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-40 disabled:pointer-events-none"
						onclick={handleBulkArchive}
						disabled={selectionCount === 0 || bulkDeleting}
						aria-label="Archive selected projects"
						title="Archive selected"
					>
						<Icon name="lucide:archive" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-slate-400 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-40 disabled:pointer-events-none"
						onclick={handleBulkDeleteClick}
						disabled={selectionCount === 0 || bulkDeleting}
						aria-label="Delete selected projects"
						title="Delete selected"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4" />
					</button>
					<button
						type="button"
						class="flex items-center justify-center w-7 h-7 bg-transparent border-none rounded-md text-slate-400 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-700 dark:hover:text-slate-200"
						onclick={exitSelectionMode}
						aria-label="Close selection mode"
						title="Close selection mode"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
			</div>
		{/if}

		{#if realProjectCount === 0}
			<div class="flex flex-col items-center gap-3 py-8 text-slate-600 dark:text-slate-500 text-sm">
				<Icon name="lucide:folder-x" class="w-12 h-12 text-slate-400 opacity-40" />
				<p class="font-medium">No projects yet</p>
				<p class="text-xs text-slate-500 dark:text-slate-500">Create your first project below</p>
			</div>
		{:else}
			<!-- Compact rows, as on the desktop sidebar: no card around each project. -->
			<div class="space-y-0.5">
				{#each filteredProjects() as project (project.id)}
					{@const isActive = projectState.currentProject?.id === project.id}
					<div
						data-project-row={project.id}
						class="flex items-center w-full text-sm text-left cursor-pointer transition-all duration-150 relative group
							{selectionActive
							? 'gap-2.5 py-2 px-2 bg-transparent border-none rounded-lg text-slate-600 dark:text-slate-400 hover:bg-violet-500/10'
							: `gap-1.5 py-1 pl-0.5 pr-1 bg-transparent border-none rounded-lg text-slate-700 dark:text-slate-300 ${isActive ? 'bg-violet-500/10 dark:bg-violet-500/20 text-slate-900 dark:text-slate-100' : 'active:bg-violet-500/10'}`}
							{movingProjectId === project.id ? 'opacity-50' : ''}
							{overProjectId === project.id && movingProjectId !== project.id ? 'ring-1 ring-violet-500/60' : ''}"
						title={project.path}
						role={selectionActive ? 'button' : undefined}
						tabindex={selectionActive ? 0 : undefined}
						onclick={() => selectionActive && toggleProjectSelection(project.id)}
						oncontextmenu={(event) => openProjectContextMenu(project, event)}
						onkeydown={(e) => {
							if (e.key !== 'Enter' || !selectionActive) return;
							toggleProjectSelection(project.id);
						}}
					>
						{#if selectionActive}
							<input
								type="checkbox"
								checked={isProjectSelected(project.id)}
								onclick={(e) => {
									e.stopPropagation();
									toggleProjectSelection(project.id);
								}}
								class="w-4 h-4 shrink-0 accent-violet-600 cursor-pointer"
								aria-label="Select {project.name}"
							/>
							<div class="flex-1 flex items-center justify-between gap-2 min-w-0">
								<div class="flex-1 min-w-0">
									<span class="block overflow-hidden text-ellipsis whitespace-nowrap">{project.name}</span>
								</div>
								<div class="flex items-center gap-1 shrink-0">
									<!-- Fixed-size pin slot keeps the layout stable, same as Desktop. -->
									<span class="flex h-3.5 w-3.5 items-center justify-center shrink-0" aria-hidden="true">
										{#if isProjectPinned(project.id)}
											<Icon name="lucide:pin" class="w-3.5 h-3.5 text-violet-500" />
										{/if}
									</span>
								</div>
							</div>
						{:else}
							<!-- Always there on a phone (no hover): hold and drag to move the project. -->
							<span
								class="flex items-center justify-center w-6 h-8 shrink-0 text-slate-300 dark:text-slate-600 touch-none cursor-grab"
								onpointerdown={(event) => startProjectMove(event, project.id)}
								role="button"
								tabindex="-1"
								aria-label="Move {project.name}"
							><Icon name="lucide:grip-vertical" class="w-4 h-4" /></span>
							<button
								type="button"
								class="flex items-center gap-2.5 flex-1 min-w-0 bg-transparent border-none cursor-pointer text-left"
								onclick={() => {
									import('$frontend/stores/core/projects.svelte').then((m) =>
										m.setCurrentProject(project)
									);
									closeProjectMenu();
								}}
							>
							<div class="relative w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 text-xs font-semibold {avatarOf(project).colour}" title={statusMeaning(getProjectStatusColor(project.id ?? '')) || undefined}>
								{avatarOf(project).initials}
								{#if statusMeaning(getProjectStatusColor(project.id ?? ''))}
									<span class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 {getProjectStatusColor(project.id ?? '')}"></span>
								{/if}
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<p class="truncate {isActive ? 'font-semibold' : 'font-medium'}">
										{project.name}
									</p>
								</div>
							</div>
						</button>
						<!-- Fixed-size pin slot keeps the action buttons position stable. -->
						<span class="flex h-4 w-4 items-center justify-center shrink-0" aria-hidden="true">
							{#if isProjectPinned(project.id)}
								<Icon name="lucide:pin" class="text-violet-500 w-4 h-4" />
							{/if}
						</span>
							<!-- One ⋮ for every row action, same as Desktop. A long press
							     cannot carry these on its own: iOS Safari does not fire
							     `contextmenu` for a long-pressed div, which would leave
							     Pin and Archive unreachable on iPhone/iPad. -->
							<button
								type="button"
								class="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-lg text-slate-400 dark:text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-violet-600 shrink-0"
								onclick={(e) => openProjectContextMenu(project, e)}
								aria-label="Project actions"
								title="Project actions"
							>
								<Icon name="lucide:ellipsis-vertical" class="w-4 h-4" />
							</button>
						{/if}
					</div>
				{:else}
					<p class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">No projects yet</p>
				{/each}
			</div>
			{#if !selectionActive && archivedList().length > 0}
				<div class="mt-3 border-t border-slate-200 dark:border-slate-700 pt-2">
					<button
						type="button"
						class="flex items-center gap-1.5 w-full py-2 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider bg-transparent border-none cursor-pointer"
						onclick={() => (archivedExpanded = !archivedExpanded)}
						aria-expanded={archivedExpanded}
					>
						<Icon name={archivedExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5" />
						<span>Archived</span>
						<span class="ml-auto font-medium">({archivedList().length})</span>
					</button>
					{#if archivedExpanded}
						<div class="space-y-2 mt-1">
							{#each archivedList() as project (project.id)}
								<div
									class="flex items-center gap-2 w-full p-3 bg-transparent border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 text-sm text-left"
									oncontextmenu={(event) => openProjectContextMenu(project, event, true)}
								>
									<!-- Archived rows stay openable, same as Desktop — archiving
									     hides a project from the list, it does not close it off. -->
									<button
										type="button"
										class="flex items-center gap-2 flex-1 min-w-0 bg-transparent border-none cursor-pointer text-left"
										onclick={() => {
											import('$frontend/stores/core/projects.svelte').then((m) =>
												m.setCurrentProject(project)
											);
											closeProjectMenu();
										}}
									>
										<Icon name="lucide:archive" class="text-slate-400 w-4 h-4 shrink-0" />
										<div class="flex-1 min-w-0">
											<p class="font-semibold truncate">{project.name}</p>
											<p class="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">{project.path}</p>
										</div>
									</button>
									<button
										type="button"
										class="flex items-center justify-center w-9 h-9 shrink-0 bg-transparent border-none rounded-lg text-slate-400 cursor-pointer transition-all duration-150 active:bg-violet-500/10 active:text-slate-700 dark:active:text-slate-200"
										onclick={(e) => openProjectContextMenu(project, e, true)}
										aria-label="Archived project actions"
										title="Archived project actions"
									>
										<Icon name="lucide:ellipsis-vertical" class="w-4 h-4" />
									</button>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
		{/if}
	{/snippet}
</Modal>

<!-- Folder Browser -->
<FolderBrowser
	bind:isOpen={quickPanelsState.newProjectOpen}
	onClose={closeNewProjectDialog}
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
					<p class="text-xs text-slate-500 dark:text-slate-400">Delete all chats and restore points.</p>
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

<!-- Bulk Delete Confirmation Dialog (single dialog for all selected projects) -->
<Dialog
	bind:isOpen={showBulkDeleteDialog}
	onClose={closeBulkDeleteDialog}
	type="warning"
	title="Delete Projects"
	showCancel={false}
>
	{#snippet children()}
		<div class="flex items-start space-x-4">
			<div class="bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700/50 rounded-xl p-3 border">
				<Icon name="lucide:trash-2" class="w-6 h-6 text-red-600 dark:text-red-400" />
			</div>
			<div class="flex-1">
				<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Delete {selectionCount} project{selectionCount === 1 ? '' : 's'}?</h3>
				<ul class="mt-2 max-h-32 overflow-y-auto text-sm text-slate-700 dark:text-slate-300 list-disc list-inside">
					{#each bulkDeleteProjects.slice(0, 5) as p (p.id)}
						<li class="truncate">"{p.name}"</li>
					{/each}
					{#if bulkDeleteProjects.length > 5}
						<li class="text-slate-500">and {bulkDeleteProjects.length - 5} more…</li>
					{/if}
				</ul>
			</div>
		</div>
		<div class="flex flex-col gap-2 pt-2">
			<button
				onclick={confirmBulkDelete}
				disabled={bulkDeleting}
				class="w-full py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
			>
				{bulkDeleting ? 'Deleting…' : `Delete ${selectionCount} project${selectionCount === 1 ? '' : 's'}`}
			</button>
			<button
				onclick={closeBulkDeleteDialog}
				disabled={bulkDeleting}
				class="w-full py-2 text-sm font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
			>
				Cancel
			</button>
		</div>
	{/snippet}
</Dialog>

<!-- Tunnel Modal -->
<RemoteAccessPanel bind:isOpen={quickPanelsState.remoteAccessOpen} onClose={closeRemoteAccessDialog} />

<TunnelModal bind:isOpen={quickPanelsState.tunnelOpen} onClose={closeTunnelDialog} />

<!-- DB Client Modal -->
<DbClientModal bind:isOpen={quickPanelsState.dbClientOpen} onClose={closeDbClientDialog} />
<SshClientModal bind:isOpen={quickPanelsState.sshClientOpen} onClose={closeSshClientDialog} />
<PortsModal bind:isOpen={quickPanelsState.portsOpen} onClose={closePortsDialog} />
<ContainersModal bind:isOpen={quickPanelsState.containersOpen} onClose={closeContainersDialog} />
<MemoryModal bind:isOpen={quickPanelsState.memoryOpen} onClose={closeMemoryDialog} />
<NotesModal bind:isOpen={quickPanelsState.notesOpen} onClose={closeNotesDialog} />
<DeploymentsModal
	bind:isOpen={quickPanelsState.deploymentsOpen}
	onClose={closeDeploymentsDialog}
/>

<WorkModal
	bind:isOpen={quickPanelsState.workOpen}
	composePullRequest={quickPanelsState.workComposePr}
	onClose={closeWorkDialog}
/>

<ProjectInfoModal bind:isOpen={showProjectInfo} onClose={closeProjectInfo} project={projectInfoProject} />

<!-- Archived project context menu (shared ⋮ menu: Restore / Delete) -->
{#if contextMenuProject}
	<ProjectContextMenu
		items={contextMenuItems}
		x={contextMenuX}
		y={contextMenuY}
		onSelect={handleContextMenuSelect}
		onClose={closeProjectContextMenu}
	/>
{/if}

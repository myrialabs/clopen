<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { Project } from '$shared/types/database/schema';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	interface Props {
		isOpen: boolean;
		userId: string;
		userName: string;
		onClose: () => void;
	}

	let { isOpen = $bindable(), userId, userName, onClose }: Props = $props();

	let loading = $state(true);
	let saving = $state(false);
	let allProjects = $state<Project[]>([]);
	let assignedIds = $state<Set<string>>(new Set());
	let searchQuery = $state('');

	const filteredProjects = $derived(() => {
		if (!searchQuery.trim()) return allProjects;
		const query = searchQuery.toLowerCase();
		return allProjects.filter(
			(p) => p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)
		);
	});

	async function load() {
		if (!userId) return;
		loading = true;
		try {
			const [projects, userProjects] = await Promise.all([
				ws.http('projects:list', {}),
				ws.http('auth:list-user-projects', { userId })
			]);
			allProjects = Array.isArray(projects) ? projects : [];
			assignedIds = new Set((userProjects ?? []).map((p: Project) => p.id!));
		} catch (error) {
			debug.error('settings', 'Failed to load user projects:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'Failed to load projects'
			});
		} finally {
			loading = false;
		}
	}

	async function toggleProject(project: Project) {
		if (!project.id || saving) return;
		const projectId = project.id;
		const isAssigned = assignedIds.has(projectId);

		saving = true;
		try {
			if (isAssigned) {
				await ws.http('auth:unassign-project', { userId, projectId });
				const next = new Set(assignedIds);
				next.delete(projectId);
				assignedIds = next;
			} else {
				await ws.http('auth:assign-project', { userId, projectId });
				const next = new Set(assignedIds);
				next.add(projectId);
				assignedIds = next;
			}
		} catch (error) {
			debug.error('settings', 'Failed to update assignment:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: error instanceof Error ? error.message : 'Failed to update assignment'
			});
		} finally {
			saving = false;
		}
	}

	$effect(() => {
		if (!isOpen || !userId) return;

		const targetUserId = userId;
		searchQuery = '';
		load();

		// Keep modal in sync if another admin changes assignments for the
		// same user while this modal is open.
		const unsubscribe = ws.on('auth:user-projects-changed', (payload) => {
			if (payload.userId === targetUserId) load();
		});
		return () => unsubscribe();
	});
</script>

<Modal bind:isOpen {onClose} size="lg">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<div class="flex flex-col min-w-0">
				<h2 class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">Manage Projects</h2>
				<p class="text-xs text-slate-500 dark:text-slate-400 truncate">
					Grant or revoke project access for <span class="font-medium">{userName}</span>
				</p>
			</div>
			<button
				type="button"
				class="p-1.5 md:p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors"
				onclick={onClose}
				aria-label="Close modal"
			>
				<Icon name="lucide:x" class="w-4 h-4 md:w-5 md:h-5" />
			</button>
		</div>
	{/snippet}

	{#snippet children()}
		{#if loading}
			<div class="flex items-center justify-center gap-3 py-10 text-slate-600 dark:text-slate-500 text-sm">
				<div class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
				<span>Loading projects...</span>
			</div>
		{:else if allProjects.length === 0}
			<div class="flex flex-col items-center gap-3 py-10 text-slate-600 dark:text-slate-500 text-sm">
				<Icon name="lucide:folder-x" class="w-12 h-12 text-slate-400 opacity-40" />
				<p class="font-medium">No projects exist yet</p>
				<p class="text-xs text-slate-500 dark:text-slate-500">Create a project first to assign it to members.</p>
			</div>
		{:else}
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

			<div class="flex flex-col gap-2 max-h-[55vh] overflow-y-auto pr-1">
				{#each filteredProjects() as project (project.id)}
					{@const checked = assignedIds.has(project.id!)}
					<button
						type="button"
						disabled={saving}
						onclick={() => toggleProject(project)}
						class="flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800/60 border rounded-lg text-left transition-all duration-150 cursor-pointer disabled:opacity-60 disabled:cursor-wait
							{checked
								? 'border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-900/10'
								: 'border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'}"
					>
						<div
							class="flex items-center justify-center w-5 h-5 rounded border shrink-0
								{checked
									? 'bg-violet-600 border-violet-600 text-white'
									: 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-600'}"
						>
							{#if checked}
								<Icon name="lucide:check" class="w-3.5 h-3.5" />
							{/if}
						</div>
						<div class="flex-1 min-w-0">
							<p class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
								{project.name}
							</p>
							<p class="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">
								{project.path}
							</p>
						</div>
						<span
							class="inline-flex items-center gap-1 py-1 px-2.5 rounded-full text-2xs font-semibold shrink-0
								{checked
									? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
									: 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400'}"
						>
							{checked ? 'Assigned' : 'Not assigned'}
						</span>
					</button>
				{:else}
					<div class="flex flex-col items-center gap-2 py-8 text-slate-500 dark:text-slate-400 text-sm">
						<Icon name="lucide:search-x" class="w-10 h-10 opacity-40" />
						<p class="font-medium">No projects match your search</p>
					</div>
				{/each}
			</div>
		{/if}
	{/snippet}
</Modal>

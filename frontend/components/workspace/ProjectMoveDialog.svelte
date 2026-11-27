<script lang="ts">
	// Rename a project — which renames its folder — and re-point a project whose
	// folder vanished. Mounted once in ModalProvider; opened through
	// stores/ui/project-move.svelte.
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import FolderBrowser from '$frontend/components/common/form/FolderBrowser.svelte';
	import {
		projectState,
		removeProject,
		requestProjectMove,
		setCurrentProject,
		type ProjectMoveOutcome,
		type ProjectMoveRequest,
		type ProjectUsage
	} from '$frontend/stores/core/projects.svelte';
	import { pruneProject } from '$frontend/stores/ui/project-selection.svelte';
	import { projectMoveState, closeProjectMove } from '$frontend/stores/ui/project-move.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	const USAGE_POLL_MS = 3000;

	let name = $state('');
	let usage = $state<ProjectUsage | null>(null);
	let submitting = $state(false);
	let removing = $state(false);
	let error = $state('');
	let inputEl = $state<HTMLInputElement>();

	const project = $derived(projectMoveState.project);
	const mode = $derived(projectMoveState.mode);
	const isOpen = $derived(mode !== null && project !== null);
	const separator = $derived(project?.path.includes('\\') ? '\\' : '/');
	const parentPath = $derived.by(() => {
		if (!project) return '';
		const index = project.path.lastIndexOf(separator);
		return index > 0 ? project.path.slice(0, index) : separator;
	});
	const folderName = $derived(project ? project.path.slice(project.path.lastIndexOf(separator) + 1) : '');
	const trimmed = $derived(name.trim());
	const nameProblem = $derived.by(() => {
		if (mode !== 'rename') return '';
		if (!trimmed) return 'Enter a name.';
		if (trimmed === '.' || trimmed === '..' || /[/\\\0]/.test(trimmed)) return 'Use a single name, without slashes.';
		if (separator === '\\' && /[<>:"|?*]/.test(trimmed)) return 'Windows folder names cannot contain < > : " | ? *';
		if (trimmed.length > 255) return 'That name is too long.';
		return '';
	});
	const unchanged = $derived(mode === 'rename' && trimmed === folderName);
	const newPath = $derived(parentPath.endsWith(separator) ? `${parentPath}${trimmed}` : `${parentPath}${separator}${trimmed}`);
	const running = $derived(Boolean(usage && (usage.chats > 0 || usage.terminals > 0)));
	const canSubmit = $derived(!submitting && (mode === 'locate' || (!nameProblem && !unchanged)));

	function plural(count: number, noun: string): string {
		return `${count} ${noun}${count === 1 ? '' : 's'}`;
	}

	const usageText = $derived.by(() => {
		if (!usage) return '';
		const parts = [
			...(usage.chats ? [`${plural(usage.chats, 'chat')} running`] : []),
			...(usage.terminals ? [`${plural(usage.terminals, 'terminal')} open`] : [])
		];
		return parts.join(' · ');
	});

	// Fresh state each time the dialog opens on a project.
	$effect(() => {
		if (!isOpen || !project) return;
		name = folderName;
		error = '';
		submitting = false;
		usage = null;
		setTimeout(() => {
			inputEl?.focus();
			inputEl?.select();
		}, 60);
	});

	// What would block the move, kept current while the dialog is open: a chat
	// can finish, or a terminal close, while the user is typing.
	$effect(() => {
		const projectId = isOpen && (mode === 'rename' || mode === 'locate') ? project?.id : undefined;
		if (!projectId) return;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
			try {
				const next: ProjectUsage = await ws.http('projects:usage', { id: projectId });
				if (!stopped) usage = next;
			} catch (pollError) {
				debug.warn('project', 'Could not read project usage:', pollError);
			} finally {
				if (!stopped) timer = setTimeout(poll, USAGE_POLL_MS);
			}
		};
		void poll();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	});

	function finish(outcome: Extract<ProjectMoveOutcome, { status: 'moved' }>, kind: ProjectMoveRequest['kind']) {
		projectMoveState.onMoved?.(outcome.project, outcome.previousPath);
		const openNow = kind === 'relocate' && projectMoveState.openWhenFound && projectState.currentProject?.id !== outcome.project.id;
		const moved = outcome.previousPath !== outcome.project.path;
		if (moved) {
			addNotification({
				type: 'success',
				title: kind === 'rename' ? 'Project renamed' : 'Project folder found',
				message: kind === 'rename' ? `Now "${outcome.project.name}"` : `"${outcome.project.name}" points to ${outcome.project.path}`,
				duration: 4000
			});
		}
		for (const warning of outcome.warnings) {
			addNotification({ type: 'warning', title: 'Moved, with a problem', message: warning, duration: 8000 });
		}
		closeProjectMove();
		if (openNow) void setCurrentProject(outcome.project);
	}

	async function submit(force: boolean) {
		if (!project || !canSubmit) return;
		const request: ProjectMoveRequest =
			mode === 'rename' ? { kind: 'rename', name: trimmed } : { kind: 'relocate', path: projectMoveState.locatePath };
		submitting = true;
		error = '';
		try {
			const outcome = await requestProjectMove(project, request, force);
			if (outcome.status === 'busy') {
				usage = outcome.usage;
				return;
			}
			finish(outcome, request.kind);
		} catch (submitError) {
			error = submitError instanceof Error ? submitError.message : 'Could not move the project';
		} finally {
			submitting = false;
		}
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (!running) void submit(false);
	}

	// Locate: the picker hands back where the folder is now. Without running
	// work that is the whole move; with it, the dialog asks to stop it first.
	async function handleLocated(path: string) {
		const target = project;
		if (!target) return;
		projectMoveState.pickerOpen = false;
		try {
			const outcome = await requestProjectMove(target, { kind: 'relocate', path });
			if (outcome.status === 'busy') {
				projectMoveState.locatePath = path;
				projectMoveState.mode = 'locate';
				usage = outcome.usage;
				return;
			}
			finish(outcome, 'relocate');
		} catch (locateError) {
			addNotification({
				type: 'error',
				title: 'Could not use that folder',
				message: locateError instanceof Error ? locateError.message : 'Could not move the project',
				duration: 6000
			});
			closeProjectMove();
		}
	}

	function startLocate() {
		projectMoveState.mode = null;
		projectMoveState.pickerOpen = true;
	}

	async function removeFromList() {
		if (!project || removing) return;
		removing = true;
		try {
			await ws.http('projects:delete', { id: project.id, mode: 'remove' });
			removeProject(project.id);
			pruneProject(project.id);
			closeProjectMove();
		} catch (removeError) {
			debug.error('project', 'Failed to remove project:', removeError);
			error = 'Failed to remove the project from the list';
		} finally {
			removing = false;
		}
	}
</script>

<Dialog
	isOpen={isOpen}
	onClose={() => !submitting && closeProjectMove()}
	title={mode === 'missing' ? 'Folder Not Found' : 'Rename Project'}
	showCancel={false}
	closeOnConfirm={false}
>
	{#snippet children()}
		{#if project && mode === 'missing'}
			<div class="flex items-start gap-4">
				<div class="bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-700/50 rounded-xl p-3 border">
					<Icon name="lucide:folder-x" class="w-6 h-6 text-amber-600 dark:text-amber-400" />
				</div>
				<div class="flex-1 min-w-0 space-y-1">
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Folder not found</h3>
					<p class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
						<strong>"{project.name}"</strong> is no longer at
						<span class="font-mono text-xs break-all">{project.path}</span>. It may have been moved, renamed or deleted outside Clopen.
					</p>
				</div>
			</div>
			{#if error}
				<p class="text-sm text-red-600 dark:text-red-400">{error}</p>
			{/if}
			<div class="flex flex-col gap-2 pt-2">
				<button
					type="button"
					onclick={startLocate}
					class="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 text-left"
				>
					<Icon name="lucide:folder-search" class="w-5 h-5 text-slate-500 shrink-0" />
					<div class="flex-1 min-w-0">
						<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Locate folder…</p>
						<p class="text-xs text-slate-500 dark:text-slate-400">Point the project at where the folder is now. Chats and history come along.</p>
					</div>
				</button>
				<button
					type="button"
					onclick={removeFromList}
					disabled={removing}
					class="w-full flex items-center gap-3 p-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 text-left disabled:opacity-50"
				>
					<Icon name="lucide:eye-off" class="w-5 h-5 text-slate-500 shrink-0" />
					<div class="flex-1 min-w-0">
						<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Remove from list</p>
						<p class="text-xs text-slate-500 dark:text-slate-400">Sessions will be restored when you re-add this folder.</p>
					</div>
				</button>
				<button
					type="button"
					onclick={closeProjectMove}
					class="w-full py-2 text-sm font-semibold text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
				>
					Cancel
				</button>
			</div>
		{:else if project}
			<div class="flex items-start gap-4">
				<div class="bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-700/50 rounded-xl p-3 border">
					<Icon
						name={mode === 'locate' ? 'lucide:folder-search' : 'lucide:folder-pen'}
						class="w-6 h-6 text-violet-600 dark:text-violet-400"
					/>
				</div>
				<div class="flex-1 min-w-0 space-y-1">
					<h3 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
						{mode === 'locate' ? 'Use this folder' : 'Rename project'}
					</h3>
					<p class="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
						{mode === 'locate'
							? `"${project.name}" will point to the folder you picked.`
							: 'The folder on disk is renamed too. Chats, terminals and history follow it.'}
					</p>
				</div>
			</div>

			{#if mode === 'rename'}
				<div class="space-y-1.5">
					<input
						bind:this={inputEl}
						bind:value={name}
						type="text"
						placeholder="Folder name"
						disabled={submitting}
						onkeydown={handleKeydown}
						aria-label="New project name"
						class="w-full px-4 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 placeholder-slate-500 dark:placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 disabled:opacity-60"
					/>
					{#if nameProblem}
						<p class="text-xs text-red-600 dark:text-red-400">{nameProblem}</p>
					{:else}
						<p class="text-xs font-mono text-slate-500 dark:text-slate-400 break-all" title={newPath}>{newPath}</p>
					{/if}
				</div>
			{:else}
				<p class="text-xs font-mono text-slate-500 dark:text-slate-400 break-all">{projectMoveState.locatePath}</p>
			{/if}

			{#if running}
				<div class="flex items-start gap-2.5 p-3 rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/15">
					<Icon name="lucide:circle-alert" class="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
					<div class="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
						<p class="font-semibold">{usageText}</p>
						<p>They would keep working in a folder that no longer exists. Stop them to continue.</p>
					</div>
				</div>
			{/if}

			{#if error}
				<p class="text-sm text-red-600 dark:text-red-400">{error}</p>
			{/if}

			<div class="flex justify-end gap-3 pt-2">
				<button
					type="button"
					onclick={closeProjectMove}
					disabled={submitting}
					class="px-5 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-all duration-200 font-semibold disabled:opacity-50"
				>
					Cancel
				</button>
				{#if running}
					<button
						type="button"
						onclick={() => submit(true)}
						disabled={!canSubmit}
						class="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-all duration-200 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{submitting ? 'Stopping…' : mode === 'locate' ? 'Stop all & use folder' : 'Stop all & rename'}
					</button>
				{:else}
					<button
						type="button"
						onclick={() => submit(false)}
						disabled={!canSubmit}
						class="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg transition-all duration-200 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{submitting ? (mode === 'locate' ? 'Moving…' : 'Renaming…') : mode === 'locate' ? 'Use folder' : 'Rename'}
					</button>
				{/if}
			</div>
		{/if}
	{/snippet}
</Dialog>

{#if projectMoveState.project}
	<FolderBrowser
		bind:isOpen={projectMoveState.pickerOpen}
		onClose={closeProjectMove}
		onSelect={(path) => void handleLocated(path)}
		currentProjectPath={projectState.currentProject?.path}
		title="Locate Project Folder"
		confirmText="Use This Folder"
		initialPath={parentPath}
	/>
{/if}

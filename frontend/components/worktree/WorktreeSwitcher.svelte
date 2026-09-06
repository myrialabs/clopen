<script lang="ts">
	/**
	 * The one place worktrees are seen and acted on: switch between trees, and
	 * run each tree's actions inline. A separate manager screen would only be a
	 * second copy of this list.
	 */
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { getWorktreeStatusColor } from '$frontend/stores/core/presence.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import {
		activeContextName,
		deleteWorktree,
		fetchWorktreeStatus,
		isInWorktree,
		renameWorktree,
		switchWorktreeContext,
		worktreeState,
		type TransferDirection,
		type WorktreeSummary
	} from '$frontend/stores/features/worktrees.svelte';
	import { debug } from '$shared/utils/logger';
	import CreateWorktreeModal from './CreateWorktreeModal.svelte';
	import WorktreeTransferModal from './WorktreeTransferModal.svelte';

	interface Props {
		collapsed?: boolean;
		mobile?: boolean;
	}

	const { collapsed = false, mobile = false }: Props = $props();

	let isOpen = $state(false);
	let showCreate = $state(false);
	let showTransfer = $state(false);
	let transferWorktree = $state<WorktreeSummary | null>(null);
	let transferDirection = $state<TransferDirection>('apply');

	let pendingByWorktree = $state<Record<string, number>>({});
	let renamingId = $state<string | null>(null);
	let renameValue = $state('');

	const hasProject = $derived(projectState.currentProject !== null);
	const projectId = $derived(projectState.currentProject?.id ?? '');
	const contextName = $derived(activeContextName());
	const inWorktree = $derived(isInWorktree());
	const worktrees = $derived(worktreeState.worktrees);

	function toggleMenu() {
		isOpen = !isOpen;
		if (isOpen) void loadPending();
	}

	function closeMenu() {
		isOpen = false;
		renamingId = null;
	}

	/** Divergence is computed per worktree, so it loads only while the menu is up. */
	async function loadPending() {
		const next: Record<string, number> = {};
		for (const worktree of worktreeState.worktrees) {
			try {
				next[worktree.id] = (await fetchWorktreeStatus(worktree.id)).pendingChanges;
			} catch (error) {
				debug.warn('worktree', `Status failed for ${worktree.name}:`, error);
			}
		}
		pendingByWorktree = next;
	}

	async function selectContext(worktreeId: string | null) {
		closeMenu();
		await switchWorktreeContext(worktreeId);
	}

	function openCreate() {
		closeMenu();
		showCreate = true;
	}

	function startTransfer(worktree: WorktreeSummary, direction: TransferDirection) {
		closeMenu();
		transferWorktree = worktree;
		transferDirection = direction;
		showTransfer = true;
	}

	function startRename(worktree: WorktreeSummary) {
		renamingId = worktree.id;
		renameValue = worktree.name;
	}

	async function commitRename() {
		const id = renamingId;
		const name = renameValue.trim();
		renamingId = null;
		if (!id || !name) return;

		try {
			await renameWorktree(id, name);
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Rename failed',
				message: error instanceof Error ? error.message : String(error),
				duration: 4000
			});
		}
	}

	async function remove(worktree: WorktreeSummary) {
		const pending = pendingByWorktree[worktree.id] ?? 0;
		const warning =
			pending > 0
				? ` It has ${pending} change${pending === 1 ? '' : 's'} that were never applied to Main — they will be lost.`
				: '';

		closeMenu();
		const confirmed = await showConfirm({
			title: `Delete "${worktree.name}"?`,
			message: `The worktree directory and everything in it is removed.${warning}`,
			type: 'warning',
			confirmText: 'Delete'
		});
		if (!confirmed) return;

		try {
			await deleteWorktree(worktree.id);
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Delete failed',
				message: error instanceof Error ? error.message : String(error),
				duration: 4000
			});
		}
	}

	/** Tooltip spells out what the counts mean; the row itself has no space for it. */
	function summaryTitleFor(worktree: WorktreeSummary): string {
		const pending = pendingByWorktree[worktree.id];
		if (pending === undefined) return worktree.path;
		return `${pending} file${pending === 1 ? '' : 's'} differ from Main and would be transferred by "Apply to Main"`;
	}

	function summaryFor(worktree: WorktreeSummary): string {
		const parts = [`${worktree.sessionCount} chat${worktree.sessionCount === 1 ? '' : 's'}`];
		const pending = pendingByWorktree[worktree.id];
		if (pending !== undefined) parts.push(`${pending} pending`);
		if (worktree.status === 'applied') parts.push('applied');
		return parts.join(' · ');
	}

	const actionButtonClass =
		'flex items-center justify-center w-5 h-5 rounded text-slate-500 transition-colors duration-150';

	/** Same dot as the project list, so a busy tree reads the same as a busy project. */
	const statusDotClass =
		'absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-800';
</script>

{#if hasProject}
	<div class="relative" use:clickOutside={closeMenu}>
		{#if collapsed}
			<button
				type="button"
				class="flex items-center justify-center bg-transparent border-none cursor-pointer transition-all duration-150 relative
					{mobile ? 'w-9 h-8 rounded-md active:bg-violet-500/10' : 'w-9 h-9 rounded-lg hover:bg-violet-500/10'}
					{inWorktree ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'}
					{isOpen ? 'bg-violet-500/10' : ''}"
				onclick={toggleMenu}
				aria-label="Worktree"
				aria-expanded={isOpen}
				title="Worktree: {contextName}"
			>
				<Icon name="lucide:git-fork" class={mobile ? 'w-4.5 h-4.5' : 'w-5 h-5'} />
				{#if inWorktree}
					<span
						class="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-amber-500 border-2 border-slate-50 dark:border-slate-900/95"
					></span>
				{/if}
			</button>
		{:else}
			<button
				type="button"
				class="flex items-center gap-2.5 w-full py-2.5 px-3 bg-transparent border-none rounded-lg text-sm cursor-pointer transition-all duration-150 hover:bg-violet-500/10
					{inWorktree ? 'text-amber-700 dark:text-amber-400' : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'}
					{isOpen ? 'bg-violet-500/10' : ''}"
				onclick={toggleMenu}
				aria-label="Worktree"
				aria-expanded={isOpen}
			>
				<Icon name="lucide:git-fork" class="w-4 h-4 shrink-0" />
				<span class="flex-1 text-left truncate">{contextName}</span>
				<Icon name="lucide:chevron-up" class="w-3.5 h-3.5 shrink-0 opacity-60" />
			</button>
		{/if}

		{#if isOpen}
			<div
				class="absolute {mobile ? 'top-full right-0 mt-1' : 'bottom-full left-0 mb-1'} w-72 bg-white dark:bg-slate-800 border border-violet-500/20 rounded-lg shadow-2xl shadow-slate-900/20 dark:shadow-black/40 z-50 overflow-hidden"
				transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
			>
				<div class="py-1.5 max-h-[28rem] overflow-y-auto">
					<div class="px-3 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-500 uppercase tracking-wider">
						Worktree
					</div>

					<button
						type="button"
						class="flex items-center gap-2.5 w-full px-3 py-2.5 bg-transparent border-none text-left cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
						onclick={() => selectContext(null)}
					>
						<div class="relative shrink-0">
							<Icon name="lucide:folder" class="w-4 h-4 {inWorktree ? 'text-slate-500' : 'text-violet-600 dark:text-violet-400'}" />
							<span class="{statusDotClass} {getWorktreeStatusColor(projectId, null)}"></span>
						</div>
						<div class="flex flex-col min-w-0 flex-1">
							<span class="flex items-center gap-1.5">
								<span class="text-sm font-medium text-slate-800 dark:text-slate-200">Main</span>
								{#if !inWorktree}
									<Icon name="lucide:check" class="w-3.5 h-3.5 shrink-0 text-violet-600 dark:text-violet-400" />
								{/if}
							</span>
							<span class="text-xs text-slate-500 dark:text-slate-500 truncate">The project itself</span>
						</div>
					</button>

					{#each worktrees as worktree (worktree.id)}
						{@const isActive = worktreeState.activeId === worktree.id}
						<div class="group px-3 py-2 transition-colors duration-150 hover:bg-violet-500/5">
							<!-- Actions share the name's line; the summary gets the row to itself. -->
							<div class="flex items-center gap-2.5">
								<div class="relative shrink-0">
									<Icon
										name="lucide:git-fork"
										class="w-4 h-4 {isActive ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500'}"
									/>
									<span class="{statusDotClass} {getWorktreeStatusColor(projectId, worktree.id)}"></span>
								</div>

								{#if renamingId === worktree.id}
									<!-- svelte-ignore a11y_autofocus -->
									<input
										autofocus
										bind:value={renameValue}
										onblur={commitRename}
										onkeydown={(event) => {
											if (event.key === 'Enter') commitRename();
											if (event.key === 'Escape') renamingId = null;
										}}
										class="flex-1 min-w-0 px-2 py-1 bg-white dark:bg-slate-900 border border-violet-500/50 rounded text-sm text-slate-900 dark:text-slate-100 outline-none"
									/>
								{:else}
									<button
										type="button"
										class="flex items-center gap-1.5 min-w-0 flex-1 bg-transparent border-none text-left cursor-pointer p-0"
										title={worktree.path}
										onclick={() => selectContext(worktree.id)}
									>
										<span class="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">
											{worktree.name}
										</span>
										{#if isActive}
											<Icon name="lucide:check" class="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
										{/if}
									</button>

									<!-- Dimmed rather than hidden: taps have no hover to reveal them. -->
									<div class="flex items-center gap-0.5 shrink-0 opacity-60 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
										<button
											type="button"
											class="{actionButtonClass} hover:bg-violet-500/10 hover:text-violet-600"
											title="Apply to Main"
											aria-label="Apply to Main"
											onclick={() => startTransfer(worktree, 'apply')}
										>
											<Icon name="lucide:arrow-up-from-line" class="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											class="{actionButtonClass} hover:bg-violet-500/10 hover:text-violet-600"
											title="Sync from Main"
											aria-label="Sync from Main"
											onclick={() => startTransfer(worktree, 'sync')}
										>
											<Icon name="lucide:arrow-down-to-line" class="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											class="{actionButtonClass} hover:bg-violet-500/10 hover:text-violet-600"
											title="Rename"
											aria-label="Rename"
											onclick={() => startRename(worktree)}
										>
											<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
										</button>
										<button
											type="button"
											class="{actionButtonClass} hover:bg-red-500/10 hover:text-red-500"
											title="Delete"
											aria-label="Delete"
											onclick={() => remove(worktree)}
										>
											<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
										</button>
									</div>
								{/if}
							</div>

							<span
								class="block pl-6.5 text-xs text-slate-500 dark:text-slate-500 truncate"
								title={summaryTitleFor(worktree)}
							>
								{summaryFor(worktree)}
							</span>
						</div>
					{/each}

					<div class="my-1 h-px bg-slate-200 dark:bg-slate-700"></div>

					<!-- Secondary action: lighter than the tree rows it sits under. -->
					<button
						type="button"
						class="flex items-center gap-2 w-full px-3 py-1.5 bg-transparent border-none text-left cursor-pointer text-slate-600 dark:text-slate-400 transition-colors duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={openCreate}
					>
						<Icon name="lucide:plus" class="w-3.5 h-3.5 shrink-0" />
						<span class="text-xs font-medium">New worktree…</span>
					</button>
				</div>
			</div>
		{/if}
	</div>

	<CreateWorktreeModal bind:isOpen={showCreate} onClose={() => (showCreate = false)} />

	<WorktreeTransferModal
		bind:isOpen={showTransfer}
		worktree={transferWorktree}
		direction={transferDirection}
		onClose={() => (showTransfer = false)}
	/>
{/if}

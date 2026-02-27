<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import Modal from '$frontend/lib/components/common/Modal.svelte';
	import Dialog from '$frontend/lib/components/common/Dialog.svelte';
	import type { GitBranchInfo, GitRemote } from '$shared/types/git';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';
	import { showError, showInfo } from '$frontend/lib/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';
	import ws from '$frontend/lib/utils/ws';

	interface Props {
		isOpen: boolean;
		branchInfo: GitBranchInfo | null;
		onClose: () => void;
		onSwitch: (name: string) => void;
		onCreate: (name: string) => void;
		onDelete: (name: string, force?: boolean) => void;
		onRename: (oldName: string, newName: string) => void;
		onMerge: (name: string) => void;
		onRemotesChanged?: () => void;
	}

	const { isOpen, branchInfo, onClose, onSwitch, onCreate, onDelete, onRename, onMerge, onRemotesChanged }: Props = $props();

	const projectId = $derived(projectState.currentProject?.id || '');

	let searchQuery = $state('');
	let showCreateForm = $state(false);
	let newBranchName = $state('');
	let activeTab = $state<'local' | 'remote'>('local');

	// Remote management
	let remotes = $state<GitRemote[]>([]);
	let isLoadingRemotes = $state(false);
	let showAddRemoteForm = $state(false);
	let newRemoteName = $state('origin');
	let newRemoteUrl = $state('');
	let showRemoteSection = $state(false);

	// Confirm dialog
	let showConfirmDialog = $state(false);
	let confirmConfig = $state({
		title: '',
		message: '',
		type: 'warning' as 'info' | 'warning' | 'error' | 'success',
		confirmText: 'Confirm',
		onConfirm: () => {}
	});

	const filteredLocal = $derived(
		branchInfo?.local.filter(b =>
			b.name.toLowerCase().includes(searchQuery.toLowerCase())
		) ?? []
	);

	const filteredRemote = $derived(
		branchInfo?.remote.filter(b =>
			b.name.toLowerCase().includes(searchQuery.toLowerCase())
		) ?? []
	);

	function handleCreate() {
		if (!newBranchName.trim()) return;
		onCreate(newBranchName.trim());
		newBranchName = '';
		showCreateForm = false;
	}

	function handleSwitchRemote(remoteBranch: string) {
		const parts = remoteBranch.split('/');
		const localName = parts.slice(1).join('/');
		onSwitch(localName);
	}

	function handleClose() {
		searchQuery = '';
		newBranchName = '';
		showCreateForm = false;
		showAddRemoteForm = false;
		newRemoteName = 'origin';
		newRemoteUrl = '';
		onClose();
	}

	async function loadRemotes() {
		if (!projectId) return;
		isLoadingRemotes = true;
		try {
			remotes = await ws.http('git:remotes', { projectId });
		} catch (err) {
			debug.error('git', 'Failed to load remotes:', err);
		} finally {
			isLoadingRemotes = false;
		}
	}

	async function handleAddRemote() {
		if (!newRemoteName.trim() || !newRemoteUrl.trim() || !projectId) return;
		try {
			await ws.http('git:add-remote', { projectId, name: newRemoteName.trim(), url: newRemoteUrl.trim() });
			showInfo('Remote Added', `Remote "${newRemoteName.trim()}" connected.`);
			newRemoteName = 'origin';
			newRemoteUrl = '';
			showAddRemoteForm = false;
			await loadRemotes();
			onRemotesChanged?.();
		} catch (err) {
			debug.error('git', 'Failed to add remote:', err);
			showError('Failed to Add Remote', err instanceof Error ? err.message : 'Unknown error');
		}
	}

	function handleRemoveRemote(name: string) {
		confirmConfig = {
			title: 'Remove Remote',
			message: `Disconnect remote "${name}"? This will not delete the remote repository itself.`,
			type: 'warning',
			confirmText: 'Remove',
			onConfirm: async () => {
				if (!projectId) return;
				try {
					await ws.http('git:remove-remote', { projectId, name });
					showInfo('Remote Removed', `Remote "${name}" disconnected.`);
					await loadRemotes();
					onRemotesChanged?.();
				} catch (err) {
					debug.error('git', 'Failed to remove remote:', err);
					showError('Failed to Remove Remote', err instanceof Error ? err.message : 'Unknown error');
				}
			}
		};
		showConfirmDialog = true;
	}

	// Load remotes when modal opens
	$effect(() => {
		if (isOpen) {
			loadRemotes();
		}
	});
</script>

<Modal isOpen={isOpen} onClose={handleClose} size="md">
	{#snippet header()}
		<div class="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
			<div class="flex items-center gap-2.5">
				<Icon name="lucide:git-branch" class="w-5 h-5 text-violet-600" />
				<h2 class="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">Branches</h2>
			</div>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="p-1.5 md:p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-violet-500/10 transition-colors"
					onclick={handleClose}
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
		<!-- Create branch form -->
		{#if showCreateForm}
			<div class="mb-4 p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
				<input
					type="text"
					bind:value={newBranchName}
					placeholder="New branch name..."
					class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40"
					onkeydown={(e) => e.key === 'Enter' && handleCreate()}
					autofocus
				/>
				<div class="flex gap-2">
					<button
						type="button"
						class="flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer border-none
							{newBranchName.trim()
								? 'bg-violet-600 text-white hover:bg-violet-700'
								: 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'}"
						onclick={handleCreate}
						disabled={!newBranchName.trim()}
					>
						Create Branch
					</button>
					<button
						type="button"
						class="px-3 py-2 text-sm font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
						onclick={() => { showCreateForm = false; newBranchName = ''; }}
					>
						Cancel
					</button>
				</div>
			</div>
		{:else}
			<button
				type="button"
				class="flex items-center justify-center gap-2 w-full mb-4 py-2.5 px-3 border border-dashed border-slate-300 dark:border-slate-600 rounded-lg text-sm text-slate-500 hover:text-violet-600 hover:border-violet-400 transition-colors cursor-pointer bg-transparent"
				onclick={() => showCreateForm = true}
			>
				<Icon name="lucide:plus" class="w-4 h-4" />
				<span>Create New Branch</span>
			</button>
		{/if}

		<!-- Search -->
		<div class="mb-4">
			<div class="flex items-center gap-2 py-2.5 px-3.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-lg">
				<Icon name="lucide:search" class="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0" />
				<input
					type="text"
					bind:value={searchQuery}
					placeholder="Search branches..."
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

		<!-- Tabs -->
		<div class="flex gap-1 mb-3">
			<button
				type="button"
				class="px-3 py-1.5 text-sm font-medium rounded-lg transition-colors cursor-pointer border-none
					{activeTab === 'local'
						? 'bg-violet-500/10 text-violet-600'
						: 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => activeTab = 'local'}
			>
				Local ({filteredLocal.length})
			</button>
			<button
				type="button"
				class="px-3 py-1.5 text-sm font-medium rounded-lg transition-colors cursor-pointer border-none
					{activeTab === 'remote'
						? 'bg-violet-500/10 text-violet-600'
						: 'bg-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				onclick={() => activeTab = 'remote'}
			>
				Remote ({filteredRemote.length})
			</button>
		</div>

		<!-- Branch list -->
		<div class="space-y-1.5 max-h-80 overflow-y-auto">
			{#if activeTab === 'local'}
				{#each filteredLocal as branch (branch.name)}
					<div
						class="group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors
							{branch.isCurrent
								? 'bg-violet-50 dark:bg-violet-900/10 border border-violet-200 dark:border-violet-800'
								: 'hover:bg-slate-100 dark:hover:bg-slate-800/50 border border-slate-200 dark:border-slate-700'}"
					>
						<div class="flex items-center gap-2.5 flex-1 min-w-0">
							{#if branch.isCurrent}
								<Icon name="lucide:check" class="w-4 h-4 text-violet-600 shrink-0" />
							{:else}
								<div class="w-4 h-4 shrink-0"></div>
							{/if}
							<span class="text-sm text-slate-900 dark:text-slate-100 truncate {branch.isCurrent ? 'font-semibold' : ''}">
								{branch.name}
							</span>
							{#if branch.isCurrent}
								<span class="inline-flex items-center px-2 py-0.5 bg-violet-100 dark:bg-violet-900/20 text-violet-600 dark:text-violet-400 text-xs font-medium rounded-full">
									Current
								</span>
							{/if}
						</div>

						{#if !branch.isCurrent}
							<div class="flex items-center gap-1 -my-2">
								<button
									type="button"
									class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors cursor-pointer bg-transparent border-none"
									onclick={() => onSwitch(branch.name)}
									title="Switch to this branch"
								>
									<Icon name="lucide:arrow-right" class="w-4 h-4" />
								</button>
								<button
									type="button"
									class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-blue-500/10 hover:text-blue-500 transition-colors cursor-pointer bg-transparent border-none"
									onclick={() => onMerge(branch.name)}
									title="Merge into current branch"
								>
									<Icon name="lucide:git-merge" class="w-4 h-4" />
								</button>
								<button
									type="button"
									class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-red-500/10 hover:text-red-500 transition-colors cursor-pointer bg-transparent border-none"
									onclick={() => onDelete(branch.name)}
									title="Delete branch"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							</div>
						{/if}
					</div>
				{:else}
					<div class="flex flex-col items-center gap-2 py-8 text-slate-500 dark:text-slate-400 text-sm">
						<Icon name="lucide:search-x" class="w-10 h-10 opacity-40" />
						<p class="font-medium">No local branches found</p>
					</div>
				{/each}
			{:else if activeTab === 'remote'}
				{#each filteredRemote as branch (branch.name)}
					<div
						class="group flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors border border-slate-200 dark:border-slate-700"
					>
						<div class="flex items-center gap-2.5 flex-1 min-w-0">
							<Icon name="lucide:cloud" class="w-4 h-4 text-slate-400 shrink-0" />
							<span class="text-sm text-slate-900 dark:text-slate-100 truncate">{branch.name}</span>
						</div>

						<div class="items-center gap-1 shrink-0 hidden group-hover:flex">
							<button
								type="button"
								class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 transition-colors cursor-pointer bg-transparent border-none"
								onclick={() => handleSwitchRemote(branch.name)}
								title="Checkout remote branch"
							>
								<Icon name="lucide:arrow-right" class="w-4 h-4" />
							</button>
						</div>
					</div>
				{:else}
					<div class="flex flex-col items-center gap-2 py-8 text-slate-500 dark:text-slate-400 text-sm">
						<Icon name="lucide:search-x" class="w-10 h-10 opacity-40" />
						<p class="font-medium">No remote branches found</p>
					</div>
				{/each}
			{/if}
		</div>

		<!-- Remote Connections Section -->
		<div class="mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
			<button
				type="button"
				class="flex items-center gap-2 w-full text-left bg-transparent border-none cursor-pointer px-0 py-1"
				onclick={() => showRemoteSection = !showRemoteSection}
			>
				<Icon name={showRemoteSection ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5 text-slate-400" />
				<Icon name="lucide:server" class="w-3.5 h-3.5 text-slate-500" />
				<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
					Remote Servers ({remotes.length})
				</span>
			</button>

			{#if showRemoteSection}
				<div class="mt-2 space-y-2">
					{#if isLoadingRemotes}
						<div class="flex items-center justify-center py-4">
							<div class="w-4 h-4 border-2 border-slate-200 dark:border-slate-700 border-t-violet-600 rounded-full animate-spin"></div>
						</div>
					{:else}
						<!-- Existing remotes -->
						{#each remotes as remote (remote.name)}
							<div class="group flex items-center gap-2.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30">
								<div class="flex items-center justify-center w-6 h-6 rounded-md bg-slate-100 dark:bg-slate-800">
									<Icon name="lucide:globe" class="w-3.5 h-3.5 text-slate-500" />
								</div>
								<div class="flex-1 min-w-0">
									<div class="text-sm font-medium text-slate-900 dark:text-slate-100">{remote.name}</div>
									<div class="text-xs text-slate-500 dark:text-slate-400 truncate font-mono">{remote.fetchUrl}</div>
								</div>
								<button
									type="button"
									class="flex items-center justify-center w-7 h-7 rounded-md text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors cursor-pointer bg-transparent border-none shrink-0 opacity-0 group-hover:opacity-100"
									onclick={() => handleRemoveRemote(remote.name)}
									title="Disconnect remote"
								>
									<Icon name="lucide:unlink" class="w-3.5 h-3.5" />
								</button>
							</div>
						{/each}

						<!-- Add remote form -->
						{#if showAddRemoteForm}
							<div class="p-3 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg space-y-2">
								<input
									type="text"
									bind:value={newRemoteName}
									placeholder="Name (e.g. origin)"
									class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40"
								/>
								<input
									type="text"
									bind:value={newRemoteUrl}
									placeholder="URL (e.g. https://github.com/user/repo.git)"
									class="w-full px-3 py-2 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-slate-100 outline-none focus:border-violet-500/40 font-mono"
									onkeydown={(e) => e.key === 'Enter' && handleAddRemote()}
									autofocus
								/>
								<div class="flex gap-2">
									<button
										type="button"
										class="flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer border-none
											{newRemoteName.trim() && newRemoteUrl.trim()
												? 'bg-violet-600 text-white hover:bg-violet-700'
												: 'bg-slate-200 dark:bg-slate-700 text-slate-400 dark:text-slate-500 cursor-not-allowed'}"
										onclick={handleAddRemote}
										disabled={!newRemoteName.trim() || !newRemoteUrl.trim()}
									>
										Connect
									</button>
									<button
										type="button"
										class="px-3 py-2 text-sm font-medium bg-transparent border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
										onclick={() => { showAddRemoteForm = false; newRemoteName = 'origin'; newRemoteUrl = ''; }}
									>
										Cancel
									</button>
								</div>
							</div>
						{:else}
							<button
								type="button"
								class="flex items-center gap-2 w-full px-3 py-2 text-xs text-slate-500 hover:text-violet-600 hover:bg-violet-500/5 rounded-lg transition-colors cursor-pointer bg-transparent border-none"
								onclick={() => { showAddRemoteForm = true; showRemoteSection = true; }}
							>
								<Icon name="lucide:plus" class="w-3.5 h-3.5" />
								<span>Add Remote Server</span>
							</button>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
	{/snippet}
</Modal>

<!-- Confirm Dialog -->
<Dialog
	bind:isOpen={showConfirmDialog}
	onClose={() => showConfirmDialog = false}
	type={confirmConfig.type}
	title={confirmConfig.title}
	message={confirmConfig.message}
	confirmText={confirmConfig.confirmText}
	onConfirm={confirmConfig.onConfirm}
/>

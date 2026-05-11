<script lang="ts">
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import Icon from '../../common/display/Icon.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import UserProjectsModal from './UserProjectsModal.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	interface User {
		id: string;
		name: string;
		color: string;
		avatar: string;
		role: 'admin' | 'member';
		createdAt: string;
	}

	let users = $state<User[]>([]);
	let loading = $state(true);

	let showRemoveConfirm = $state(false);
	let userToRemove = $state<User | null>(null);

	let showProjectsModal = $state(false);
	let userForProjects = $state<User | null>(null);

	function openProjectsModal(user: User) {
		userForProjects = user;
		showProjectsModal = true;
	}

	function closeProjectsModal() {
		showProjectsModal = false;
		userForProjects = null;
	}

	async function loadUsers() {
		loading = true;
		try {
			users = await ws.http('auth:list-users', {});
		} catch (error) {
			debug.error('settings', 'Failed to load users:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to load users' });
		} finally {
			loading = false;
		}
	}

	function confirmRemove(user: User) {
		userToRemove = user;
		showRemoveConfirm = true;
	}

	async function removeUser() {
		// Dialog clears userToRemove via onClose immediately after onConfirm fires,
		// so capture a local reference before any await.
		const target = userToRemove;
		if (!target) return;
		try {
			await ws.http('auth:remove-user', { userId: target.id });
			addNotification({ type: 'success', title: 'Removed', message: `${target.name} has been removed` });
			await loadUsers();
		} catch (error) {
			debug.error('settings', 'Failed to remove user:', error);
			addNotification({ type: 'error', title: 'Error', message: error instanceof Error ? error.message : 'Failed to remove user' });
		}
	}

	// Load on mount + keep list in sync with backend events
	$effect(() => {
		if (!authStore.isAdmin) return;

		loadUsers();

		const unsubscribe = ws.on('auth:users-changed', () => {
			loadUsers();
		});
		return () => unsubscribe();
	});
</script>

{#if authStore.isAdmin}
<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">User Management</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Manage team members</p>

	{#if loading}
		<div class="flex items-center justify-center gap-3 py-8 text-slate-600 dark:text-slate-500 text-sm">
			<div class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Loading users...</span>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each users as user (user.id)}
				<div class="flex items-center gap-3 p-3.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
					<div
						class="flex items-center justify-center w-9 h-9 rounded-lg text-sm font-bold text-white shrink-0"
						style="background-color: {user.color || '#7c3aed'}"
					>
						{user.avatar || 'U'}
					</div>
					<div class="flex-1 min-w-0">
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">
							{user.name}
							{#if user.id === authStore.currentUser?.id}
								<span class="text-xs text-slate-500 font-normal ml-1">(you)</span>
							{/if}
						</div>
						<div class="text-xs text-slate-500">
							{user.role === 'admin' ? 'Administrator' : 'Member'} &middot; Joined {new Date(user.createdAt).toLocaleDateString()}
						</div>
					</div>
					<span class="inline-flex items-center gap-1 py-1 px-2.5 rounded-full text-2xs font-semibold
						{user.role === 'admin' ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400' : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400'}">
						<Icon name="lucide:{user.role === 'admin' ? 'shield' : 'user'}" class="w-3 h-3" />
						{user.role === 'admin' ? 'Admin' : 'Member'}
					</span>
					{#if user.role !== 'admin'}
						<button
							type="button"
							onclick={() => openProjectsModal(user)}
							class="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-all"
							title="Manage projects"
							aria-label="Manage projects for {user.name}"
						>
							<Icon name="lucide:folder-cog" class="w-4 h-4" />
						</button>
					{/if}
					{#if user.role !== 'admin' && user.id !== authStore.currentUser?.id}
						<button
							type="button"
							onclick={() => confirmRemove(user)}
							class="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-all"
							title="Remove user"
						>
							<Icon name="lucide:user-minus" class="w-4 h-4" />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Remove User Confirmation -->
<Dialog
	bind:isOpen={showRemoveConfirm}
	onClose={() => { showRemoveConfirm = false; userToRemove = null; }}
	title="Remove User"
	type="warning"
	message={`Remove "${userToRemove?.name || ''}" from the team? Their sessions will be terminated immediately.`}
	confirmText="Remove"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={removeUser}
/>

{#if userForProjects}
	<UserProjectsModal
		bind:isOpen={showProjectsModal}
		userId={userForProjects.id}
		userName={userForProjects.name}
		onClose={closeProjectsModal}
	/>
{/if}
{/if}

<script lang="ts">
	import { userStore } from '$frontend/lib/stores/features/user.svelte';
	import { addNotification } from '$frontend/lib/stores/ui/notification.svelte';
	import Icon from '../../common/Icon.svelte';
	import { debug } from '$shared/utils/logger';

	// State
	let userNameInput = $state('');
	let isEditing = $state(false);
	let isSaving = $state(false);

	// Update input when user changes
	$effect(() => {
		if (userStore.currentUser?.name) {
			userNameInput = userStore.currentUser.name;
		}
	});

	// Handle save user name
	async function saveUserName() {
		if (!userNameInput.trim()) {
			addNotification({
				type: 'error',
				title: 'Validation Error',
				message: 'Name cannot be empty'
			});
			return;
		}

		isSaving = true;

		try {
			const success = await userStore.updateName(userNameInput.trim());

			if (success) {
				isEditing = false;
				addNotification({
					type: 'success',
					title: 'Updated',
					message: 'Display name updated successfully'
				});
			} else {
				addNotification({
					type: 'error',
					title: 'Error',
					message: 'Failed to update user name'
				});
			}
		} catch (error) {
			debug.error('settings', 'Error updating user name:', error);
			addNotification({
				type: 'error',
				title: 'Error',
				message: 'An error occurred while updating user name'
			});
		} finally {
			isSaving = false;
		}
	}

	// Handle cancel edit
	function cancelEdit() {
		userNameInput = userStore.currentUser?.name || '';
		isEditing = false;
	}

	// Handle start edit
	function startEdit() {
		isEditing = true;
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">User Profile</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Manage your identity and display preferences
	</p>

	{#if !userStore.currentUser}
		<div class="flex items-center justify-center gap-3 py-10 text-slate-600 dark:text-slate-500 text-sm">
			<div
				class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"
			></div>
			<span>Loading user settings...</span>
		</div>
	{:else}
		<div class="flex flex-col gap-4">
			<!-- Current User Card -->
			<div
				class="flex items-center gap-3.5 p-4.5 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/10 dark:to-purple-500/8 border border-violet-500/20 rounded-xl"
			>
				<div
					class="flex items-center justify-center w-12 h-12 rounded-xl text-lg font-bold text-white shrink-0"
					style="background-color: {userStore.currentUser?.color || '#7c3aed'}"
				>
					{userStore.currentUser?.avatar || 'U'}
				</div>
				<div class="flex-1 min-w-0">
					<div class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-0.5">
						{userStore.currentUser?.name || 'Anonymous User'}
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">Anonymous user identity</div>
				</div>
				<div
					class="flex items-center gap-1.5 py-1.5 px-3 bg-emerald-500/15 rounded-full text-xs font-medium text-emerald-500"
				>
					<span class="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
					<span>Active</span>
				</div>
			</div>

			<!-- Edit Display Name -->
			<div
				class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl"
			>
				<div
					class="flex items-center gap-2 text-sm font-semibold text-slate-500 mb-3"
				>
					<Icon name="lucide:pencil" class="w-4 h-4 opacity-70" />
					<span>Display Name</span>
				</div>

				{#if isEditing}
					<div class="flex flex-col gap-3">
						<input
							type="text"
							bind:value={userNameInput}
							placeholder="Enter your display name"
							class="w-full py-3 px-3.5 bg-slate-50 dark:bg-slate-900/80 border border-violet-500/20 rounded-lg text-slate-900 dark:text-slate-100 text-sm outline-none transition-all duration-150 placeholder:text-slate-600 dark:placeholder:text-slate-500 focus:border-violet-600 focus:shadow-[0_0_0_3px_rgba(124,58,237,0.1)]"
						/>
						<div class="flex gap-2.5">
							<button
								type="button"
								class="flex items-center justify-center gap-1.5 py-2.5 px-4 border-none rounded-lg text-sm font-semibold cursor-pointer transition-all duration-150 bg-gradient-to-br from-violet-600 to-purple-600 text-white hover:shadow-violet-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
								onclick={saveUserName}
								disabled={!userNameInput.trim() || isSaving}
							>
								{#if isSaving}
									<div
										class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"
									></div>
									Saving...
								{:else}
									<Icon name="lucide:check" class="w-4 h-4" />
									Save
								{/if}
							</button>
							<button
								type="button"
								class="flex items-center justify-center gap-1.5 py-2.5 px-4 border-none rounded-lg text-sm font-semibold cursor-pointer transition-all duration-150 bg-slate-100 dark:bg-slate-600/20 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-600/30 disabled:opacity-50 disabled:cursor-not-allowed"
								onclick={cancelEdit}
								disabled={isSaving}
							>
								Cancel
							</button>
						</div>
					</div>
				{:else}
					<div class="flex items-center justify-between gap-3">
						<div class="text-sm text-slate-900 dark:text-slate-100">
							{userStore.currentUser?.name || 'Not set'}
						</div>
						<button
							type="button"
							class="flex items-center gap-1.5 py-2 px-3.5 bg-transparent border border-violet-500/20 dark:border-violet-500/30 rounded-lg text-sm font-semibold text-violet-600 dark:text-violet-400 cursor-pointer transition-all duration-150 hover:bg-violet-500/10"
							onclick={startEdit}
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
							Edit
						</button>
					</div>
				{/if}
			</div>

			<!-- User ID -->
			<div
				class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl"
			>
				<div
					class="flex items-center gap-2 text-sm font-semibold text-slate-500 mb-3"
				>
					<Icon name="lucide:fingerprint" class="w-4 h-4 opacity-70" />
					<span>User ID</span>
				</div>
				<div class="flex flex-col gap-1.5">
					<code
						class="py-2.5 px-3.5 bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-lg font-mono text-xs text-slate-500 break-all"
						>{userStore.currentUser?.id || 'Not available'}</code
					>
					<span class="text-xs text-slate-600 dark:text-slate-500"
						>Unique identifier for this session</span
					>
				</div>
			</div>
		</div>
	{/if}
</div>

<script lang="ts">
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { systemSettings } from '$frontend/stores/features/settings.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import Icon from '../../common/display/Icon.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import { debug } from '$shared/utils/logger';

	const isNoAuth = $derived(systemSettings.authMode === 'none');

	// State
	let userNameInput = $state('');
	let isEditing = $state(false);
	let isSaving = $state(false);

	// PAT state
	let showPAT = $state(false);
	let currentPAT = $state('');
	let isRegeneratingPAT = $state(false);
	let showRegenerateConfirm = $state(false);

	const user = $derived(authStore.currentUser);

	// Update input when user changes
	$effect(() => {
		if (user?.name) {
			userNameInput = user.name;
		}
	});

	async function saveUserName() {
		if (!userNameInput.trim()) {
			addNotification({ type: 'error', title: 'Validation Error', message: 'Name cannot be empty' });
			return;
		}

		isSaving = true;
		try {
			await authStore.updateName(userNameInput.trim());
			isEditing = false;
			addNotification({ type: 'success', title: 'Updated', message: 'Display name updated' });
		} catch (error) {
			debug.error('settings', 'Error updating user name:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to update display name' });
		} finally {
			isSaving = false;
		}
	}

	function cancelEdit() {
		userNameInput = user?.name || '';
		isEditing = false;
	}

	function startEdit() {
		isEditing = true;
	}

	async function regeneratePAT() {
		isRegeneratingPAT = true;
		try {
			const pat = await authStore.regeneratePAT();
			currentPAT = pat;
			showPAT = true;
			showRegenerateConfirm = false;
			addNotification({ type: 'success', title: 'Regenerated', message: 'Personal Access Token has been regenerated' });
		} catch (error) {
			debug.error('settings', 'Error regenerating PAT:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to regenerate token' });
		} finally {
			isRegeneratingPAT = false;
		}
	}

	function copyPAT() {
		navigator.clipboard.writeText(currentPAT);
		addNotification({ type: 'success', title: 'Copied', message: 'Token copied to clipboard' });
	}

	async function handleLogout() {
		await authStore.logout();
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">User Profile</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Manage your identity and access
	</p>

	{#if !user}
		<div class="flex items-center justify-center gap-3 py-10 text-slate-600 dark:text-slate-500 text-sm">
			<div class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Loading user settings...</span>
		</div>
	{:else}
		<div class="flex flex-col gap-4">
			<!-- Current User Card -->
			<div class="flex items-center gap-3.5 p-4.5 bg-gradient-to-br from-violet-500/10 to-purple-500/5 dark:from-violet-500/10 dark:to-purple-500/8 border border-violet-500/20 rounded-xl">
				<div
					class="flex items-center justify-center w-12 h-12 rounded-xl text-lg font-bold text-white shrink-0"
					style="background-color: {user.color || '#7c3aed'}"
				>
					{user.avatar || 'U'}
				</div>
				<div class="flex-1 min-w-0">
					<div class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-0.5">
						{user.name}
					</div>
					<div class="text-xs text-slate-600 dark:text-slate-500">
						Owner of this Clopen
					</div>
				</div>
			</div>

			<!-- Edit Display Name -->
			<div class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
				<div class="flex items-center gap-2 text-sm font-semibold text-slate-500 mb-3">
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
									<div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
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
							{user.name}
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

			{#if !isNoAuth}
				<!-- Personal Access Token -->
				<div class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
					<div class="flex items-center gap-2 text-sm font-semibold text-slate-500 mb-3">
						<Icon name="lucide:key-round" class="w-4 h-4 opacity-70" />
						<span>Personal Access Token</span>
					</div>
					<p class="text-xs text-slate-600 dark:text-slate-500 mb-3">
						Use this token to log in from other devices. Keep it secret.
					</p>

					{#if showPAT && currentPAT}
						<div class="flex flex-col gap-2 mb-3">
							<div class="flex items-center gap-2">
								<code class="flex-1 py-2.5 px-3.5 bg-slate-50 dark:bg-slate-900/80 border border-emerald-500/30 rounded-lg font-mono text-xs text-slate-700 dark:text-slate-300 break-all">
									{currentPAT}
								</code>
								<button
									type="button"
									onclick={copyPAT}
									class="flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 transition-all"
									title="Copy token"
								>
									<Icon name="lucide:copy" class="w-4 h-4" />
								</button>
							</div>
							<div class="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
								<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
								<span>This token is shown only once. Copy and store it securely.</span>
							</div>
						</div>
					{/if}

					<button
						type="button"
						onclick={() => { showRegenerateConfirm = true; }}
						disabled={isRegeneratingPAT}
						class="inline-flex items-center gap-1.5 py-2 px-3.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-600 dark:text-amber-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{#if isRegeneratingPAT}
							<div class="w-3.5 h-3.5 border-2 border-amber-600/30 border-t-amber-600 rounded-full animate-spin"></div>
							Regenerating...
						{:else}
							<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
							Regenerate Token
						{/if}
					</button>
				</div>
			{/if}

			<!-- User ID -->
			<div class="p-4 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
				<div class="flex items-center gap-2 text-sm font-semibold text-slate-500 mb-3">
					<Icon name="lucide:fingerprint" class="w-4 h-4 opacity-70" />
					<span>User ID</span>
				</div>
				<div class="flex flex-col gap-1.5">
					<code class="py-2.5 px-3.5 bg-slate-50 dark:bg-slate-900/80 border border-slate-200 dark:border-slate-800 rounded-lg font-mono text-xs text-slate-500 break-all">
						{user.id}
					</code>
				</div>
			</div>

			{#if !isNoAuth}
				<!-- Logout -->
				<div class="pt-2">
					<button
						type="button"
						onclick={handleLogout}
						class="inline-flex items-center gap-1.5 py-2.5 px-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-600 dark:text-red-400 text-sm font-semibold cursor-pointer transition-all duration-150 hover:bg-red-500/20 hover:border-red-600/40"
					>
						<Icon name="lucide:log-out" class="w-4 h-4" />
						Sign Out
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Regenerate PAT Confirmation Dialog -->
<Dialog
	bind:isOpen={showRegenerateConfirm}
	onClose={() => { showRegenerateConfirm = false; }}
	title="Regenerate Access Token"
	type="warning"
	message="This will invalidate your current Personal Access Token. Any devices using the old token will need to log in again with the new one. Continue?"
	confirmText="Regenerate"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={regeneratePAT}
/>

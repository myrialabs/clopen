<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbRbacState,
		loadPermissions,
		grantPermission,
		revokePermission
	} from '$frontend/stores/features/db-rbac.svelte';
	import {
		DB_CONNECTION_ROLE_LABELS,
		DB_CONNECTION_ROLE_DESCRIPTIONS,
		type DBConnectionRole
	} from '$shared/types/db-rbac';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
		connectionId: string;
		connectionName: string;
	}

	const { isOpen, onClose, connectionId, connectionName }: Props = $props();

	let selectedUserId = $state('');
	let selectedRole = $state<DBConnectionRole>('viewer');

	$effect(() => {
		if (isOpen && connectionId) {
			loadPermissions(connectionId);
			selectedUserId = '';
			selectedRole = 'viewer';
		}
	});

	const grantableUsers = $derived(
		dbRbacState.availableUsers.filter(
			(u) => !dbRbacState.permissions.some((p) => p.userId === u.id)
		)
	);

	async function handleGrant() {
		if (!selectedUserId) return;
		await grantPermission(connectionId, selectedUserId, selectedRole);
		selectedUserId = '';
	}

	async function handleRevoke(userId: string) {
		await revokePermission(connectionId, userId);
	}

	async function handleRoleChange(userId: string, newRole: DBConnectionRole) {
		await grantPermission(connectionId, userId, newRole);
	}

	const roleOptions: DBConnectionRole[] = ['owner', 'developer', 'viewer'];
</script>

<Modal {isOpen} {onClose} title="Manage Permissions — {connectionName}" size="lg">
	<div class="flex flex-col gap-5 p-1">
		<!-- Current permissions -->
		<section>
			<h3 class="mb-3 text-sm font-semibold text-neutral-300">Current Access</h3>

			{#if dbRbacState.isLoadingPermissions}
				<p class="text-sm text-neutral-500">Loading…</p>
			{:else if dbRbacState.permissions.length === 0}
				<p class="text-sm text-neutral-500">No explicit permissions set. App admins always have Owner access.</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each dbRbacState.permissions as perm (perm.userId)}
						<li class="flex items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2">
							<!-- Avatar -->
							<div
								class="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
								style="background-color: {perm.userColor ?? '#555'}"
							>
								{perm.userAvatar ?? perm.userName?.charAt(0).toUpperCase() ?? '?'}
							</div>

							<!-- Name -->
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium text-neutral-100">{perm.userName ?? perm.userId}</p>
								<p class="text-xs text-neutral-500">
									{DB_CONNECTION_ROLE_DESCRIPTIONS[perm.role]}
								</p>
							</div>

							<!-- Role selector -->
							<select
								class="rounded border border-neutral-600 bg-neutral-700 px-2 py-1 text-xs text-neutral-100 focus:border-blue-500 focus:outline-none"
								value={perm.role}
								disabled={dbRbacState.isSavingPermission}
								onchange={(e) => handleRoleChange(perm.userId, (e.target as HTMLSelectElement).value as DBConnectionRole)}
							>
								{#each roleOptions as role}
									<option value={role}>{DB_CONNECTION_ROLE_LABELS[role]}</option>
								{/each}
							</select>

							<!-- Revoke -->
							<button
								class="shrink-0 rounded p-1 text-neutral-500 transition hover:bg-neutral-700 hover:text-red-400 disabled:opacity-40"
								disabled={dbRbacState.isSavingPermission}
								onclick={() => handleRevoke(perm.userId)}
								title="Revoke access"
							>
								<Icon name="lucide:x" class="w-3.5 h-3.5" />
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!-- Grant new permission -->
		<section class="border-t border-neutral-700 pt-4">
			<h3 class="mb-3 text-sm font-semibold text-neutral-300">Grant Access</h3>

			{#if grantableUsers.length === 0}
				<p class="text-sm text-neutral-500">All users already have access.</p>
			{:else}
				<div class="flex flex-wrap items-end gap-3">
					<div class="flex min-w-0 flex-1 flex-col gap-1">
						<label class="text-xs text-neutral-400" for="perm-user-select">User</label>
						<select
							id="perm-user-select"
							class="rounded border border-neutral-600 bg-neutral-700 px-2 py-1.5 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none"
							bind:value={selectedUserId}
						>
							<option value="">Select a user…</option>
							{#each grantableUsers as user}
								<option value={user.id}>{user.name} ({user.role})</option>
							{/each}
						</select>
					</div>

					<div class="flex flex-col gap-1">
						<label class="text-xs text-neutral-400" for="perm-role-select">Role</label>
						<select
							id="perm-role-select"
							class="rounded border border-neutral-600 bg-neutral-700 px-2 py-1.5 text-sm text-neutral-100 focus:border-blue-500 focus:outline-none"
							bind:value={selectedRole}
						>
							{#each roleOptions as role}
								<option value={role}>{DB_CONNECTION_ROLE_LABELS[role]}</option>
							{/each}
						</select>
					</div>

					<button
						class="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
						disabled={!selectedUserId || dbRbacState.isSavingPermission}
						onclick={handleGrant}
					>
						Grant
					</button>
				</div>

				<!-- Role description tooltip -->
				{#if selectedRole}
					<p class="mt-2 text-xs text-neutral-500">{DB_CONNECTION_ROLE_DESCRIPTIONS[selectedRole]}</p>
				{/if}
			{/if}
		</section>

		<!-- Role legend -->
		<section class="rounded-lg border border-neutral-700 bg-neutral-800/50 p-3">
			<h4 class="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Role Reference</h4>
			<ul class="flex flex-col gap-1.5">
				{#each roleOptions as role}
					<li class="flex items-start gap-2">
						<span class="mt-0.5 rounded bg-neutral-700 px-1.5 py-0.5 text-xs font-medium text-neutral-200">
							{DB_CONNECTION_ROLE_LABELS[role]}
						</span>
						<span class="text-xs text-neutral-400">{DB_CONNECTION_ROLE_DESCRIPTIONS[role]}</span>
					</li>
				{/each}
			</ul>
		</section>
	</div>
</Modal>

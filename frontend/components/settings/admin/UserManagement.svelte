<script lang="ts">
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { settingsModalState, clearTeamFocus } from '$frontend/stores/ui/settings-modal.svelte';
	import { parseUserAgent, sessionSourceLabel } from '$frontend/utils/user-agent';
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

	interface SessionInfo {
		id: string;
		lastActiveAt: string;
		current: boolean;
		online: boolean;
		userAgent: string | null;
		ipAddress: string | null;
		source: string | null;
		userId: string;
	}

	let users = $state<User[]>([]);
	let loading = $state(true);

	// Every device across the team, grouped by owner — devices live *under* the
	// person here (no separate flat list) so "who" and "their devices" is one view.
	let sessionsByUser = $state<Map<string, SessionInfo[]>>(new Map());
	// Members with zero project access → surfaces an "Assign projects" nudge.
	let projectCount = $state<Map<string, number>>(new Map());
	let expanded = $state<Set<string>>(new Set());

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

	function toggleExpanded(userId: string) {
		const next = new Set(expanded);
		if (next.has(userId)) next.delete(userId); else next.add(userId);
		expanded = next;
	}

	async function loadUsers() {
		try {
			users = await ws.http('auth:list-users', {});
		} catch (error) {
			debug.error('settings', 'Failed to load users:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to load users' });
		}
	}

	async function loadSessions() {
		try {
			const all = await ws.http('auth:list-all-sessions', {});
			const map = new Map<string, SessionInfo[]>();
			for (const s of all) {
				const list = map.get(s.userId) ?? [];
				list.push(s);
				map.set(s.userId, list);
			}
			sessionsByUser = map;
		} catch (error) {
			debug.error('settings', 'Failed to load sessions:', error);
		}
	}

	async function loadProjectCounts() {
		// Only members can have project assignments; admins see everything.
		const members = users.filter((u) => u.role !== 'admin');
		const entries = await Promise.all(
			members.map(async (u) => {
				try {
					const projects = await ws.http('auth:list-user-projects', { userId: u.id });
					return [u.id, Array.isArray(projects) ? projects.length : 0] as const;
				} catch {
					return [u.id, 0] as const;
				}
			})
		);
		projectCount = new Map(entries);
	}

	async function reloadAll() {
		loading = true;
		await loadUsers();
		await Promise.all([loadSessions(), loadProjectCounts()]);
		loading = false;
	}

	function confirmRemove(user: User) {
		userToRemove = user;
		showRemoveConfirm = true;
	}

	async function removeUser() {
		const target = userToRemove;
		if (!target) return;
		try {
			await ws.http('auth:remove-user', { userId: target.id });
			addNotification({ type: 'success', title: 'Removed', message: `${target.name} has been removed` });
			await reloadAll();
		} catch (error) {
			debug.error('settings', 'Failed to remove user:', error);
			addNotification({ type: 'error', title: 'Error', message: error instanceof Error ? error.message : 'Failed to remove user' });
		}
	}

	async function revokeDevice(sessionId: string) {
		try {
			await ws.http('auth:revoke-any-session', { id: sessionId });
			addNotification({ type: 'success', title: 'Signed out', message: 'Device session revoked' });
			await loadSessions();
		} catch (error) {
			debug.error('settings', 'Failed to revoke session:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to revoke session' });
		}
	}

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
		} catch {
			return iso;
		}
	}

	// Load on mount + keep in sync with backend events (users + device presence).
	$effect(() => {
		if (!authStore.isAdmin) return;
		reloadAll();
		const offUsers = ws.on('auth:users-changed', () => reloadAll());
		const offRemote = ws.on('remote-access:changed', () => loadSessions());
		return () => { offUsers(); offRemote(); };
	});

	// Deep-link from the "new member joined" nudge / invite flow: auto-open the
	// target member's project modal once the user list has loaded.
	$effect(() => {
		const focusId = settingsModalState.teamFocusUserId;
		if (!focusId || loading) return;
		const user = users.find((u) => u.id === focusId);
		if (user) {
			openProjectsModal(user);
			clearTeamFocus();
		}
	});
</script>

{#if authStore.isAdmin}
<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Members</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">People who can use this Clopen, their project access, and their signed-in devices.</p>

	{#if loading}
		<div class="flex items-center justify-center gap-3 py-8 text-slate-600 dark:text-slate-500 text-sm">
			<div class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Loading members...</span>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each users as user (user.id)}
				{@const sessions = sessionsByUser.get(user.id) ?? []}
				{@const onlineCount = sessions.filter((s) => s.online).length}
				{@const isMember = user.role !== 'admin'}
				{@const noProjects = isMember && (projectCount.get(user.id) ?? 0) === 0}
				{@const isExpanded = expanded.has(user.id)}
				<div class="bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
					<div class="flex items-center gap-3 p-3.5">
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
							<div class="text-xs text-slate-500 flex items-center gap-1.5 flex-wrap">
								<span>{user.role === 'admin' ? 'Administrator' : 'Member'}</span>
								<span class="text-slate-300 dark:text-slate-600">·</span>
								<span>Joined {new Date(user.createdAt).toLocaleDateString()}</span>
								{#if sessions.length > 0}
									<span class="text-slate-300 dark:text-slate-600">·</span>
									<span class="inline-flex items-center gap-1">
										<span class="w-1.5 h-1.5 rounded-full {onlineCount > 0 ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'}"></span>
										{onlineCount > 0 ? `${onlineCount} online` : `${sessions.length} device${sessions.length > 1 ? 's' : ''}`}
									</span>
								{/if}
							</div>
						</div>

						{#if noProjects}
							<button
								type="button"
								onclick={() => openProjectsModal(user)}
								class="inline-flex items-center gap-1 py-1 px-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-400 text-2xs font-semibold hover:bg-amber-500/20 transition-all shrink-0"
								title="This member has no project access yet"
							>
								<Icon name="lucide:folder-plus" class="w-3.5 h-3.5" />
								Assign projects
							</button>
						{/if}

						<span class="inline-flex items-center gap-1 py-1 px-2.5 rounded-full text-2xs font-semibold
							{user.role === 'admin' ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400' : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-400'}">
							<Icon name="lucide:{user.role === 'admin' ? 'shield' : 'user'}" class="w-3 h-3" />
							{user.role === 'admin' ? 'Admin' : 'Member'}
						</span>

						{#if sessions.length > 0}
							<button
								type="button"
								onclick={() => toggleExpanded(user.id)}
								class="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-all shrink-0"
								title="Show devices"
								aria-label="Show devices for {user.name}"
							>
								<Icon name={isExpanded ? 'lucide:chevron-up' : 'lucide:monitor-smartphone'} class="w-4 h-4" />
							</button>
						{/if}

						{#if isMember}
							<button
								type="button"
								onclick={() => openProjectsModal(user)}
								class="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 transition-all shrink-0"
								title="Manage projects"
								aria-label="Manage projects for {user.name}"
							>
								<Icon name="lucide:folder-cog" class="w-4 h-4" />
							</button>
						{/if}
						{#if isMember && user.id !== authStore.currentUser?.id}
							<button
								type="button"
								onclick={() => confirmRemove(user)}
								class="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0"
								title="Remove user"
							>
								<Icon name="lucide:user-minus" class="w-4 h-4" />
							</button>
						{/if}
					</div>

					{#if isExpanded && sessions.length > 0}
						<div class="flex flex-col gap-1.5 px-3.5 pb-3 pt-0.5">
							{#each sessions as session (session.id)}
								{@const ua = parseUserAgent(session.userAgent)}
								{@const src = sessionSourceLabel(session.source)}
								<div class="flex items-center gap-2.5 px-3 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg">
									<div class="relative shrink-0">
										<Icon name={ua.icon} class="w-4 h-4 text-slate-400" />
										<span class="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-white dark:border-slate-900 {session.online ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'}"></span>
									</div>
									<div class="flex-1 min-w-0">
										<div class="flex items-center gap-1.5 flex-wrap">
											<span class="text-xs font-medium text-slate-700 dark:text-slate-300">{ua.label}</span>
											{#if session.current}
												<span class="text-2xs px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 font-medium">This device</span>
											{/if}
										</div>
										<div class="text-2xs text-slate-400 dark:text-slate-500 flex items-center gap-1.5 flex-wrap">
											{#if src}<span>{src}</span><span class="text-slate-300 dark:text-slate-600">·</span>{/if}
											<span>Active {formatDate(session.lastActiveAt)}</span>
											{#if session.ipAddress}<span class="text-slate-300 dark:text-slate-600">·</span><span class="font-mono">{session.ipAddress}</span>{/if}
										</div>
									</div>
									{#if !session.current}
										<button
											type="button"
											onclick={() => revokeDevice(session.id)}
											class="flex items-center justify-center w-7 h-7 rounded-md hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0"
											title="Sign out this device"
										>
											<Icon name="lucide:log-out" class="w-3.5 h-3.5" />
										</button>
									{/if}
								</div>
							{/each}
						</div>
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

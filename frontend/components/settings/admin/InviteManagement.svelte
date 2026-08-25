<script lang="ts">
	import { onMount } from 'svelte';
	import { authStore } from '$frontend/stores/features/auth.svelte';
	import { remoteAccessStore } from '$frontend/stores/features/remote-access.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { Project } from '$shared/types/database/schema';
	import Icon from '../../common/display/Icon.svelte';
	import Dialog from '../../common/overlay/Dialog.svelte';
	import TunnelQRCode from '$frontend/components/tunnel/TunnelQRCode.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	// Tick drives the live countdown and drops each invite the instant it lapses.
	let tick = $state(0);

	// Backed by the Remote Access store so invites here and from the sidebar's
	// "Add a device" flow share the same list + URLs.
	const visibleInvites = $derived.by(() => {
		void tick;
		return remoteAccessStore.activeInvites;
	});

	function formatCountdown(expiresAt: string | null): string | null {
		void tick;
		if (!expiresAt) return null;
		const ms = new Date(expiresAt).getTime() - Date.now();
		if (ms <= 0) return '0:00';
		const total = Math.ceil(ms / 1000);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
	}

	// Which invite's QR is currently expanded (one at a time).
	let qrShownId = $state<string | null>(null);

	let loading = $state(true);
	let isCreating = $state(false);

	// Projects for the pre-assignment picker (so a new member has access on join).
	let projects = $state<Project[]>([]);
	const projectName = $derived.by(() => {
		const map = new Map<string, string>();
		for (const p of projects) if (p.id) map.set(p.id, p.name);
		return map;
	});

	let showPicker = $state(false);
	let selectedProjectIds = $state<Set<string>>(new Set());
	let projectSearch = $state('');
	const filteredProjects = $derived.by(() => {
		const q = projectSearch.trim().toLowerCase();
		if (!q) return projects;
		return projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
	});

	function toggleProject(id: string) {
		const next = new Set(selectedProjectIds);
		if (next.has(id)) next.delete(id); else next.add(id);
		selectedProjectIds = next;
	}

	function grantedProjectNames(invite: { project_ids: string | null }): string[] {
		if (!invite.project_ids) return [];
		try {
			const ids: string[] = JSON.parse(invite.project_ids);
			return ids.map((id) => projectName.get(id) ?? 'Unknown project');
		} catch {
			return [];
		}
	}

	// Per-invite copy feedback
	let copiedId = $state<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;

	// Revoke state
	let showRevokeConfirm = $state(false);
	let inviteToRevoke = $state<{ id: string } | null>(null);

	async function generateInvite() {
		isCreating = true;
		try {
			await remoteAccessStore.createInvite([...selectedProjectIds]);
			selectedProjectIds = new Set();
			showPicker = false;
			addNotification({ type: 'success', title: 'Created', message: 'Invite link created' });
		} catch (error) {
			debug.error('auth', 'Failed to create invite:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to create invite' });
		} finally {
			isCreating = false;
		}
	}

	function copyInviteURL(inviteId: string) {
		const url = remoteAccessStore.inviteURL(inviteId);
		if (!url) return;
		navigator.clipboard.writeText(url);
		copiedId = inviteId;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => { copiedId = null; }, 2000);
	}

	function confirmRevoke(invite: { id: string }) {
		inviteToRevoke = invite;
		showRevokeConfirm = true;
	}

	async function revokeInvite() {
		if (!inviteToRevoke) return;
		try {
			await remoteAccessStore.revokeInvite(inviteToRevoke.id);
			addNotification({ type: 'success', title: 'Revoked', message: 'Invite link has been revoked' });
		} catch (error) {
			debug.error('auth', 'Failed to revoke invite:', error);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to revoke invite' });
		} finally {
			showRevokeConfirm = false;
			inviteToRevoke = null;
		}
	}

	async function loadProjects() {
		try {
			const list = await ws.http('projects:list', {});
			projects = Array.isArray(list) ? list : [];
		} catch (error) {
			debug.error('auth', 'Failed to load projects:', error);
		}
	}

	onMount(() => {
		if (!authStore.isAdmin) return;
		Promise.all([remoteAccessStore.loadInvites(), loadProjects()]).finally(() => { loading = false; });
		const id = setInterval(() => { tick++; }, 1000);
		return () => clearInterval(id);
	});
</script>

{#if authStore.isAdmin}
<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Invite members</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		Single-use link to add a member. Optionally pre-pick their projects.
	</p>

	{#if loading}
		<div class="flex items-center justify-center gap-3 py-8 text-slate-600 dark:text-slate-500 text-sm">
			<div class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
			<span>Loading...</span>
		</div>
	{:else}
		<div class="flex flex-col gap-2">
			{#each visibleInvites as invite (invite.id)}
				{@const url = remoteAccessStore.inviteURL(invite.id)}
				{@const granted = grantedProjectNames(invite)}
				{@const remaining = formatCountdown(invite.expires_at)}
				<div class="flex flex-col gap-2 px-3 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg">
					<div class="flex items-center gap-2">
						<div class="flex-1 min-w-0 font-mono text-xs text-slate-600 dark:text-slate-400 truncate select-all">
							{url ?? 'Link created on another device'}
						</div>
						{#if url}
							<button
								type="button"
								onclick={() => copyInviteURL(invite.id)}
								class="flex items-center justify-center w-7 h-7 rounded-md transition-all shrink-0
									{copiedId === invite.id
									? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
									: 'hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400'}"
								title="Copy link"
							>
								<Icon name={copiedId === invite.id ? 'lucide:check' : 'lucide:copy'} class="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								onclick={() => (qrShownId = qrShownId === invite.id ? null : invite.id)}
								class="flex items-center justify-center w-7 h-7 rounded-md transition-all shrink-0
									{qrShownId === invite.id
									? 'bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'
									: 'hover:bg-violet-100 dark:hover:bg-violet-900/30 text-slate-400 hover:text-violet-600 dark:hover:text-violet-400'}"
								title={qrShownId === invite.id ? 'Hide QR code' : 'Show QR code'}
							>
								<Icon name="lucide:qr-code" class="w-3.5 h-3.5" />
							</button>
						{/if}
						<button
							type="button"
							onclick={() => confirmRevoke(invite)}
							class="flex items-center justify-center w-7 h-7 rounded-md hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-all shrink-0"
							title="Revoke invite"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>
					<div class="flex items-center gap-1.5 flex-wrap text-2xs text-slate-500 dark:text-slate-400">
						<Icon name="lucide:folder" class="w-3 h-3" />
						{#if granted.length}
							<span>Grants access to</span>
							{#each granted as name}
								<span class="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 font-medium">{name}</span>
							{/each}
						{:else}
							<span>No projects pre-assigned — set access after they join</span>
						{/if}
						{#if remaining}
							<span class="text-slate-300 dark:text-slate-600">·</span>
							<Icon name="lucide:timer" class="w-3 h-3" />
							<span>Expires in <span class="font-mono tabular-nums">{remaining}</span></span>
						{/if}
					</div>
					{#if url && qrShownId === invite.id}
						<div class="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
							<TunnelQRCode value={url} />
							<p class="text-center text-xs text-slate-500 dark:text-slate-400 mt-1">Scan with the other device's camera</p>
						</div>
					{/if}
				</div>
			{/each}

			<!-- Optional project picker -->
			{#if projects.length > 0}
				<button
					type="button"
					onclick={() => (showPicker = !showPicker)}
					class="inline-flex items-center gap-1.5 mt-1 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors self-start"
				>
					<Icon name={showPicker ? 'lucide:chevron-down' : 'lucide:chevron-right'} class="w-3.5 h-3.5" />
					Grant project access
					{#if selectedProjectIds.size > 0}
						<span class="px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-600 dark:text-violet-400 font-semibold">{selectedProjectIds.size}</span>
					{/if}
				</button>
				{#if showPicker}
					<div class="flex flex-col gap-1.5 p-1.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg">
						<div class="flex items-center gap-2 px-2 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md">
							<Icon name="lucide:search" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
							<input
								type="text"
								bind:value={projectSearch}
								placeholder="Search projects..."
								class="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-400"
							/>
							{#if projectSearch}
								<button type="button" onclick={() => (projectSearch = '')} class="flex text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 shrink-0" aria-label="Clear search">
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							{/if}
						</div>
						<div class="flex flex-col gap-1 max-h-44 overflow-y-auto">
							{#each filteredProjects as project (project.id)}
								{@const checked = !!project.id && selectedProjectIds.has(project.id)}
								<button
									type="button"
									onclick={() => project.id && toggleProject(project.id)}
									class="flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left transition-colors
										{checked ? 'bg-violet-50 dark:bg-violet-900/10' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}"
								>
									<div class="flex items-center justify-center w-4 h-4 rounded border shrink-0
										{checked ? 'bg-violet-600 border-violet-600 text-white' : 'bg-white dark:bg-slate-900 border-slate-300 dark:border-slate-600'}">
										{#if checked}<Icon name="lucide:check" class="w-3 h-3" />{/if}
									</div>
									<div class="min-w-0">
										<div class="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">{project.name}</div>
										<div class="text-2xs text-slate-500 dark:text-slate-400 truncate font-mono">{project.path}</div>
									</div>
								</button>
							{:else}
								<p class="text-2xs text-slate-500 dark:text-slate-400 px-2 py-2 text-center">No projects match your search.</p>
							{/each}
						</div>
					</div>
				{/if}
			{/if}

			<button
				type="button"
				onclick={generateInvite}
				disabled={isCreating}
				class="inline-flex items-center gap-1.5 py-2 px-3.5 mt-1 bg-violet-500/10 dark:bg-violet-500/10 border border-violet-500/20 dark:border-violet-500/25 rounded-lg text-violet-600 dark:text-violet-400 text-xs font-semibold cursor-pointer transition-all duration-150 hover:bg-violet-500/20 hover:border-violet-600/40 self-start disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{#if isCreating}
					<div class="w-3.5 h-3.5 border-2 border-violet-600/30 border-t-violet-600 rounded-full animate-spin"></div>
					Generating...
				{:else}
					<Icon name="lucide:plus" class="w-3.5 h-3.5" />
					Generate Invite Link
				{/if}
			</button>
		</div>
	{/if}
</div>

<Dialog
	bind:isOpen={showRevokeConfirm}
	onClose={() => { showRevokeConfirm = false; inviteToRevoke = null; }}
	title="Revoke Invite"
	type="warning"
	message="Revoke this invite? Anyone with this link will no longer be able to join."
	confirmText="Revoke"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={revokeInvite}
/>
{/if}

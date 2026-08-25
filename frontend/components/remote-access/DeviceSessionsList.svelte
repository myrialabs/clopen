<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import ws from '$frontend/utils/ws';
	import { parseUserAgent, sessionSourceLabel } from '$frontend/utils/user-agent';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';

	interface SessionInfo {
		id: string;
		createdAt: string;
		lastActiveAt: string;
		expiresAt: string;
		current: boolean;
		online: boolean;
		userAgent: string | null;
		ipAddress: string | null;
		source: string | null;
		// Present only in 'all' scope (admin, team-wide view).
		userId?: string;
		userName?: string;
		userColor?: string;
		userRole?: 'admin' | 'member';
	}

	interface Props {
		/** 'me' = the current user's own devices; 'all' = every device on the team (admin). */
		scope?: 'me' | 'all';
	}

	const { scope = 'me' }: Props = $props();

	let sessions = $state<SessionInfo[]>([]);
	let loading = $state(true);
	let showRevokeConfirm = $state(false);
	let sessionToRevoke = $state<SessionInfo | null>(null);

	async function load() {
		try {
			sessions = scope === 'all'
				? await ws.http('auth:list-all-sessions', {})
				: await ws.http('auth:list-sessions', {});
		} catch (err) {
			debug.error('remote-access', 'Failed to load sessions:', err);
		} finally {
			loading = false;
		}
	}

	function confirmRevoke(session: SessionInfo) {
		sessionToRevoke = session;
		showRevokeConfirm = true;
	}

	async function revokeSession() {
		if (!sessionToRevoke) return;
		const id = sessionToRevoke.id;
		try {
			if (scope === 'all') {
				await ws.http('auth:revoke-any-session', { id });
			} else {
				await ws.http('auth:revoke-session', { id });
			}
			sessions = sessions.filter((s) => s.id !== id);
			addNotification({ type: 'success', title: 'Signed out', message: 'Device session revoked' });
		} catch (err) {
			debug.error('remote-access', 'Failed to revoke session:', err);
			addNotification({ type: 'error', title: 'Error', message: 'Failed to revoke session' });
		} finally {
			showRevokeConfirm = false;
			sessionToRevoke = null;
		}
	}

	function formatDate(iso: string): string {
		try {
			return new Date(iso).toLocaleString(undefined, {
				month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
			});
		} catch {
			return iso;
		}
	}

	onMount(() => {
		load();
		// Refresh when devices/shares change elsewhere (a device connects/disconnects, etc.)
		const off = ws.on('remote-access:changed', () => load());
		return () => off();
	});
</script>

{#if loading}
	<div class="flex items-center justify-center gap-3 py-6 text-slate-600 dark:text-slate-500 text-sm">
		<div class="w-5 h-5 border-2 border-violet-500/20 border-t-violet-600 rounded-full animate-spin"></div>
		<span>Loading...</span>
	</div>
{:else if sessions.length === 0}
	<p class="text-xs text-slate-500 dark:text-slate-500 py-2">No connected devices.</p>
{:else}
	<div class="flex flex-col gap-2">
		{#each sessions as session (session.id)}
			{@const ua = parseUserAgent(session.userAgent)}
			{@const src = sessionSourceLabel(session.source)}
			<div class="flex items-center gap-3 px-3 py-2.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg">
				<div class="relative shrink-0">
					<Icon name={ua.icon} class="w-4.5 h-4.5 text-slate-400" />
					<span
						class="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border-2 border-white dark:border-slate-900 {session.online ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'}"
						title={session.online ? 'Online' : 'Offline'}
					></span>
				</div>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-2 flex-wrap">
						{#if scope === 'all' && session.userName}
							<span class="text-xs font-semibold text-slate-800 dark:text-slate-200">{session.userName}</span>
							<span class="text-2xs text-slate-400 dark:text-slate-500">·</span>
						{/if}
						<span class="text-xs {scope === 'all' ? 'text-slate-500 dark:text-slate-400' : 'font-semibold text-slate-800 dark:text-slate-200'}">{ua.label}</span>
						{#if session.current}
							<span class="text-2xs px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 font-medium">
								This device
							</span>
						{/if}
						{#if scope === 'all' && session.userRole === 'admin'}
							<span class="text-2xs px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 font-medium">
								Admin
							</span>
						{/if}
					</div>
					<div class="text-2xs text-slate-400 dark:text-slate-500 flex items-center gap-1.5 flex-wrap">
						{#if src}
							<span>{src}</span>
							<span class="text-slate-300 dark:text-slate-600">·</span>
						{/if}
						<span>Active {formatDate(session.lastActiveAt)}</span>
						{#if session.ipAddress}
							<span class="text-slate-300 dark:text-slate-600">·</span>
							<span class="font-mono">{session.ipAddress}</span>
						{/if}
					</div>
				</div>
				{#if !session.current}
					<button
						type="button"
						onclick={() => confirmRevoke(session)}
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

<Dialog
	bind:isOpen={showRevokeConfirm}
	onClose={() => { showRevokeConfirm = false; sessionToRevoke = null; }}
	title="Sign out device"
	type="warning"
	message="Sign out this device? It will lose access immediately and need a new link or token to sign in again."
	confirmText="Sign out"
	cancelText="Cancel"
	showCancel={true}
	onConfirm={revokeSession}
/>
